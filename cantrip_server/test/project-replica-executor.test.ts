import type {
  ProjectReplicaJobSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import {
  PROJECT_REPLICA_COMMAND_TIMEOUT_MS,
  ProjectReplicaJobExecutor,
} from "../src/project-replicas/executor.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const now = "2026-08-11T12:00:00.000Z";

function job(kind: "synchronize" | "remove"): ProjectReplicaJobSummary {
  return {
    id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    projectId: "project-one",
    projectReplicaId: "replica-one",
    workerId: "worker-one",
    kind,
    state: "running",
    stateRevision: 2,
    idempotencyKey: `${kind}:project-one:replica-one`,
    repository: "ArcaneArts/Cantrip",
    expectedRevision: kind === "synchronize" ? "b".repeat(40) : null,
    resolvedRevision: null,
    synchronizationPolicy:
      kind === "synchronize" ? "fast-forward-primary" : null,
    deleteLocalFiles: kind === "remove" ? true : null,
    attempt: 1,
    progress: {
      stage: "dispatching",
      percent: 5,
      message: "Dispatching.",
      updatedAt: now,
    },
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    cancellationUnsafeAt: now,
    completedAt: null,
  };
}

function worker(): WorkerSummary {
  return {
    id: "worker-one",
    name: "Worker One",
    displayName: null,
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    status: "online",
    lastSeenAt: now,
    startedAt: now,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    code: {
      available: false,
      version: null,
      upstreamRevision: null,
      patchset: null,
      transport: "web-proxy",
      maxSessions: 0,
      reason: "Unavailable",
    },
    projectReplicas: {
      provision: true,
      synchronize: true,
      remove: true,
      exactRevision: true,
    },
    managedFolders: {
      create: true,
      convertToGithub: true,
      remove: true,
    },
  };
}

describe("project replica job executor", () => {
  it("routes exact-revision synchronization and commits only its active result", async () => {
    const active = job("synchronize");
    const completed = { ...active, state: "succeeded" as const };
    const request = vi.fn().mockResolvedValue({
      status: "ready",
      jobId: active.id,
      attempt: 1,
      path: "/worker/repositories/ArcaneArts/Cantrip",
      previousRevision: "a".repeat(40),
      resolvedRevision: "b".repeat(40),
      branch: "main",
      changed: true,
    });
    const completeSynchronize = vi.fn().mockResolvedValue(completed);
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      projectGithubConversionJobs: {
        isConvertedManagedFolderSource: vi.fn().mockResolvedValue(false),
      },
      projectReplicaJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        operationContext: vi.fn().mockResolvedValue({
          primaryWorktreeId: "worktree-one",
          sourcePath: "/worker/repositories/ArcaneArts/Cantrip",
        }),
        completeSynchronize,
        updateProgress: vi.fn(),
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const changes: ProjectReplicaJobSummary[] = [];
    const executor = new ProjectReplicaJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
      ({ job: changed }) => changes.push(changed),
    );

    executor.queueAvailable();
    await executor.drain();

    expect(request).toHaveBeenCalledWith(
      "worker-one",
      expect.objectContaining({
        type: "project.replica.synchronize",
        expectedRevision: "b".repeat(40),
        policy: "fast-forward-primary",
      }),
      expect.objectContaining({
        timeoutMs: PROJECT_REPLICA_COMMAND_TIMEOUT_MS,
      }),
    );
    expect(completeSynchronize).toHaveBeenCalledOnce();
    expect(changes.at(-1)).toMatchObject({ state: "succeeded" });
  });

  it("blocks removal before contacting a worker when a surface uses the replica", async () => {
    const active = job("remove");
    const blocked = {
      ...active,
      state: "blocked" as const,
      error: {
        code: "replica-in-use" as const,
        message: "A terminal is still assigned to this replica.",
        retryable: false,
      },
    };
    const request = vi.fn();
    const block = vi.fn().mockResolvedValue(blocked);
    const markRemovalStarted = vi.fn();
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      projectGithubConversionJobs: {
        isConvertedManagedFolderSource: vi.fn().mockResolvedValue(false),
      },
      projectReplicaJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        operationContext: vi.fn().mockResolvedValue({
          primaryWorktreeId: "worktree-one",
          sourcePath: "/worker/repositories/ArcaneArts/Cantrip",
        }),
        removalBlocker: vi
          .fn()
          .mockResolvedValue("A terminal is still assigned to this replica."),
        markRemovalStarted,
        block,
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const executor = new ProjectReplicaJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

    executor.queueAvailable();
    await executor.drain();

    expect(block).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ code: "replica-in-use" }),
    );
    expect(markRemovalStarted).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("removes a converted managed source through the UUID-scoped folder command", async () => {
    const active = job("remove");
    const completed = { ...active, state: "succeeded" as const };
    const request = vi.fn().mockResolvedValue({ deleted: true });
    const completeRemove = vi.fn().mockResolvedValue(completed);
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      projectGithubConversionJobs: {
        isConvertedManagedFolderSource: vi.fn().mockResolvedValue(true),
      },
      projectReplicaJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        operationContext: vi.fn().mockResolvedValue({
          primaryWorktreeId: "worktree-one",
          sourcePath: "/worker/folders/project-one",
        }),
        removalBlocker: vi.fn().mockResolvedValue(null),
        markRemovalStarted: vi.fn().mockResolvedValue(true),
        completeRemove,
        updateProgress: vi.fn(),
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const executor = new ProjectReplicaJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

    executor.queueAvailable();
    await executor.drain();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("worker-one", {
      type: "project.folder.delete",
      projectId: "project-one",
    });
    expect(completeRemove).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({
        status: "removed",
        path: "/worker/folders/project-one",
        localFilesDeleted: true,
      }),
    );
  });
});
