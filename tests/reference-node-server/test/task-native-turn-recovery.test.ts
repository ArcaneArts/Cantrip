import { describe, expect, it, vi } from "vitest";
import { createTaskExecutionRecovery } from "../src/app/runtime/task-execution-recovery.js";

function fixture() {
  const context = {
    experience: "task",
    contextKind: "project",
    chatId: "chat",
    projectId: "project",
    workerId: "worker",
    worktreeId: "worktree",
    threadId: null,
  };
  const task = {
    planGoalEnabled: false,
    state: "implementing",
    dispatch: { state: "expired", operationKind: "direct" },
  };
  const retained = {
    source: {
      context: { ...context, threadId: "original-native-thread" },
      nativeExecution: {
        threadId: "original-native-thread",
        turnId: "original-native-turn",
        scopeId: "original-native-scope",
      },
    },
  };
  const observed = {
    threadId: "original-native-thread",
    turnId: "original-native-turn",
    runtimeGeneration: "replacement-runtime",
    status: "interrupted",
  };
  const repository = {
    getChatExecutionContext: vi.fn(async () => context),
    tasks: {
      get: vi.fn(async () => task),
      captureNativeTurnRecovery: vi.fn(
        async () => retained as typeof retained | null,
      ),
      failObservedNativeTurn: vi.fn(async () => true),
    },
  };
  const observeNativeTurn = vi.fn(async () => observed);
  const publish = vi.fn(),
    unpause = vi.fn();
  const bridge = { isConnected: vi.fn(() => true) };
  const recovery = createTaskExecutionRecovery({
    repository,
    bridge,
    ownerId: () => "owner",
    leaseOwner: "server",
    observeNativeTurn,
    goals: {},
    publish,
    unpause,
  } as unknown as Parameters<typeof createTaskExecutionRecovery>[0]);
  return {
    repository,
    observeNativeTurn,
    publish,
    unpause,
    bridge,
    recovery,
    retained,
    observed,
    task,
  };
}

describe("explicit native Task terminal recovery", () => {
  it("reads the canonical Task binding when the general Chat has no thread", async () => {
    const f = fixture();
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(f.observeNativeTurn).toHaveBeenCalledWith(
      f.retained.source.context,
      "original-native-turn",
    );
    expect(f.repository.tasks.failObservedNativeTurn).toHaveBeenCalledWith(
      "owner",
      "chat",
      f.retained,
      f.observed,
    );
    expect(f.publish).toHaveBeenCalledExactlyOnceWith("chat", "project");
    expect(f.unpause).not.toHaveBeenCalled();
  });
  it.each([
    [false, false],
    [true, true],
  ])(
    "does not acquire native recovery for resume=%s automatic=%s",
    async (resume, automatic) => {
      const f = fixture();
      expect(await f.recovery.recover("chat", resume, automatic)).toBe(false);
      expect(
        f.repository.tasks.captureNativeTurnRecovery,
      ).not.toHaveBeenCalled();
      expect(f.observeNativeTurn).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );
  it("does not observe or settle an unavailable canonical input", async () => {
    const f = fixture();
    f.repository.tasks.captureNativeTurnRecovery.mockResolvedValue(null);
    expect(await f.recovery.recover("chat", true)).toBe(false);
    expect(f.observeNativeTurn).not.toHaveBeenCalled();
    expect(f.repository.tasks.failObservedNativeTurn).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not publish when the transactional authority check rejects an observation", async () => {
    const f = fixture();
    f.repository.tasks.failObservedNativeTurn.mockResolvedValue(false);
    expect(await f.recovery.recover("chat", true)).toBe(false);
    expect(f.observeNativeTurn).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.unpause).not.toHaveBeenCalled();
  });
  it("retains uncertain execution after an observation failure and permits a later explicit observation", async () => {
    const f = fixture();
    f.observeNativeTurn.mockRejectedValueOnce(
      new Error("worker transport closed"),
    );
    await expect(f.recovery.recover("chat", true)).rejects.toThrow(
      "worker transport closed",
    );
    expect(f.repository.tasks.failObservedNativeTurn).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.recovery.recover("chat", true)).toBe(true);
    expect(f.observeNativeTurn).toHaveBeenCalledTimes(2);
    expect(f.repository.tasks.failObservedNativeTurn).toHaveBeenCalledTimes(1);
  });
  it("joins simultaneous explicit requests around one native observation and settlement", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.observeNativeTurn.mockImplementation(async () => {
      await gate;
      return f.observed;
    });
    const first = f.recovery.recover("chat", true),
      second = f.recovery.recover("chat", true);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(f.observeNativeTurn).toHaveBeenCalledTimes(1);
    expect(f.repository.tasks.failObservedNativeTurn).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not attach an offline worker or reinterpret an already settled dispatch", async () => {
    const f = fixture();
    f.bridge.isConnected.mockReturnValue(false);
    expect(await f.recovery.recover("chat", true)).toBe(false);
    f.bridge.isConnected.mockReturnValue(true);
    f.task.dispatch.state = "failed";
    expect(await f.recovery.recover("chat", true)).toBe(false);
    expect(f.observeNativeTurn).not.toHaveBeenCalled();
    expect(f.repository.tasks.failObservedNativeTurn).not.toHaveBeenCalled();
  });
});
