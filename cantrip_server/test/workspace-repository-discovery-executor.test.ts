import type {
  WorkerEvent,
  WorkspaceRepositoryDiscoveryJobSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
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
          progress: { counts, truncated: false },
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
        progress: { counts, truncated: false },
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
    expect(JSON.stringify(fail.mock.calls)).not.toContain("/Users/");
  });

  it("revalidates and completes one durable import candidate", async () => {
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
    const repository = {
      getWorker: vi.fn().mockResolvedValue({
        workerId: "worker-one",
        managedFolders: { discoverWorkspaceRepositories: true },
      }),
      workspaceRepositoryDiscoveryJobs: {
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
    await executor.drain();

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
  });
});
