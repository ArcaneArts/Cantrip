import type {
  StandaloneChatRootJobSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { StandaloneChatRootJobExecutor } from "../src/standalone-chats/root-job-executor.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const now = "2026-08-25T12:00:00.000Z";
const rootId = "33333333-3333-4333-8333-333333333333";
const chatId = "22222222-2222-4222-8222-222222222222";

function job(
  kind: "provision" | "delete" = "provision",
): StandaloneChatRootJobSummary {
  return {
    id:
      kind === "provision"
        ? "44444444-4444-4444-8444-444444444444"
        : "55555555-5555-4555-8555-555555555555",
    rootId,
    chatId,
    workerId: "worker-one",
    kind,
    state: "running",
    stateRevision: 2,
    attempt: 1,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };
}

function worker(): WorkerSummary {
  return {
    workerId: "worker-one",
    name: "Worker One",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: {
      adapter: "app-server",
      compatibility: "missing",
      version: null,
      testedRange: ">=0.149.0 <0.150.0",
      initialize: null,
      methods: {},
      features: [],
      nativeSubagents: {
        available: false,
        protocolVersion: null,
        reason: "Not probed.",
      },
      degradedReasons: ["Not probed."],
    },
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 1,
    },
    directBroker: { available: false },
    code: {
      available: false,
      version: null,
      upstreamRevision: null,
      patchset: 0,
      transport: "web-proxy",
      maxSessions: 1,
      reason: "Unavailable",
    },
    projectReplicas: {
      provision: false,
      synchronize: false,
      remove: false,
      exactRevision: false,
      directPlacement: false,
      managedLinkPlacement: false,
      attachExisting: false,
      recursiveParentCreation: false,
    },
    managedFolders: {
      create: true,
      attachExisting: true,
      convertToGithub: true,
      remove: true,
    },
    standaloneChat: {
      protocolVersion: 1,
      scratch: {
        provision: true,
        resolve: true,
        archive: true,
        restore: true,
        remove: true,
        reconcile: true,
        routingHandles: true,
      },
      files: {
        list: false,
        read: false,
        write: false,
        remove: false,
        download: false,
        archive: false,
        networkShare: false,
      },
    },
    chatRelocation: false,
    externalCodexHistory: false,
    codegraph: {
      supported: false,
      available: false,
      runtimeState: "unavailable",
      installedVersion: null,
      latestVersion: null,
      previousVersion: null,
      lastCheckedAt: null,
      telemetryDisabled: false,
      healthy: false,
      statusMessage: null,
      projectCounts: { ready: 0, indexing: 0, queued: 0, degraded: 0 },
      cliAvailable: false,
      mcpInjectionAvailable: false,
    },
    encryption: {
      supported: false,
      state: "unavailable",
      principalId: null,
      grants: [],
      lastSyncedAt: null,
      error: null,
    },
    startedAt: now,
    lastSeenAt: now,
    online: true,
  };
}

describe("standalone Chat root job executor", () => {
  it("recovers expired archived roots after a server restart", async () => {
    const expired = job("delete");
    const onChanged = vi.fn();
    const repository = {
      standaloneChatRootJobs: {
        recoverInterrupted: vi.fn().mockResolvedValue(0),
        purgeExpiredArchivedChatsForAllOwners: vi
          .fn()
          .mockResolvedValue([{ ownerId: "owner-one", job: expired }]),
        claimNext: vi.fn().mockResolvedValue(null),
      },
    } as unknown as ServerRepository;
    const executor = new StandaloneChatRootJobExecutor(
      repository,
      {} as WorkerCommandBus,
      { error: vi.fn(), warn: vi.fn() },
      onChanged,
    );

    await expect(executor.recoverAfterRestart()).resolves.toBe(0);
    await executor.drain();
    expect(onChanged).toHaveBeenCalledWith({
      ownerId: "owner-one",
      job: expired,
    });
    expect(
      repository.standaloneChatRootJobs.purgeExpiredArchivedChatsForAllOwners,
    ).toHaveBeenCalledOnce();
    executor.stop();
  });

  it("blocks while offline and requeues on worker reconnect", async () => {
    const active = job();
    const blocked = {
      ...active,
      state: "blocked" as const,
      error: { code: "worker-offline" as const, retryable: true },
    };
    const block = vi.fn().mockResolvedValue(blocked);
    const requeueRetryableForWorker = vi.fn().mockResolvedValue(1);
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      getWorkerOwnerId: vi.fn().mockResolvedValue("owner-one"),
      standaloneChatRootJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        block,
        requeueRetryableForWorker,
        reconciliationTargets: vi.fn().mockResolvedValue([]),
        purgeExpiredArchivedChats: vi.fn().mockResolvedValue([]),
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(false),
      request: vi.fn(),
    } as unknown as WorkerCommandBus;
    const executor = new StandaloneChatRootJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

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
  });

  it("provisions by opaque identities and commits only a routed path handle", async () => {
    const active = job();
    const completeProvision = vi.fn().mockResolvedValue({
      ...active,
      state: "succeeded" as const,
    });
    const request = vi.fn().mockResolvedValue({
      status: "ready",
      jobId: active.id,
      attempt: active.attempt,
      rootId,
      chatId,
      path: "ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      displayPath: "ctrr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reused: false,
    });
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      standaloneChatRootJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        completeProvision,
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const executor = new StandaloneChatRootJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

    executor.queueAvailable();
    await executor.drain();
    expect(request).toHaveBeenCalledWith(
      "worker-one",
      {
        type: "chat.scratch.provision",
        jobId: active.id,
        attempt: active.attempt,
        rootId,
        chatId,
      },
      { timeoutMs: 60_000 },
    );
    expect(completeProvision).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({
        path: "ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
  });

  it("performs one authoritative reconciliation on reconnect", async () => {
    const markMissingRoots = vi.fn().mockResolvedValue(1);
    const purgeExpiredArchivedChats = vi
      .fn()
      .mockResolvedValue([job("delete")]);
    const onChanged = vi.fn();
    const reconciliationTargets = vi
      .fn()
      .mockResolvedValue([
        { rootId, chatId, archivedAt: null, archiveExpiresAt: null },
      ]);
    const repository = {
      getWorkerOwnerId: vi.fn().mockResolvedValue("owner-one"),
      getWorker: vi.fn().mockResolvedValue(worker()),
      standaloneChatRootJobs: {
        requeueRetryableForWorker: vi.fn().mockResolvedValue(0),
        reconciliationTargets,
        purgeExpiredArchivedChats,
        markMissingRoots,
        claimNext: vi.fn().mockResolvedValue(null),
      },
    } as unknown as ServerRepository;
    const request = vi.fn().mockResolvedValue({
      retainedRootIds: [],
      missingRootIds: [rootId],
      orphanedRootIds: [],
      dueRootIds: [],
    });
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const executor = new StandaloneChatRootJobExecutor(
      repository,
      bridge,
      {
        error: vi.fn(),
        warn: vi.fn(),
      },
      onChanged,
    );

    await executor.workerConnected("worker-one");
    await executor.drain();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "worker-one",
      {
        type: "chat.scratch.reconcile",
        roots: [{ rootId, chatId, archivedAt: null, archiveExpiresAt: null }],
      },
      { timeoutMs: 60_000 },
    );
    expect(purgeExpiredArchivedChats).toHaveBeenCalledWith("owner-one");
    expect(onChanged).toHaveBeenCalledWith({
      ownerId: "owner-one",
      job: job("delete"),
    });
    expect(markMissingRoots).toHaveBeenCalledWith("worker-one", [rootId]);
  });
});
