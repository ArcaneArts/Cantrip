import type {
  ProjectFolderSetupJobSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { ProjectFolderSetupJobExecutor } from "../src/project-folders/executor.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const now = "2026-08-18T12:00:00.000Z";

function job(): ProjectFolderSetupJobSummary {
  return {
    id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
    projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    workerId: "worker-one",
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
      testedRange: ">=0.151.0 <0.152.0",
      initialize: null,
      methods: {},
      features: [],
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
      patchset: null,
      transport: "web-proxy",
      maxSessions: 1,
      reason: "Unavailable",
    },
    projectReplicas: {
      provision: false,
      synchronize: false,
      remove: false,
      exactRevision: false,
    },
    managedFolders: {
      create: true,
      convertToGithub: true,
      remove: true,
      workspaceScopedRoots: true,
    },
    chatRelocation: false,
    externalCodexHistory: false,
    startedAt: now,
    lastSeenAt: now,
    online: true,
  };
}

describe("project folder setup executor", () => {
  it("blocks offline work and requeues it when the owning worker reconnects", async () => {
    const active = job();
    const blocked = {
      ...active,
      state: "blocked" as const,
      error: {
        code: "worker-offline" as const,
        message: "Offline.",
        retryable: true,
      },
    };
    const block = vi.fn().mockResolvedValue(blocked);
    const requeueRetryableForWorker = vi.fn().mockResolvedValue(1);
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      getProjectWorkspaceStorageContext: vi
        .fn()
        .mockResolvedValue({ kind: "system" }),
      projectFolderSetupJobs: {
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
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(false),
      request: vi.fn(),
    } as unknown as WorkerCommandBus;
    const executor = new ProjectFolderSetupJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

    executor.queueAvailable();
    await executor.drain();
    expect(block).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ code: "worker-offline", retryable: true }),
    );
    expect(bridge.request).not.toHaveBeenCalled();

    await executor.workerConnected("worker-one");
    await executor.drain();
    expect(requeueRetryableForWorker).toHaveBeenCalledWith("worker-one");
  });

  it("materializes by UUID and commits only the active attempt", async () => {
    const active = job();
    const succeeded = { ...active, state: "succeeded" as const };
    const complete = vi.fn().mockResolvedValue(succeeded);
    const request = vi.fn().mockResolvedValue({
      status: "ready",
      jobId: active.id,
      attempt: active.attempt,
      path: `/data/folders/${active.projectId}`,
      displayPath: `folders/${active.projectId}`,
      reused: false,
    });
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      getProjectWorkspaceStorageContext: vi.fn().mockResolvedValue({
        kind: "managed",
        workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
      }),
      projectFolderSetupJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            job: active,
          })
          .mockResolvedValue(null),
        complete,
      },
    } as unknown as ServerRepository;
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const executor = new ProjectFolderSetupJobExecutor(repository, bridge, {
      error: vi.fn(),
      warn: vi.fn(),
    });

    executor.queueAvailable();
    await executor.drain();
    expect(request).toHaveBeenCalledWith(
      "worker-one",
      {
        type: "project.folder.materialize",
        jobId: active.id,
        attempt: active.attempt,
        projectId: active.projectId,
        workspaceStorage: {
          kind: "managed",
          workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
        },
      },
      { timeoutMs: 60_000 },
    );
    expect(complete).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ jobId: active.id, attempt: active.attempt }),
    );
  });
});
