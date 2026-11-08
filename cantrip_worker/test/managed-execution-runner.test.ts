import { describe, expect, it, vi } from "vitest";
import type { ManagedExecutionGateHandler } from "../src/codex/app-server.js";
import { ManagedExecutionRunner } from "../src/codex/managed-execution-runner.js";

function fixture(transport: string | null = "runtime-1") {
  const handlers = new Map<string, ManagedExecutionGateHandler>();
  const registrations = new Map<string, AbortController>();
  const runtime = {
    transportGeneration: transport,
    setManagedExecutionGateHandler: vi.fn(
      (generation: string, handler: ManagedExecutionGateHandler | null) => {
        registrations.get(generation)?.abort();
        if (handler) handlers.set(generation, handler);
        else handlers.delete(generation);
        const registration = new AbortController();
        registrations.set(generation, registration);
        return handler ? registration.signal : null;
      },
    ),
    invalidateManagedExecution: vi.fn(async () => ({
      invalidated: true as const,
    })),
    controlManagedRootProducer: vi.fn(async () => ({
      revision: "0",
      heldBy: null,
    })),
    bindManagedExecution: vi.fn(async () => ({ bound: true as const })),
  };
  const handler = {
    requested: vi.fn<ManagedExecutionGateHandler["requested"]>(async () => {}),
    declined: vi.fn(),
    failed: vi.fn(),
  };
  const runner = new ManagedExecutionRunner(runtime, null, handler);
  return { runtime, handlers, handler, runner, registrations };
}

describe("managed execution runner", () => {
  it("registers before transport startup without starting a turn or binding a second thread", async () => {
    const f = fixture(null);
    expect(f.handlers.has(f.runner.configuration.runnerGeneration)).toBe(true);
    expect(f.runtime.bindManagedExecution).not.toHaveBeenCalled();
    expect(f.handler.requested).not.toHaveBeenCalled();
    f.runtime.transportGeneration = "runtime-1";
    f.runner.prepared("thread-1");
    expect(() => f.runner.prepared("thread-2")).toThrow(
      "another native thread",
    );
  });

  it("aborts a waiting admission and invalidates the native gate before Stop may proceed", async () => {
    const f = fixture();
    const generation = f.runner.configuration.runnerGeneration;
    let admittedSignal: AbortSignal | undefined;
    f.handler.requested.mockImplementation(async (_attempt, signal) => {
      admittedSignal = signal;
    });
    await f.handlers.get(generation)!.requested(
      {
        threadId: "thread-1",
        runnerGeneration: generation,
        attemptId: "attempt-1",
        turnId: "turn-1",
        trigger: "queue",
        input: {},
      },
      new AbortController().signal,
    );
    let finishInvalidation!: () => void;
    f.runtime.invalidateManagedExecution.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishInvalidation = resolve;
      });
      return { invalidated: true };
    });
    const nativeStop = vi.fn();
    const stopping = f.runner
      .beforeNativeDispatch("turn/interrupt", "thread-1", "runtime-1")
      .then(nativeStop);
    await vi.waitFor(() => expect(admittedSignal?.aborted).toBe(true));
    expect(nativeStop).not.toHaveBeenCalled();
    finishInvalidation();
    await stopping;
    expect(f.runtime.invalidateManagedExecution).toHaveBeenCalledWith(
      { threadId: "thread-1", runnerGeneration: generation },
      "runtime-1",
    );
    expect(nativeStop).toHaveBeenCalledOnce();
  });

  it.each(["thread/goal/clear", "thread/goal/set"])(
    "invalidates a pending first-goal attempt before %s and rearms only on explicit resume",
    async (method) => {
      const f = fixture();
      const previous = f.runner.configuration.runnerGeneration;
      let signal: AbortSignal | undefined;
      f.handler.requested.mockImplementation(async (_attempt, value) => {
        signal = value;
      });
      await f.handlers.get(previous)!.requested(
        {
          threadId: "thread-1",
          runnerGeneration: previous,
          attemptId: "attempt",
          turnId: "turn",
          trigger: "goal",
          goalEpoch: "goal:1",
          input: {},
        },
        new AbortController().signal,
      );
      await f.runner.beforeNativeDispatch(
        method,
        "thread-1",
        "runtime-1",
        false,
        true,
      );
      expect(signal?.aborted).toBe(true);
      expect(f.runtime.invalidateManagedExecution).toHaveBeenCalledOnce();
      expect(f.runtime.bindManagedExecution).not.toHaveBeenCalled();
      await f.runner.beforeNativeDispatch(
        "thread/goal/set",
        "thread-1",
        "runtime-1",
        true,
      );
      expect(f.runner.configuration.runnerGeneration).not.toBe(previous);
      expect(f.runtime.bindManagedExecution).toHaveBeenCalledOnce();
    },
  );

  it("only rearms on an explicit autonomous start and keeps late decline delivery", async () => {
    const f = fixture();
    const previous = f.runner.configuration.runnerGeneration;
    await f.runner.beforeNativeDispatch(
      "turn/interrupt",
      "thread-1",
      "runtime-1",
    );
    f.runner.prepared("thread-1");
    await f.runner.beforeNativeDispatch("turn/start", "thread-1", "runtime-1");
    expect(f.runtime.bindManagedExecution).not.toHaveBeenCalled();
    await f.runner.beforeNativeDispatch(
      "thread/queue/start",
      "thread-1",
      "runtime-1",
      true,
    );
    const next = f.runner.configuration.runnerGeneration;
    expect(next).not.toBe(previous);
    expect(f.runtime.bindManagedExecution).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        runnerGeneration: next,
        expectedRunnerGeneration: previous,
      },
      "runtime-1",
    );
    const decline = {
      threadId: "thread-1",
      runnerGeneration: previous,
      attemptId: "attempt-1",
      turnId: "turn-1",
      operationGeneration: "operation-1",
      reason: "stopped",
    };
    await f.handlers.get(previous)!.declined(decline);
    expect(f.handler.declined).toHaveBeenCalledWith(decline);
  });

  it.each(["turn/interrupt", "thread/goal/clear"])(
    "rearms an explicitly admitted compaction after %s without restoring its old admission",
    async (method) => {
      const f = fixture();
      const previous = f.runner.configuration.runnerGeneration;
      await f.runner.beforeNativeDispatch(
        method,
        "thread-1",
        "runtime-1",
        false,
        method === "thread/goal/clear",
      );
      await f.runner.beforeNativeDispatch(
        "thread/compact/start",
        "thread-1",
        "runtime-1",
      );
      const next = f.runner.configuration.runnerGeneration;
      expect(next).not.toBe(previous);
      expect(f.runtime.bindManagedExecution).toHaveBeenCalledExactlyOnceWith(
        {
          threadId: "thread-1",
          runnerGeneration: next,
          expectedRunnerGeneration: previous,
        },
        "runtime-1",
      );
      await expect(async () =>
        f.handlers.get(previous)!.requested(
          {
            threadId: "thread-1",
            runnerGeneration: previous,
            attemptId: "stale-attempt",
            turnId: "stale-turn",
            trigger: "queue",
            input: {},
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(f.handler.requested).not.toHaveBeenCalled();
    },
  );

  it.each(["thread/goal/set", "thread/compact/start"])(
    "reconciles an uncertain %s bind with the same tuple on the next explicit request",
    async (method) => {
      const f = fixture();
      await f.runner.beforeNativeDispatch(
        "turn/interrupt",
        "thread-1",
        "runtime-1",
      );
      f.runtime.bindManagedExecution.mockRejectedValueOnce(
        new Error("connection response lost"),
      );
      await expect(
        f.runner.beforeNativeDispatch(
          method,
          "thread-1",
          "runtime-1",
          method === "thread/goal/set",
        ),
      ).rejects.toThrow("response lost");
      const first = f.runtime.bindManagedExecution.mock.calls[0];
      await f.runner.beforeNativeDispatch(
        method,
        "thread-1",
        "runtime-1",
        method === "thread/goal/set",
      );
      expect(f.runtime.bindManagedExecution.mock.calls[1]).toEqual(first);
    },
  );

  it.each(["turn/interrupt", "thread/compact/start"])(
    "rejects a replaced transport before %s has any native side effect",
    async (method) => {
      const f = fixture();
      f.runner.prepared("thread-1");
      f.runtime.transportGeneration = "runtime-2";
      expect(f.runner.belongsToCurrentTransport()).toBe(false);
      await expect(
        f.runner.beforeNativeDispatch(method, "thread-1", "runtime-1"),
      ).rejects.toThrow("replaced native transport");
      expect(f.runtime.invalidateManagedExecution).not.toHaveBeenCalled();
    },
  );

  it("does not reuse a pre-start handler cleared by an unsuccessful runtime startup", () => {
    const f = fixture(null);
    f.registrations.get(f.runner.configuration.runnerGeneration)!.abort();
    expect(f.runner.belongsToCurrentTransport()).toBe(false);
  });

  it("keeps a stopped runner closed for non-resuming goal changes", async () => {
    const f = fixture();
    await f.runner.beforeNativeDispatch(
      "turn/interrupt",
      "thread-1",
      "runtime-1",
    );
    await f.runner.beforeNativeDispatch(
      "thread/goal/set",
      "thread-1",
      "runtime-1",
      false,
    );
    expect(f.runtime.bindManagedExecution).not.toHaveBeenCalled();
    await f.runner.beforeNativeDispatch(
      "turn/pause",
      "thread-1",
      "runtime-1",
      true,
    );
    expect(f.runtime.bindManagedExecution).toHaveBeenCalledOnce();
  });
});
