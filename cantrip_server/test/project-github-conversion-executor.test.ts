import type {
  ProjectGithubConversionJobSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { ProjectGithubConversionJobExecutor } from "../src/project-github-conversions/executor.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const now = "2026-08-18T12:00:00.000Z";

function job(): ProjectGithubConversionJobSummary {
  return {
    id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
    projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    workerId: "worker-one",
    repository: {
      repositoryId: "42",
      nameWithOwner: "ArcaneArts/Scratch",
      url: "https://github.com/ArcaneArts/Scratch",
    },
    state: "running",
    stateRevision: 2,
    attempt: 1,
    initialCommitRequested: true,
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
    },
    chatRelocation: false,
    externalCodexHistory: false,
    startedAt: now,
    lastSeenAt: now,
    online: true,
  };
}

describe("project GitHub conversion executor", () => {
  it("sends only derived identity and atomically completes a ready result", async () => {
    const active = job();
    const complete = vi.fn().mockResolvedValue({
      ...active,
      state: "succeeded" as const,
    });
    const request = vi.fn().mockResolvedValue({
      status: "ready",
      jobId: active.id,
      attempt: active.attempt,
      repository: active.repository,
      path: `/data/folders/${active.projectId}`,
      displayPath: `folders/${active.projectId}`,
      repositoryFingerprint: "b".repeat(64),
      branch: "main",
      head: "c".repeat(40),
      worktreePolicy: "agent-managed",
    });
    const repository = {
      getWorker: vi.fn().mockResolvedValue(worker()),
      projectGithubConversionJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            confirmationToken: "a".repeat(64),
            initialCommit: { message: "Initial commit" },
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
    const executor = new ProjectGithubConversionJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
    );

    executor.queueAvailable();
    await executor.drain();
    expect(request).toHaveBeenCalledWith(
      "worker-one",
      expect.objectContaining({
        type: "project.folder-conversion.execute",
        projectId: active.projectId,
        repository: active.repository,
        confirmationToken: "a".repeat(64),
      }),
      expect.any(Object),
    );
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("path");
    expect(complete).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ status: "ready", branch: "main" }),
    );
  });

  it("keeps an offline conversion durable for reconnect recovery", async () => {
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
      projectGithubConversionJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            confirmationToken: "a".repeat(64),
            initialCommit: null,
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
    const executor = new ProjectGithubConversionJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
    );

    executor.queueAvailable();
    await executor.drain();
    expect(block).toHaveBeenCalledWith(
      active.id,
      "command-one",
      expect.objectContaining({ code: "worker-offline", retryable: true }),
    );
    await executor.workerConnected("worker-one");
    expect(requeueRetryableForWorker).toHaveBeenCalledWith("worker-one");
  });
});
