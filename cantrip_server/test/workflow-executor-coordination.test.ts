import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { WorkflowExecutor } from "../src/workflows/executor.js";
import type { ProjectWorktreeCoordinator } from "../src/worktrees/coordinator.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

describe("workflow executor coordination", () => {
  it("recovers and dispatches durable workflow state across account owners", async () => {
    const recoverInterruptedAttempts = vi.fn().mockResolvedValue([
      {
        interruptions: [],
        ownerId: "owner-a",
        projectId: "project-a",
        runId: "run-a",
      },
      {
        interruptions: [],
        ownerId: "owner-b",
        projectId: null,
        runId: "run-b",
      },
    ]);
    const listRecoverableWorktreeLeases = vi.fn().mockResolvedValue([]);
    const listDispatchableRuns = vi.fn().mockResolvedValue([
      { ownerId: "owner-a", runId: "run-a" },
      { ownerId: "owner-b", runId: "run-b" },
    ]);
    const getRun = vi.fn().mockResolvedValue(null);
    const repository = {
      workflowRuns: {
        getRun,
        listDispatchableRuns,
        listRecoverableWorktreeLeases,
        recoverInterruptedAttempts,
      },
    } as unknown as ServerRepository;
    const onRunChanged = vi.fn();
    const executor = new WorkflowExecutor(
      repository,
      { isConnected: () => false } as unknown as WorkerCommandBus,
      {} as ProjectWorktreeCoordinator,
      { error: vi.fn(), warn: vi.fn() },
      onRunChanged,
    );

    await expect(executor.recoverAfterRestart()).resolves.toBe(2);
    expect(recoverInterruptedAttempts).toHaveBeenCalledWith(null);
    expect(listRecoverableWorktreeLeases).toHaveBeenCalledWith(null, null);
    expect(onRunChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-a", runId: "run-a" }),
    );
    expect(onRunChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-b", runId: "run-b" }),
    );

    await executor.queueAvailableRuns();
    await executor.drain();
    expect(getRun).toHaveBeenCalledWith("owner-a", "run-a");
    expect(getRun).toHaveBeenCalledWith("owner-b", "run-b");
    executor.stop();
  });
});
