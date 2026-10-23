import { describe, expect, it, vi } from "vitest";
import { createTaskExecutionRecovery } from "../src/app/runtime/task-execution-recovery.js";

function fixture(
  options: {
    native?: "running" | "idle" | "failed";
    misplaced?: boolean;
    paused?: boolean;
  } = {},
) {
  let context = {
    contextKind: "project",
    experience: "task",
    projectId: "project",
    chatId: "chat",
    workerId: "worker",
    worktreeId: options.misplaced ? "placeholder" : "original",
    threadId: options.misplaced ? null : "thread",
    status: "failed",
    cwd: "/original",
    automationPaused: options.paused ?? false,
    executionLaneId: null,
    worktreeMode: "agent-managed",
  };
  const task = {
    planGoalEnabled: true,
    implementationStartedAt: "2026-10-22T00:00:00Z",
    state: "failed",
    dispatch: {
      id: "cycle",
      chatId: "chat",
      operationId: "op",
      operationKind: "finalize",
      state: "expired",
      codexThreadId: "thread",
      worktreeId: "original",
      physicalWorkerId: "worker",
      fencingToken: 2,
    },
  };
  const lease = {
    cycleId: "cycle",
    operationId: "op",
    fencingToken: 3,
    leaseOwner: "server:new",
    leaseExpiresAt: "2099-01-01T00:00:00Z",
  };
  const repository = {
    getChatExecutionContext: vi.fn(async () => ({ ...context })),
    getProjectWorktreeContext: vi.fn(async () => ({
      workerId: "worker",
      worktree: { path: "/original" },
    })),
    updateChatWorktree: vi.fn(async () => {
      context = { ...context, worktreeId: "original", threadId: "thread" };
      return context;
    }),
    getPendingChatWorktreeTransition: vi.fn(async () => ({
      lane: { id: "old-transition" },
    })),
    cancelChatWorktreeTransition: vi.fn(async () => true),
    startChatExecutionLane: vi.fn(async () => {}),
    setChatStatus: vi.fn(async () => {}),
    taskDispatch: {
      list: vi.fn(async () => [task.dispatch]),
      recoverStartedGoal: vi.fn(async () => lease),
    },
    tasks: { get: vi.fn(async () => task) },
  };
  const goals = {
    readEncryptedTaskGoal: vi.fn(async () => ({
      goal: { threadId: "thread", status: "active" },
      execution: { threadId: "thread", status: options.native ?? "running" },
      task,
    })),
    retainTaskGoalLease: vi.fn(async () => {}),
    reconcileTaskGoalDispatch: vi.fn(async () => {}),
    resumeChatAutomation: vi.fn(async () => {}),
  };
  const bridge = { isConnected: vi.fn(() => true) };
  const publish = vi.fn();
  const unpause = vi.fn(async () => {
    context.automationPaused = false;
  });
  const recovery = createTaskExecutionRecovery({
    repository,
    bridge,
    goals,
    publish,
    unpause,
    ownerId: () => "owner",
    leaseOwner: "server:new",
  } as unknown as Parameters<typeof createTaskExecutionRecovery>[0]);
  return {
    context,
    task,
    lease,
    repository,
    goals,
    bridge,
    unpause,
    recovery,
    publish,
  };
}

describe("Task session recovery", () => {
  it("keeps a reacquired slot through explicit Resume of a settled blocked Goal", async () => {
    const f = fixture({ native: "idle" });
    f.task.state = "blocked";
    f.task.dispatch.state = "succeeded";
    f.goals.readEncryptedTaskGoal.mockResolvedValue({
      goal: { threadId: "thread", status: "blocked" },
      execution: { threadId: "thread", status: "idle" },
      task: f.task,
    } as never);
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(f.repository.taskDispatch.recoverStartedGoal).toHaveBeenCalledWith(
      "owner",
      f.task.dispatch,
      "server:new",
      expect.any(Date),
      { allowSettled: true },
    );
    expect(f.goals.reconcileTaskGoalDispatch).not.toHaveBeenCalled();
    expect(f.goals.resumeChatAutomation).toHaveBeenCalledWith(
      "chat",
      true,
      true,
    );
  });
  it("accepts observed completion without reacquiring capacity or starting a turn", async () => {
    const f = fixture({ native: "idle" });
    f.goals.readEncryptedTaskGoal.mockResolvedValue({
      goal: { threadId: "thread", status: "complete" },
      execution: { threadId: "thread", status: "idle" },
      task: { ...f.task, state: "complete" },
    } as never);
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(f.repository.taskDispatch.recoverStartedGoal).not.toHaveBeenCalled();
    expect(f.goals.reconcileTaskGoalDispatch).toHaveBeenCalledWith(
      f.task,
      "complete",
    );
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("adopts an already-running native Goal, re-fences its lease and cancels the obsolete handoff without a new turn", async () => {
    const f = fixture();
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(f.goals.readEncryptedTaskGoal).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread", worktreeId: "original" }),
      f.task,
      null,
      true,
    );
    expect(f.repository.taskDispatch.recoverStartedGoal).toHaveBeenCalledWith(
      "owner",
      f.task.dispatch,
      "server:new",
    );
    expect(f.repository.cancelChatWorktreeTransition).toHaveBeenCalledWith(
      "owner",
      "chat",
      "old-transition",
    );
    expect(f.goals.retainTaskGoalLease).toHaveBeenCalledWith(f.lease);
    expect(f.repository.startChatExecutionLane).toHaveBeenCalledOnce();
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("restores the original session after a failed worktree continuation detached it", async () => {
    const f = fixture({ misplaced: true });
    await f.recovery.recover("chat");
    expect(f.repository.updateChatWorktree).toHaveBeenCalledWith(
      "owner",
      "chat",
      { worktreeId: "original", mode: "agent-managed" },
      "placeholder",
    );
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("resumes an idle retained Goal automatically, but never restarts an admitted running chat", async () => {
    const f = fixture({ native: "idle" });
    await f.recovery.recover("chat");
    expect(f.goals.resumeChatAutomation).toHaveBeenCalledExactlyOnceWith(
      "chat",
      false,
      true,
    );
    f.context.status = "running";
    f.goals.resumeChatAutomation.mockClear();
    await f.recovery.recover("chat", true);
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("shares simultaneous recovery requests instead of starting duplicate continuations", async () => {
    const f = fixture({ native: "idle" });
    await Promise.all([
      f.recovery.recover("chat", true),
      f.recovery.recover("chat", true),
    ]);
    expect(f.goals.readEncryptedTaskGoal).toHaveBeenCalledOnce();
    expect(f.goals.resumeChatAutomation).toHaveBeenCalledExactlyOnceWith(
      "chat",
      true,
      true,
    );
  });
  it("preserves the user's pause until Resume is explicitly requested", async () => {
    const f = fixture({ paused: true, native: "idle" });
    await f.recovery.recover("chat");
    expect(f.goals.readEncryptedTaskGoal).not.toHaveBeenCalled();
    await f.recovery.recover("chat", true);
    expect(f.unpause).toHaveBeenCalledExactlyOnceWith("owner", "chat");
    expect(f.goals.resumeChatAutomation).toHaveBeenCalledExactlyOnceWith(
      "chat",
      true,
      true,
    );
  });
  it("does not swallow an explicit Resume behind a passive paused observation", async () => {
    const f = fixture({ paused: true, native: "idle" });
    await Promise.all([
      f.recovery.recover("chat"),
      f.recovery.recover("chat", true),
    ]);
    expect(f.unpause).toHaveBeenCalledOnce();
    expect(f.goals.resumeChatAutomation).toHaveBeenCalledExactlyOnceWith(
      "chat",
      true,
      true,
    );
  });
  it.each(["offline", "replacement", "failed", "unobserved"])(
    "does not replace or launch a session after %s",
    async (kind) => {
      const f = fixture({ native: kind === "failed" ? "failed" : "running" });
      if (kind === "offline") f.bridge.isConnected.mockReturnValue(false);
      if (kind === "replacement") f.context.threadId = "replacement";
      if (kind === "unobserved")
        f.goals.readEncryptedTaskGoal.mockResolvedValue({
          goal: null,
        } as never);
      await expect(f.recovery.recover("chat", true)).rejects.toThrow();
      expect(f.repository.updateChatWorktree).not.toHaveBeenCalled();
      expect(
        f.repository.taskDispatch.recoverStartedGoal,
      ).not.toHaveBeenCalled();
      expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
    },
  );
  it("reconciles expired Goals after worker reconnect and throttles repeated observations", async () => {
    const f = fixture();
    await f.recovery.reconcile("owner");
    await f.recovery.reconcile("owner");
    expect(f.goals.readEncryptedTaskGoal).toHaveBeenCalledOnce();
  });
  it("does not retain or resume a superseded dispatch fence", async () => {
    const f = fixture({ native: "idle" });
    f.repository.taskDispatch.recoverStartedGoal.mockRejectedValue(
      new Error("stale lease"),
    );
    await expect(f.recovery.recover("chat", true)).rejects.toThrow(
      "stale lease",
    );
    expect(f.goals.retainTaskGoalLease).not.toHaveBeenCalled();
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("preserves a replacement session selected while unpausing", async () => {
    const f = fixture({ paused: true });
    f.unpause.mockImplementation(async () => {
      f.context.automationPaused = false;
      f.context.threadId = "replacement";
    });
    await expect(f.recovery.recover("chat", true)).rejects.toThrow(
      "changed during recovery",
    );
    expect(f.goals.readEncryptedTaskGoal).not.toHaveBeenCalled();
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("does not adopt a healthy local cycle or cancel its intentional handoff", async () => {
    const f = fixture();
    f.context.status = "idle";
    Object.assign(f.task.dispatch, {
      state: "running",
      leaseOwner: "server:new",
    });
    expect(await f.recovery.recover("chat")).toBe(false);
    expect(f.goals.readEncryptedTaskGoal).not.toHaveBeenCalled();
    expect(f.repository.cancelChatWorktreeTransition).not.toHaveBeenCalled();
  });
  it("repairs a missing Goal on the idle current handoff without moving back to an obsolete session", async () => {
    const f = fixture();
    f.context.threadId = "handoff-thread";
    const continueGoal = vi.fn(async () => true);
    Object.assign(f.goals, { continueTaskGoalInWorktree: continueGoal });
    f.goals.readEncryptedTaskGoal.mockResolvedValue({
      goal: null,
      execution: { threadId: "handoff-thread", status: "idle" },
      task: f.task,
    } as never);
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(continueGoal).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "handoff-thread" }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("task-goal-repair:"),
      }),
    );
    expect(f.repository.updateChatWorktree).not.toHaveBeenCalled();
    expect(f.goals.resumeChatAutomation).not.toHaveBeenCalled();
  });
  it("does not repair a missing Goal while the native turn is still running", async () => {
    const f = fixture();
    f.context.threadId = "handoff-thread";
    const continueGoal = vi.fn();
    Object.assign(f.goals, { continueTaskGoalInWorktree: continueGoal });
    f.goals.readEncryptedTaskGoal.mockResolvedValue({
      goal: null,
      execution: { threadId: "handoff-thread", status: "running" },
      task: f.task,
    } as never);
    await expect(f.recovery.recover("chat", true)).rejects.toThrow(
      "different session",
    );
    expect(continueGoal).not.toHaveBeenCalled();
  });
});
