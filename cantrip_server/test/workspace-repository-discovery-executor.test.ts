import type {
  WorkerEvent,
  WorkspaceRepositoryDiscoveryJobSummary,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { RelayLimitError } from "../src/security/abuse-limits.js";
import { LimitedWorkerCommandBus } from "../src/workers/limited-command-bus.js";
import {
  WorkerCommandError,
  type WorkerCommandBus,
} from "../src/workers/bridge.js";
import { WorkspaceRepositoryDiscoveryJobExecutor } from "../src/workspace-repository-discovery/executor.js";

const now = "2026-09-02T12:00:00.000Z";
const pathHandle = `ctrr_${"a".repeat(43)}`;
const displayHandle = `ctrr_${"b".repeat(43)}`;
const originUrlHandle = `ctrr_${"d".repeat(43)}`;
const githubRepositoryIdHandle = `ctrr_${"e".repeat(43)}`;
const githubNameWithOwnerHandle = `ctrr_${"f".repeat(43)}`;
const githubUrlHandle = `ctrr_${"g".repeat(43)}`;

function job(): WorkspaceRepositoryDiscoveryJobSummary {
  return {
    id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
    workspaceId: "workspace-one",
    workerId: "worker-one",
    state: "running",
    stateRevision: 2,
    attempt: 1,
    depth: 3,
    diagnosticCode: null,
    truncated: false,
    counts: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };
}

const counts = {
  candidates: 1,
  collapsedRepositories: 0,
  rejectedRepositories: 0,
  scannedDirectories: 4,
  scannedEntries: 12,
  skippedSymlinks: 0,
  unreadableDirectories: 0,
};

describe("workspace repository discovery executor", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function limitedScanFixture(
    request: ReturnType<typeof vi.fn>,
    active = job(),
  ) {
    const complete = vi.fn().mockResolvedValue({
      job: { ...active, state: "succeeded", counts },
      candidates: [],
    });
    const fail = vi.fn().mockResolvedValue({
      ...active,
      state: "failed",
      error: { code: "discovery-failed", retryable: false },
    });
    const renewLease = vi.fn().mockResolvedValue(true);
    const repository = {
      getWorker: vi.fn().mockResolvedValue({
        managedFolders: { discoverWorkspaceRepositories: true },
      }),
      workspaceRepositoryDiscoveryJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            rootPathHandle: pathHandle,
            job: active,
          })
          .mockResolvedValue(null),
        claimNextImport: vi.fn().mockResolvedValue(null),
        complete,
        fail,
        renewLease,
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    return { active, repository, bridge, complete, fail, renewLease };
  }

  it.each(["account", "worker"])(
    "waits for the actual %s command-rate window before completing a rescan",
    async (limitedScope) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      const active = { ...job(), attempt: 2 };
      const request = vi.fn().mockResolvedValue({
        jobId: active.id,
        attempt: active.attempt,
        candidates: [],
        counts: { ...counts, candidates: 0 },
        diagnosticCode: null,
        truncated: false,
      });
      const fixture = limitedScanFixture(request, active);
      const bridge = new LimitedWorkerCommandBus(fixture.bridge, {
        accountConcurrency: 2,
        workerConcurrency: 2,
        accountRatePerMinute: limitedScope === "account" ? 1 : 10,
        workerRatePerMinute: limitedScope === "worker" ? 1 : 10,
        resolveOwnerId: async () => "owner-one",
      });
      await bridge.request("worker-one", {
        type: "workspace.repositories.discover",
        jobId: active.id,
        attempt: 1,
        rootPath: pathHandle,
        depth: 3,
      });
      request.mockClear();
      const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
        fixture.repository,
        bridge,
        { error: vi.fn(), warn: vi.fn() },
      );
      executor.queueAvailable();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fixture.fail).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(fixture.renewLease).toHaveBeenCalledWith(
        active.id,
        "command-one",
        2,
      );
      await vi.advanceTimersByTimeAsync(1);
      await executor.drain();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "worker-one",
        expect.objectContaining({ attempt: 2 }),
        expect.anything(),
      );
      expect(fixture.complete).toHaveBeenCalledTimes(1);
      expect(fixture.fail).not.toHaveBeenCalled();
      executor.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds repeated quota rejection and settles the job without a retry loop", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValue(new RelayLimitError("Temporary quota", 2));
    const fixture = limitedScanFixture(request);
    const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
      fixture.repository,
      fixture.bridge,
      { error: vi.fn(), warn: vi.fn() },
    );
    executor.queueAvailable();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fixture.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(fixture.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await executor.drain();
    expect(request).toHaveBeenCalledTimes(3);
    expect(fixture.fail).toHaveBeenCalledExactlyOnceWith(
      fixture.active.id,
      "command-one",
      {
        code: "discovery-failed",
        retryable: false,
      },
    );
    expect(fixture.complete).not.toHaveBeenCalled();
    executor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers interrupted scans and imports together after restart", async () => {
    const recoverInterrupted = vi.fn().mockResolvedValue(2);
    const recoverInterruptedImports = vi.fn().mockResolvedValue(3);
    const repository = {
      workspaceRepositoryDiscoveryJobs: {
        recoverInterrupted,
        recoverInterruptedImports,
      },
    } as unknown as ServerRepository;
    const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
      repository,
      {} as WorkerCommandBus,
      { error: vi.fn(), warn: vi.fn() },
    );

    await expect(executor.recoverAfterRestart(false)).resolves.toBe(5);
    expect(recoverInterrupted).toHaveBeenCalledWith(false);
    expect(recoverInterruptedImports).toHaveBeenCalledWith(false);
  });

  it("dispatches protected roots and commits only the active result", async () => {
    const active = job();
    const succeeded = {
      ...active,
      state: "succeeded" as const,
      stateRevision: 3,
      counts,
    };
    const complete = vi.fn().mockResolvedValue({
      job: succeeded,
      candidates: [],
    });
    const request = vi.fn(
      async (
        _workerId: string,
        _command: unknown,
        options: { onEvent?: (event: WorkerEvent) => void },
      ) => {
        options.onEvent?.({
          type: "workspace.repositories.discovery-progress",
          jobId: active.id,
          attempt: active.attempt,
          progress: { counts, diagnosticCode: null, truncated: false },
        });
        return {
          jobId: active.id,
          attempt: active.attempt,
          candidates: [
            {
              path: pathHandle,
              displayPath: displayHandle,
              originUrl: originUrlHandle,
              github: {
                repositoryId: githubRepositoryIdHandle,
                nameWithOwner: githubNameWithOwnerHandle,
                url: githubUrlHandle,
              },
              repositoryFingerprint: "c".repeat(64),
              classification: "github-accessible",
              diagnosticCode: null,
            },
          ],
          counts,
          diagnosticCode: null,
          truncated: false,
        };
      },
    );
    const repository = {
      getWorker: vi.fn().mockResolvedValue({
        workerId: "worker-one",
        managedFolders: { discoverWorkspaceRepositories: true },
      }),
      workspaceRepositoryDiscoveryJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            rootPathHandle: pathHandle,
            job: active,
          })
          .mockResolvedValue(null),
        claimNextImport: vi.fn().mockResolvedValue(null),
        complete,
        renewLease: vi.fn(),
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const changed = vi.fn();
    const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
      changed,
    );

    executor.queueAvailable();
    await executor.drain();

    expect(request).toHaveBeenCalledWith(
      "worker-one",
      {
        type: "workspace.repositories.discover",
        jobId: active.id,
        attempt: active.attempt,
        rootPath: pathHandle,
        depth: 3,
      },
      expect.objectContaining({ ownerId: "owner-one", timeoutMs: 60_000 }),
    );
    expect(complete).toHaveBeenCalledWith(active.id, "command-one", {
      attempt: 1,
      candidates: [
        {
          pathHandle,
          displayHandle,
          originUrlHandle,
          github: {
            repositoryId: githubRepositoryIdHandle,
            nameWithOwner: githubNameWithOwnerHandle,
            url: githubUrlHandle,
          },
          repositoryFingerprint: "c".repeat(64),
          classification: "github-accessible",
          diagnosticCode: null,
        },
      ],
      counts,
      truncated: false,
    });
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-one",
        progress: { counts, diagnosticCode: null, truncated: false },
      }),
    );
    expect(changed).toHaveBeenLastCalledWith({
      ownerId: "owner-one",
      job: succeeded,
    });
  });

  it("blocks offline scans and requeues them on worker reconnect", async () => {
    const active = job();
    const blocked = {
      ...active,
      state: "blocked" as const,
      stateRevision: 3,
      error: { code: "worker-offline" as const, retryable: true },
    };
    const block = vi.fn().mockResolvedValue(blocked);
    const requeueRetryableForWorker = vi.fn().mockResolvedValue(1);
    const requeueRetryableImportsForWorker = vi.fn().mockResolvedValue(1);
    const repository = {
      getWorker: vi.fn().mockResolvedValue({
        workerId: "worker-one",
        managedFolders: { discoverWorkspaceRepositories: true },
      }),
      workspaceRepositoryDiscoveryJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            rootPathHandle: pathHandle,
            job: active,
          })
          .mockResolvedValue(null),
        claimNextImport: vi.fn().mockResolvedValue(null),
        block,
        renewLease: vi.fn(),
        requeueRetryableForWorker,
        requeueRetryableImportsForWorker,
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(false),
      request: vi.fn(),
    } as unknown as WorkerCommandBus;
    const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
    );

    executor.queueAvailable();
    await executor.drain();
    expect(block).toHaveBeenCalledWith(active.id, "command-one", {
      code: "worker-offline",
      retryable: true,
    });
    expect(bridge.request).not.toHaveBeenCalled();

    await executor.workerConnected("worker-one");
    await executor.drain();
    expect(requeueRetryableForWorker).toHaveBeenCalledWith("worker-one");
    expect(requeueRetryableImportsForWorker).toHaveBeenCalledWith("worker-one");
  });

  it("records protected root failures without persisting worker paths", async () => {
    const active = job();
    const fail = vi.fn().mockResolvedValue({
      ...active,
      state: "failed" as const,
      stateRevision: 3,
      error: { code: "root-unavailable" as const, retryable: false },
    });
    const repository = {
      getWorker: vi.fn().mockResolvedValue({
        workerId: "worker-one",
        managedFolders: { discoverWorkspaceRepositories: true },
      }),
      workspaceRepositoryDiscoveryJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            rootPathHandle: pathHandle,
            job: active,
          })
          .mockResolvedValue(null),
        claimNextImport: vi.fn().mockResolvedValue(null),
        fail,
        renewLease: vi.fn(),
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request: vi
        .fn()
        .mockRejectedValue(
          new WorkerCommandError(
            "Protected repository operation failed on the worker.",
            "root-unavailable",
          ),
        ),
    } as unknown as WorkerCommandBus;
    const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
    );

    executor.queueAvailable();
    await executor.drain();

    expect(fail).toHaveBeenCalledWith(active.id, "command-one", {
      code: "root-unavailable",
      retryable: false,
    });
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fail.mock.calls)).not.toContain("/Users/");
  });

  it.each([false, true])(
    "revalidates and completes one durable import candidate (quota rejection: %s)",
    async (rateLimited) => {
      vi.useFakeTimers();
      const succeeded = {
        ...job(),
        state: "succeeded" as const,
        stateRevision: 6,
        counts,
      };
      const importClaim = {
        attempt: 1,
        candidateId: "fe47e031-8924-44c0-9b51-677fc23397ca",
        commandId: "import-command-one",
        expectedRepositoryFingerprint: "c".repeat(64),
        nameProtection: {
          classification: { recordKind: "project" as const },
          protectedLabel: {
            formatVersion: 1 as const,
            keyRevision: 1,
            envelope: {
              version: 1 as const,
              algorithm: "AES-256-GCM" as const,
              keyRevision: 1,
              nonce: "a".repeat(16),
              ciphertext: "b".repeat(22),
            },
          },
        },
        ownerId: "owner-one",
        pathHandle,
        projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
        repositoryBlindIndex: null,
        rootPathHandle: `ctrr_${"r".repeat(43)}`,
        workerId: "worker-one",
        workspaceId: "workspace-one",
      };
      const completeImport = vi.fn().mockResolvedValue(succeeded);
      const request = vi.fn().mockResolvedValue({
        candidateId: importClaim.candidateId,
        attempt: 1,
        path: pathHandle,
        displayPath: displayHandle,
        originUrl: null,
        github: null,
        repositoryFingerprint: "c".repeat(64),
        classification: "local-git",
        diagnosticCode: null,
        branch: null,
        head: null,
      });
      if (rateLimited)
        request.mockRejectedValueOnce(
          new RelayLimitError("Temporary quota", 1),
        );
      const failImport = vi.fn().mockResolvedValue(succeeded);
      const repository = {
        getWorker: vi.fn().mockResolvedValue({
          workerId: "worker-one",
          managedFolders: { discoverWorkspaceRepositories: true },
        }),
        workspaceRepositoryDiscoveryJobs: {
          failImport,
          claimNext: vi.fn().mockResolvedValue(null),
          claimNextImport: vi
            .fn()
            .mockResolvedValueOnce(importClaim)
            .mockResolvedValue(null),
          completeImport,
          getSnapshot: vi.fn().mockResolvedValue({
            job: succeeded,
            candidates: [],
          }),
          renewImportLease: vi.fn(),
        },
      } as unknown as ServerRepository;
      const bridge = {
        isConnected: vi.fn().mockReturnValue(true),
        request,
      } as unknown as WorkerCommandBus;
      const changed = vi.fn();
      const executor = new WorkspaceRepositoryDiscoveryJobExecutor(
        repository,
        bridge,
        { error: vi.fn(), warn: vi.fn() },
        changed,
      );

      executor.queueAvailable();
      await vi.advanceTimersByTimeAsync(1_000);
      await executor.drain();
      expect(failImport).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(rateLimited ? 2 : 1);

      expect(request).toHaveBeenCalledWith(
        "worker-one",
        {
          type: "workspace.repository-import.validate",
          candidateId: importClaim.candidateId,
          attempt: 1,
          rootPath: importClaim.rootPathHandle,
          path: pathHandle,
          expectedRepositoryFingerprint: "c".repeat(64),
        },
        { ownerId: "owner-one", timeoutMs: 60_000 },
      );
      expect(completeImport).toHaveBeenCalledWith(
        importClaim,
        expect.objectContaining({ classification: "local-git" }),
      );
      expect(changed).toHaveBeenLastCalledWith({
        ownerId: "owner-one",
        job: succeeded,
      });
    },
  );
});
