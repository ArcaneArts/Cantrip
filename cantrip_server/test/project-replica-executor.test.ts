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
  it("dispatches protected direct placement and persists the worker facts", async () => {
    const active: ProjectReplicaJobSummary = {
      ...job("synchronize"),
      projectReplicaId: null,
      kind: "provision",
      idempotencyKey: "provision:project-one:worker-one:direct",
      placementMode: "direct",
      placementPath: `ctrr_${"P".repeat(43)}`,
      expectedRevision: "a".repeat(40),
      synchronizationPolicy: null,
    };
    const completed = { ...active, state: "succeeded" as const };
    const result = {
      status: "ready" as const,
      jobId: active.id,
      attempt: 1,
      path: `ctrr_${"C".repeat(43)}`,
      displayPath: "ArcaneArts/Cantrip",
      repositoryFingerprint: "f".repeat(64),
      resolvedRevision: "a".repeat(40),
      branch: "main",
      reused: false,
      placement: {
        mode: "direct" as const,
        materialization: "cloned" as const,
        ownership: "cantrip" as const,
        canonicalPath: `ctrr_${"C".repeat(43)}`,
        requestedPath: `ctrr_${"R".repeat(43)}`,
        linkPath: null,
      },
      worktreePolicy: null,
    };
    const request = vi.fn().mockResolvedValue(result);
    const completeProvision = vi.fn().mockResolvedValue(completed);
    const capableWorker = worker();
    capableWorker.projectReplicas = {
      ...capableWorker.projectReplicas,
      directPlacement: true,
      attachExisting: true,
      recursiveParentCreation: true,
    };
    const repository = {
      getWorker: vi.fn().mockResolvedValue(capableWorker),
      getProjectWorkspaceStorageContext: vi.fn().mockResolvedValue({
        kind: "managed",
        workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
      }),
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
        completeProvision,
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

    expect(request).toHaveBeenCalledWith(
      "worker-one",
      expect.objectContaining({
        type: "project.replica.provision",
        projectId: "project-one",
        workspaceStorage: {
          kind: "managed",
          workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
        },
        placement: {
          mode: "direct",
          path: `ctrr_${"P".repeat(43)}`,
        },
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(completeProvision).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ placement: result.placement }),
    );
  });

  it("dispatches attach-only local Git sources without clone-directory capability", async () => {
    const active: ProjectReplicaJobSummary = {
      ...job("synchronize"),
      projectReplicaId: null,
      kind: "provision",
      idempotencyKey: "attach:project-one:worker-one",
      repository: null,
      placementMode: "direct",
      placementPath: `ctrr_${"P".repeat(43)}`,
      expectedRevision: "a".repeat(40),
      synchronizationPolicy: null,
    };
    const completed = { ...active, state: "succeeded" as const };
    const result = {
      status: "ready" as const,
      jobId: active.id,
      attempt: 1,
      path: `ctrr_${"C".repeat(43)}`,
      displayPath: `ctrr_${"D".repeat(43)}`,
      repositoryFingerprint: "f".repeat(64),
      resolvedRevision: "a".repeat(40),
      branch: "main",
      reused: true,
      placement: {
        mode: "direct" as const,
        materialization: "attached" as const,
        ownership: "user" as const,
        canonicalPath: `ctrr_${"C".repeat(43)}`,
        requestedPath: `ctrr_${"R".repeat(43)}`,
        linkPath: null,
      },
      worktreePolicy: null,
    };
    const request = vi.fn().mockResolvedValue(result);
    const completeProvision = vi.fn().mockResolvedValue(completed);
    const capableWorker = worker();
    capableWorker.projectReplicas = {
      ...capableWorker.projectReplicas,
      directPlacement: true,
      attachExisting: true,
      recursiveParentCreation: false,
    };
    const repository = {
      getWorker: vi.fn().mockResolvedValue(capableWorker),
      getProjectWorkspaceStorageContext: vi
        .fn()
        .mockResolvedValue({ kind: "system" }),
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
        completeProvision,
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

    expect(request).toHaveBeenCalledWith(
      "worker-one",
      expect.objectContaining({
        type: "project.replica.provision",
        repository: null,
        placement: { mode: "direct", path: active.placementPath },
        expectedRevision: active.expectedRevision,
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(completeProvision).toHaveBeenCalledOnce();
  });

  it("blocks managed placement on workers that cannot derive workspace roots", async () => {
    const active = job("synchronize");
    const blocked = {
      ...active,
      state: "blocked" as const,
      error: {
        code: "capability-missing" as const,
        message: "Capability missing.",
        retryable: false,
      },
    };
    const block = vi.fn().mockResolvedValue(blocked);
    const request = vi.fn();
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      getProjectWorkspaceStorageContext: vi.fn().mockResolvedValue({
        kind: "managed",
        workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
      }),
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
      expect.objectContaining({ code: "capability-missing", retryable: false }),
    );
    expect(request).not.toHaveBeenCalled();
  });

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
      getProjectWorkspaceStorageContext: vi
        .fn()
        .mockResolvedValue({ kind: "system" }),
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
      getProjectWorkspaceStorageContext: vi
        .fn()
        .mockResolvedValue({ kind: "system" }),
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
      getProjectWorkspaceStorageContext: vi
        .fn()
        .mockResolvedValue({ kind: "system" }),
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
      workspaceStorage: { kind: "system" },
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
