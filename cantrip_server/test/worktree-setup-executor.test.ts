import type {
  EndpointContentOpaque,
  WorkerRunSetupPublicStatus,
  WorktreeSetupJobSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { WorktreeSetupJobExecutor } from "../src/worktrees/setup-executor.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const now = "2026-08-21T12:00:00.000Z";

function job(): WorktreeSetupJobSummary {
  return {
    id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
    projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    worktreeId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
    workerId: "worker-one",
    configurationRevision: "a".repeat(64),
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

const protectedDetails: EndpointContentOpaque = {
  formatVersion: 1,
  domain: "run-content",
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

function status(
  active: WorktreeSetupJobSummary,
  state: "running" | "succeeded",
): WorkerRunSetupPublicStatus {
  return {
    jobId: active.id,
    projectId: active.projectId,
    worktreeId: active.worktreeId,
    configurationRevision: active.configurationRevision,
    attempt: active.attempt,
    state,
    exitCode: state === "succeeded" ? 0 : null,
    error: null,
    startedAt: now,
    completedAt: state === "succeeded" ? now : null,
    updatedAt: now,
  };
}

describe("worktree setup executor", () => {
  it("starts once, renews the durable lease, and polls to completion", async () => {
    const active = job();
    const running = status(active, "running");
    const succeededStatus = status(active, "succeeded");
    const succeeded = { ...active, state: "succeeded" as const };
    const complete = vi.fn().mockResolvedValue(succeeded);
    const renewLease = vi.fn().mockResolvedValue(true);
    const repository = {
      getWorker: vi.fn().mockResolvedValue({ workerId: active.workerId }),
      worktreeSetupJobs: {
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            ownerId: "owner-one",
            commandId: "command-one",
            sourcePath: "/workspace/project",
            worktreePath: "/workspace/project-worktrees/feature",
            job: active,
          })
          .mockResolvedValue(null),
        complete,
        renewLease,
      },
    } as unknown as ServerRepository;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
        status: running,
        protectedDetails,
      })
      .mockResolvedValueOnce({
        found: true,
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb331",
        status: succeededStatus,
        protectedDetails,
      });
    const bridge = {
      isConnected: vi.fn().mockReturnValue(true),
      request,
    } as unknown as WorkerCommandBus;
    const changed = vi.fn();
    const executor = new WorktreeSetupJobExecutor(
      repository,
      bridge,
      { error: vi.fn(), warn: vi.fn() },
      changed,
    );

    executor.queueAvailable();
    await executor.drain();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toMatchObject([
      active.workerId,
      {
        type: "project.run-setup.start",
        jobId: active.id,
        attempt: 1,
        projectId: active.projectId,
        worktreeId: active.worktreeId,
        sourcePath: "/workspace/project",
        worktreePath: "/workspace/project-worktrees/feature",
        configurationRevision: active.configurationRevision,
        operationId: expect.any(String),
        serverId: "server-internal",
      },
      { timeoutMs: 15_000 },
    ]);
    expect(request.mock.calls[1]).toMatchObject([
      active.workerId,
      {
        type: "project.run-setup.status",
        jobId: active.id,
        projectId: active.projectId,
        worktreeId: active.worktreeId,
        operationId: expect.any(String),
        serverId: "server-internal",
      },
      { timeoutMs: 15_000 },
    ]);
    expect(renewLease).toHaveBeenCalledWith(active.id, "command-one", 1);
    expect(complete).toHaveBeenCalledWith(
      active.id,
      "command-one",
      succeededStatus,
    );
    expect(changed).toHaveBeenCalledWith({
      ownerId: "owner-one",
      job: succeeded,
    });
  });
});
