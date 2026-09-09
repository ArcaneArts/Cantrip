import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  CodexNativeRpcError,
  CodexTurnFailureError,
  type PrepareAdmittedNativeExecutionOptions,
  type RunAgentTurnOptions,
} from "../src/codex/app-server.js";

const options: PrepareAdmittedNativeExecutionOptions = {
  operationGeneration: "generation-a",
  threadId: "root",
  chatId: "chat",
  cwd: "/unused/cantrip-admitted-native-test",
  captureProtectedDiagnostics: false,
  model: {
    id: "model",
    routeId: "route",
    name: "gpt-5",
    reasoningEffort: null,
  },
  provider: {
    id: "provider",
    name: "ChatGPT",
    kind: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
    apiKey: null,
  },
};

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    handleMessage(data: Buffer): void;
    handleExit(error: Error): void;
    request(method: string, params: unknown): Promise<unknown>;
  };
  const request = vi
    .spyOn(native, "request")
    .mockImplementation(async (method) =>
      method === "turn/steer" ? { turnId: "turn-a" } : {},
    );
  const notify = (method: string, params: unknown) =>
    native.handleMessage(Buffer.from(JSON.stringify({ method, params })));
  const start = (threadId = "root", id = "turn-a") =>
    notify("turn/started", { threadId, turn: { id, startedAt: 1 } });
  const end = (id = "turn-a") =>
    notify("turn/completed", {
      threadId: "root",
      turn: {
        id,
        status: "completed",
        error: null,
        completedAt: 2,
        durationMs: 1,
      },
    });
  const resolve = (threadId = "root", turnId = "turn-a") =>
    runtime.resolveComputerUseExecution({ chatId: "chat", threadId, turnId });
  return { runtime, native, request, notify, start, end, resolve };
}

describe("native RPC rejection evidence", () => {
  it("keeps exact native initial settings on running and terminal summaries", async () => {
    const f = fixture();
    const activities: unknown[] = [];
    const execution = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onActivity: (activity) => activities.push(activity),
    });
    const initialSettings = {
      model: "native-selected",
      modelProvider: "native-provider",
      reasoningEffort: null,
      effectiveReasoningEffort: "low",
      serviceTier: "default",
      effectiveServiceTier: null,
      collaborationMode: "plan",
    };
    f.notify("turn/started", {
      threadId: "root",
      turn: { id: "turn-a", startedAt: 1 },
      initialSettings,
    });
    execution.bindReceipt({ turn: { id: "turn-a" } });
    f.end();
    await execution.completion;
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turnSummary",
          status: "running",
          initialSettings,
        }),
        expect.objectContaining({
          type: "turnSummary",
          status: "completed",
          initialSettings,
        }),
      ]),
    );
  });

  it("correlates the actual pending method when rejection responses arrive out of order", async () => {
    const f = fixture();
    f.request.mockRestore();
    const wire = f.runtime as unknown as {
      send(frame: { id: number; method: string }): void;
    };
    const frames: { id: number; method: string }[] = [];
    vi.spyOn(wire, "send").mockImplementation((frame) => {
      frames.push(frame);
    });
    const resume = f.native
      .request("thread/resume", { threadId: "root" })
      .catch((error) => error);
    const start = f.native
      .request("turn/start", { threadId: "root" })
      .catch((error) => error);
    for (const frame of [...frames].reverse()) {
      f.native.handleMessage(
        Buffer.from(
          JSON.stringify({
            id: frame.id,
            error: {
              code: -32001,
              message: "Could not decode the compaction blob",
              data: { phase: frame.method },
            },
          }),
        ),
      );
    }
    const [resumeError, startError] = await Promise.all([resume, start]);
    expect(resumeError).toBeInstanceOf(CodexNativeRpcError);
    expect(startError).toBeInstanceOf(CodexNativeRpcError);
    expect(resumeError).toMatchObject({
      requestMethod: "thread/resume",
      nativeError: { code: -32001, data: { phase: "thread/resume" } },
    });
    expect(startError).toMatchObject({
      requestMethod: "turn/start",
      nativeError: { code: -32001, data: { phase: "turn/start" } },
    });
  });
});

describe("admitted native execution registration", () => {
  it("pins a preallocated native attempt identity without granting authority before its start", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      expectedTurnId: "turn-a",
    });
    expect(f.resolve()).toBeNull();
    f.start("root", "stale-turn");
    expect(f.resolve("root", "stale-turn")).toBeNull();
    expect(f.resolve()).toBeNull();
    f.start();
    expect(f.resolve()).not.toBeNull();
    handle.fail(new Error("done"));
  });

  it("ends an admitted goal turn and never grants its unadmitted next turn authority", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.notify("thread/goal/updated", {
      threadId: "root",
      turnId: null,
      goal: {
        threadId: "root",
        objective: "continue",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    f.start();
    f.start("root", "unadmitted-next");
    expect(f.resolve("root", "unadmitted-next")).toBeNull();
    expect(f.resolve()).not.toBeNull();
    f.end();
    await expect(handle.completion).resolves.toMatchObject({
      turnId: "turn-a",
    });
    expect(handle.signal.aborted).toBe(true);
    f.start("root", "unadmitted-next");
    expect(f.resolve("root", "unadmitted-next")).toBeNull();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not grant idle notifications authority, then tracks actual root/child starts before the receipt", async () => {
    const f = fixture();
    f.start();
    expect(f.resolve()).toBeNull();
    const onActivity = vi.fn();
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onActivity,
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolve()).toBeNull();
    f.start();
    expect(f.resolve()).toMatchObject({
      operationGeneration: "generation-a",
      rootThreadId: "root",
      rootTurnId: "turn-a",
    });
    f.notify("thread/started", {
      thread: {
        id: "child",
        parentThreadId: "root",
        source: {
          subAgent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
        },
        status: { type: "active", activeFlags: [] },
      },
    });
    f.start("child", "child-turn");
    expect(f.resolve("child", "child-turn")).toMatchObject({
      operationGeneration: "generation-a",
      parentThreadId: "root",
    });
    handle.bindReceipt({ turn: { id: "turn-a" } });
    expect(onActivity).toHaveBeenCalled();
    expect(f.resolve("child", "foreign")).toBeNull();
    handle.fail(new Error("test done"));
    await expect(handle.completion).rejects.toThrow("test done");
    expect(f.resolve()).toBeNull();
  });

  it("reserves the root before forwarding and rejects racing registrations", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.runtime.prepareAdmittedNativeExecution(options),
      f.runtime.prepareAdmittedNativeExecution({
        ...options,
        operationGeneration: "generation-b",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(f.request).not.toHaveBeenCalled();
    const accepted = results.find((result) => result.status === "fulfilled")!;
    if (accepted.status !== "fulfilled")
      throw new Error("missing accepted execution");
    accepted.value.fail(new Error("test done"));
    await expect(accepted.value.completion).rejects.toThrow("test done");
  });

  it("uses real native Stop and steer for console-originated execution", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    const signal = f.resolve()!.signal;
    await f.runtime.steerThread("chat", "root", "continue");
    expect(f.request).toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ threadId: "root", expectedTurnId: "turn-a" }),
    );
    await expect(f.runtime.interruptChat("chat", "root")).resolves.toEqual({
      interrupted: true,
    });
    expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "root",
      turnId: "turn-a",
    });
    expect(signal.aborted).toBe(true);
    expect(handle.signal.aborted).toBe(false);
    handle.fail(new Error("test done"));
    await expect(handle.completion).rejects.toThrow("test done");
  });

  it("publishes deltas and terminal result before a delayed matching receipt without reviving authority", async () => {
    const f = fixture();
    const onMessage = vi.fn();
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onMessage,
    });
    f.start();
    f.notify("item/agentMessage/delta", {
      threadId: "root",
      turnId: "turn-a",
      itemId: "answer",
      delta: "Native answer",
    });
    f.end();
    await expect(handle.completion).resolves.toMatchObject({
      threadId: "root",
      turnId: "turn-a",
      text: "Native answer",
      status: "completed",
    });
    expect(onMessage).toHaveBeenCalled();
    expect(handle.signal.aborted).toBe(true);
    expect(() => handle.bindReceipt({ turn: { id: "turn-a" } })).not.toThrow();
    expect(f.resolve()).toBeNull();
  });

  it("does not let old failure, completion, or receipt release its replacement", async () => {
    const f = fixture();
    const first = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    first.fail(new Error("first ended"));
    await expect(first.completion).rejects.toThrow("first ended");
    const next = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      operationGeneration: "generation-b",
    });
    f.end(); // Old terminal before the replacement's start cannot initialize it.
    expect(next.signal.aborted).toBe(false);
    expect(f.resolve()).toBeNull();
    f.start("root", "turn-b");
    first.fail(new Error("late failure"));
    first.bindReceipt({ turn: { id: "turn-a" } });
    f.end();
    expect(f.resolve("root", "turn-b")).toMatchObject({
      operationGeneration: "generation-b",
    });
    next.assertCurrent();
    next.fail(new Error("test done"));
    await expect(next.completion).rejects.toThrow("test done");
  });

  it.each(["transport", "thread"])(
    "invalidates admission on %s closure",
    async (kind) => {
      const f = fixture();
      const handle = await f.runtime.prepareAdmittedNativeExecution(options);
      f.start();
      if (kind === "transport")
        f.native.handleExit(new Error("native disconnected"));
      else f.notify("thread/closed", { threadId: "root" });
      await expect(handle.completion).rejects.toThrow();
      expect(handle.signal.aborted).toBe(true);
      expect(() => handle.assertCurrent()).toThrow();
      expect(f.resolve()).toBeNull();
    },
  );

  it("rejects a native receipt that disagrees with the observed admitted start", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    expect(() => handle.bindReceipt({ turn: { id: "foreign" } })).toThrow(
      "does not match",
    );
    await expect(handle.completion).rejects.toThrow("does not match");
    expect(f.resolve()).toBeNull();
  });
});

describe("native autonomous gate callbacks", () => {
  const attempt = {
    threadId: "root",
    runnerGeneration: "runner",
    attemptId: "attempt",
    turnId: "turn-a",
    trigger: "goal",
    input: { threadSettings: {}, input: { ResponseItem: {} } },
  };
  it("routes the exact native snapshot without granting authority and aborts the handler on replacement", async () => {
    const f = fixture();
    const transport = vi
      .spyOn(f.runtime, "transportGeneration", "get")
      .mockReturnValue(null);
    const requested = vi.fn(async () => {});
    const handler = { requested, declined: vi.fn(), failed: vi.fn() };
    const registration = f.runtime.setManagedExecutionGateHandler(
      "runner",
      handler,
    )!;
    expect(registration.aborted).toBe(false);
    transport.mockReturnValue("native-a");
    f.notify("thread/managedExecution/requested", attempt);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());
    expect(requested.mock.calls[0][0]).toEqual(attempt);
    f.notify("thread/managedExecution/requested", attempt);
    await Promise.resolve();
    expect(requested).toHaveBeenCalledTimes(1);
    const signal = requested.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(f.resolve()).toBeNull();
    f.native.handleExit(new Error("closed"));
    expect(signal.aborted).toBe(true);
    expect(registration.aborted).toBe(true);
    transport.mockReturnValue("native-b");
    f.request.mockResolvedValue({ accepted: true });
    f.notify("thread/managedExecution/requested", {
      ...attempt,
      attemptId: "another",
    });
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith(
        "thread/managedExecution/resolve",
        expect.objectContaining({ allow: false, operationGeneration: null }),
      ),
    );
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it("uses owner transport fencing for resolve, invalidate and rearm without loading a thread", async () => {
    const f = fixture();
    const transport = vi
      .spyOn(f.runtime, "transportGeneration", "get")
      .mockReturnValue("native-a");
    f.request.mockImplementation(async (method) =>
      method.endsWith("resolve")
        ? { accepted: true }
        : method.endsWith("invalidate")
          ? { invalidated: true }
          : { bound: true },
    );
    await f.runtime.resolveManagedExecution(
      { ...attempt, operationGeneration: "operation", allow: true },
      "native-a",
    );
    expect(f.request).toHaveBeenLastCalledWith(
      "thread/managedExecution/resolve",
      {
        threadId: "root",
        runnerGeneration: "runner",
        attemptId: "attempt",
        operationGeneration: "operation",
        allow: true,
      },
    );
    await f.runtime.invalidateManagedExecution(
      { threadId: "root", runnerGeneration: "runner" },
      "native-a",
    );
    await f.runtime.bindManagedExecution(
      {
        threadId: "root",
        runnerGeneration: "next",
        expectedRunnerGeneration: "runner",
      },
      "native-a",
    );
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/managedExecution/resolve",
      "thread/managedExecution/invalidate",
      "thread/managedExecution/bind",
    ]);
    transport.mockReturnValue("native-b");
    await expect(
      f.runtime.resolveManagedExecution(
        { ...attempt, operationGeneration: "operation", allow: true },
        "native-a",
      ),
    ).rejects.toThrow("replaced native transport");
    expect(f.request).toHaveBeenCalledTimes(3);
  });
});

describe("GUI native mutation admission dispatch", () => {
  it("admits Stop for an idle bound runner without inventing a native turn", async () => {
    const f = fixture();
    const dispatcher = vi.fn(async (command) => command.dispatch());
    f.runtime.setManagedNativeCommandDispatcher("root", dispatcher);
    await expect(f.runtime.interruptChat("chat", "root")).resolves.toEqual({
      interrupted: false,
    });
    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId: "root" },
      }),
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolve()).toBeNull();
  });

  it("dispatches queued steer with the exact native vector, client identity and canonical claim", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    const dispatch = vi.fn(async (command) => command.dispatch());
    f.runtime.setManagedNativeCommandDispatcher("root", dispatch);
    const input = [
      {
        type: "text",
        text: "keep",
        text_elements: [
          { byteRange: { start: 0, end: 4 }, placeholder: "keep" },
        ],
      },
      { type: "mention", name: "reviewer", path: "agent://reviewer" },
    ];
    await f.runtime.steerThread(
      "chat",
      "root",
      "not a replacement",
      [],
      [],
      undefined,
      {
        operationId: "queued-steer",
        queueClaim: { id: "claim", promptRevision: 2 },
        input,
        clientUserMessageId: "native-client",
      },
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "queued-steer",
        queueClaim: { id: "claim", promptRevision: 2 },
        params: {
          threadId: "root",
          expectedTurnId: "turn-a",
          input,
          clientUserMessageId: "native-client",
        },
      }),
    );
    expect(f.request).toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ input, clientUserMessageId: "native-client" }),
    );
    handle.fail(new Error("done"));
  });

  it("waits for admitted pause, steer and Stop before dispatching exact native targets", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    const commands: import("../src/codex/app-server.js").ManagedNativeGuiCommand[] =
      [];
    const releases: (() => void)[] = [];
    f.runtime.setManagedNativeCommandDispatcher("root", async (command) => {
      commands.push(command);
      await new Promise<void>((resolve) => releases.push(resolve));
      return command.dispatch();
    });
    const pause = f.runtime.setActiveChatPaused("chat", true);
    expect(f.request).not.toHaveBeenCalled();
    expect(commands[0]).toMatchObject({
      method: "turn/pause",
      params: { threadId: "root", turnId: "turn-a", paused: true },
    });
    releases.shift()!();
    await pause;
    const steer = f.runtime.steerThread("chat", "root", "hello");
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(f.request).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await steer;
    const stop = f.runtime.interruptChat("chat", "root");
    expect(commands[2]).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "root", turnId: "turn-a" },
    });
    expect(f.request).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await stop;
    expect(f.request).toHaveBeenCalledTimes(3);
    handle.fail(new Error("done"));
  });

  it("does not send a delayed admitted control after its native turn was replaced", async () => {
    const f = fixture();
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    let release!: () => void;
    f.runtime.setManagedNativeCommandDispatcher("root", async (command) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return command.dispatch();
    });
    const stop = f.runtime.interruptChat("chat", "root");
    handle.fail(new Error("old ended"));
    const next = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      operationGeneration: "generation-b",
    });
    f.start("root", "turn-b");
    release();
    await expect(stop).rejects.toThrow("replaced turn");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolve("root", "turn-b")).not.toBeNull();
    next.fail(new Error("done"));
  });
});

describe("one admitted native reply ledger for GUI and console", () => {
  function interaction(
    f: ReturnType<typeof fixture>,
    id: string | number = 71,
  ) {
    f.native.handleMessage(
      Buffer.from(
        JSON.stringify({
          id,
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "root",
            turnId: "turn-a",
            itemId: "edit",
            startedAtMs: 1,
            reason: "native edit",
            grantRoot: null,
          },
        }),
      ),
    );
  }
  const identity = {
    operationGeneration: "generation-a",
    rootThreadId: "root",
    requestId: 71,
  };

  it("applies native resolution notifications to the exact typed request ID", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {});
    const cleared = vi.fn();
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onInteractionCleared: cleared,
    });
    try {
      f.start();
      interaction(f, 71);
      interaction(f, "71");
      const numeric = f.runtime.pendingAdmittedNativeReply(identity)!;
      const textual = f.runtime.pendingAdmittedNativeReply({
        ...identity,
        requestId: "71",
      })!;
      f.notify("serverRequest/resolved", { threadId: "root", requestId: "71" });
      expect(f.runtime.pendingAdmittedNativeReply(identity)).toEqual(numeric);
      expect(
        f.runtime.pendingAdmittedNativeReply({ ...identity, requestId: "71" }),
      ).toBeNull();
      expect(cleared).toHaveBeenCalledExactlyOnceWith(textual.requestKey);
      expect(send).not.toHaveBeenCalled();
    } finally {
      handle.fail(new Error("test done"));
      await expect(handle.completion).rejects.toThrow("test done");
    }
  });

  it("recovers failed native interaction publication without resending or ending the request", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {});
    const failedPublication = Promise.reject(
      new Error("fixture registration unavailable"),
    );
    // Observe the fixture promise so the regression is a missing retry, not an
    // unrelated unhandled-rejection crash in the test runner.
    void failedPublication.catch(() => {});
    const publish = vi
      .fn()
      .mockReturnValueOnce(failedPublication)
      .mockResolvedValue(undefined);
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onNativeInteractionRequest: publish,
    });
    try {
      f.start();
      interaction(f);
      const pending = f.runtime.pendingAdmittedNativeReply(identity)!;
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2), {
        timeout: 2500,
      });
      expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
      expect(f.runtime.pendingAdmittedNativeReply(identity)).toEqual(pending);
      expect(f.resolve()).not.toBeNull();
      expect(send).not.toHaveBeenCalled();
    } finally {
      handle.fail(new Error("test done"));
      await expect(handle.completion).rejects.toThrow("test done");
    }
  });

  it("waits for the actual native request and preserves it without a GUI callback", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {});
    const onNativeInteractionRequest = vi.fn();
    const handle = await f.runtime.prepareAdmittedNativeExecution({
      ...options,
      onNativeInteractionRequest,
    });
    f.start();
    const observed = f.runtime.awaitPendingAdmittedNativeReply(identity);
    interaction(f);
    const pending = await observed;
    expect(pending).toMatchObject({
      ...identity,
      threadId: "root",
      turnId: "turn-a",
      kind: "fileChange",
      requestMethod: "item/fileChange/requestApproval",
    });
    expect(onNativeInteractionRequest).toHaveBeenCalledWith(pending);
    expect(send).not.toHaveBeenCalled();
    expect(
      f.runtime.resolveAdmittedNativeReply({
        ...identity,
        response: { result: { decision: "accept" } },
      }),
    ).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      id: 71,
      result: { decision: "accept" },
    });
    await expect(
      f.runtime.answerAgentInteraction(pending.requestKey, {
        kind: "fileChange",
        decision: "accept",
      }),
    ).rejects.toThrow("no longer pending");
    await expect(
      f.runtime.awaitPendingAdmittedNativeReply(identity),
    ).rejects.toThrow();
    handle.fail(new Error("test done"));
    await expect(handle.completion).rejects.toThrow("test done");
  });

  it("rejects foreign generations and permits only one GUI/console resolution", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {});
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    interaction(f);
    const pending = f.runtime.pendingAdmittedNativeReply(identity)!;
    expect(
      f.runtime.pendingAdmittedNativeReply({
        ...identity,
        operationGeneration: "foreign",
      }),
    ).toBeNull();
    expect(() =>
      f.runtime.resolveAdmittedNativeReply({
        ...identity,
        rootThreadId: "foreign",
        response: { result: {} },
      }),
    ).toThrow();
    await f.runtime.answerAgentInteraction(pending.requestKey, {
      kind: "fileChange",
      decision: "decline",
    });
    expect(() =>
      f.runtime.resolveAdmittedNativeReply({
        ...identity,
        response: { result: { decision: "accept" } },
      }),
    ).toThrow("no longer pending");
    expect(send).toHaveBeenCalledTimes(1);
    handle.fail(new Error("test done"));
    await expect(handle.completion).rejects.toThrow("test done");
  });

  it("aborts pending observation with the operation and never replays an uncertain send", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {
        throw new Error("transport failed");
      });
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    const unobserved = f.runtime.awaitPendingAdmittedNativeReply({
      ...identity,
      requestId: 72,
    });
    interaction(f);
    expect(() =>
      f.runtime.resolveAdmittedNativeReply({
        ...identity,
        response: { result: { decision: "accept" } },
      }),
    ).toThrow("transport failed");
    expect(() =>
      f.runtime.resolveAdmittedNativeReply({
        ...identity,
        response: { result: { decision: "accept" } },
      }),
    ).toThrow("no longer pending");
    expect(send).toHaveBeenCalledTimes(1);
    handle.fail(new Error("test done"));
    await expect(unobserved).rejects.toThrow("ended before");
    await expect(handle.completion).rejects.toThrow("test done");
  });
  it("keeps numeric and string native IDs distinct in pending and resolved ledgers", async () => {
    const f = fixture();
    const send = vi
      .spyOn(f.native as unknown as { send(frame: unknown): void }, "send")
      .mockImplementation(() => {});
    const handle = await f.runtime.prepareAdmittedNativeExecution(options);
    f.start();
    interaction(f, 71);
    interaction(f, "71");
    const numeric = f.runtime.pendingAdmittedNativeReply(identity)!;
    const text = f.runtime.pendingAdmittedNativeReply({
      ...identity,
      requestId: "71",
    })!;
    expect(numeric.requestKey).not.toBe(text.requestKey);
    f.runtime.resolveAdmittedNativeReply({
      ...identity,
      response: { result: { decision: "decline" } },
    });
    expect(
      f.runtime.pendingAdmittedNativeReply({ ...identity, requestId: "71" }),
    ).toEqual(text);
    f.runtime.resolveAdmittedNativeReply({
      ...identity,
      requestId: "71",
      response: { result: { decision: "decline" } },
    });
    expect(
      send.mock.calls.map(([frame]) => (frame as { id: unknown }).id),
    ).toEqual([71, "71"]);
    handle.fail(new Error("test done"));
    await expect(handle.completion).rejects.toThrow("test done");
  });
});

describe("GUI admitted native dispatch hooks", () => {
  function guiOptions(): RunAgentTurnOptions {
    return {
      ...options,
      prompt: "GUI input",
      clientMessageId: "message",
      executionProfile: "ide",
      isPrimary: true,
      automationPaused: false,
      planMode: "default",
      policyContext: null,
      permissionProfileId: ":workspace",
      rootKind: null,
      skillNames: [],
      subagentDefaults: null,
      subagentProtocolVersion: undefined,
      worktreeMode: null,
      worktreePolicy: null,
    };
  }
  function setup() {
    const f = fixture();
    const runtime = f.runtime as unknown as {
      ensureStarted(): Promise<void>;
      loadThread(): Promise<string>;
    };
    vi.spyOn(runtime, "ensureStarted").mockResolvedValue();
    vi.spyOn(runtime, "loadThread").mockResolvedValue("root");
    return f;
  }
  it("sends the queued native input vector unchanged through actual GUI turn/start", async () => {
    const f = setup();
    const input = [
      {
        type: "text",
        text: "native text",
        text_elements: [
          { byteRange: { start: 0, end: 6 }, placeholder: "native" },
        ],
      },
      { type: "skill", name: "chosen", path: "/actual/skill" },
      { type: "image", url: "https://fixture/image" },
    ];
    f.request.mockImplementation(async (method) => {
      if (method !== "turn/start") return {};
      f.start();
      f.end();
      return { turn: { id: "turn-a" } };
    });
    await f.runtime.runTurn({
      ...guiOptions(),
      nativeInput: input,
      nativeClientUserMessageId: "queued-native-client",
      skillNames: ["must-not-infer-extra"],
    });
    expect(f.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        input,
        clientUserMessageId: "queued-native-client",
      }),
    );
  });

  it("retains typed native failure after systemError before the GUI turn/start acknowledgment", async () => {
    const f = setup();
    f.request.mockImplementation(async (method) => {
      if (method !== "turn/start") return {};
      f.start("root", "fast-turn");
      f.notify("thread/status/changed", {
        threadId: "root",
        status: { type: "systemError" },
      });
      expect(f.resolve("root", "fast-turn")).toBeNull();
      f.notify("turn/completed", {
        threadId: "root",
        turn: {
          id: "fast-turn",
          status: "failed",
          error: {
            message: "Model at capacity",
            codexErrorInfo: "serverOverloaded",
          },
        },
      });
      return { turn: { id: "fast-turn" } };
    });
    await expect(f.runtime.runTurn(guiOptions())).rejects.toMatchObject({
      reasonCode: "serverOverloaded",
      threadId: "root",
      turnId: "fast-turn",
    });
    expect(f.resolve("root", "fast-turn")).toBeNull();
  });

  it("rejects a cancelled old preparation after load without registering over a newer native turn", async () => {
    const f = setup();
    const oldController = new AbortController();
    let finishOldLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishOldLoad = resolve;
    });
    const loader = f.runtime as unknown as { loadThread(): Promise<string> };
    vi.mocked(loader.loadThread).mockImplementationOnce(async () => {
      await gate;
      return "root";
    });
    f.request.mockImplementation(async (method) =>
      method === "turn/start" ? { turn: { id: "new-turn" } } : {},
    );
    const old = f.runtime.runTurn({
      ...guiOptions(),
      preparationSignal: oldController.signal,
    });
    const rejected = expect(old).rejects.toThrow("cancelled old root");
    await vi.waitFor(() => expect(loader.loadThread).toHaveBeenCalledOnce());
    const newer = f.runtime.runTurn({
      ...guiOptions(),
      operationGeneration: "new-generation",
    });
    await vi.waitFor(() =>
      expect(f.resolve("root", "new-turn")?.operationGeneration).toBe(
        "new-generation",
      ),
    );
    oldController.abort(new Error("cancelled old root"));
    finishOldLoad();
    await rejected;
    expect(f.resolve("root", "new-turn")?.operationGeneration).toBe(
      "new-generation",
    );
    expect(
      f.request.mock.calls.filter(([method]) => method === "turn/start"),
    ).toHaveLength(1);
    f.end("new-turn");
    await newer;
  });

  it("honors exact cancellation that arrives before runTurn starts", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before preparation"));
    const prepare = vi.fn(async () => ({}));
    await expect(
      f.runtime.runTurn({
        ...guiOptions(),
        preparationSignal: controller.signal,
        onBeforeFirstAttempt: prepare,
      }),
    ).rejects.toThrow("cancelled before preparation");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("retries an actual initial managed resume rejection before any model dispatch", async () => {
    const f = setup();
    const error = new CodexNativeRpcError(
      "Could not decode the compaction blob",
      { code: -32001, message: "Could not decode the compaction blob" },
      "thread/resume",
    );
    const prepare = vi.fn(async () => {
      throw error;
    });
    const attempt = vi
      .spyOn(
        f.runtime as unknown as {
          runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
        },
        "runTurnAttempt",
      )
      .mockResolvedValue({ turnId: "replacement-turn" });
    const renew = vi.fn(async () => ({
      operationGeneration: "replacement-generation",
      threadId: "replacement-thread",
    }));
    await expect(
      f.runtime.runTurn({
        ...guiOptions(),
        onBeforeFirstAttempt: prepare,
        onBeforeRetry: renew,
      }),
    ).resolves.toEqual({ turnId: "replacement-turn" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid-compaction",
        threadId: "root",
        turnId: null,
        error,
      }),
    );
    expect(attempt).toHaveBeenCalledOnce();
    expect(attempt.mock.calls[0]![0]).toMatchObject({
      threadId: "replacement-thread",
      operationGeneration: "replacement-generation",
    });
  });

  it("keeps Stop cancellation active from initial preparation through replacement admission", async () => {
    const f = setup();
    let preparedSignal!: AbortSignal;
    let retrySignal!: AbortSignal;
    let finishRenew!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRenew = resolve;
    });
    const attempt = vi.spyOn(
      f.runtime as unknown as {
        runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
      },
      "runTurnAttempt",
    );
    const running = f.runtime.runTurn({
      ...guiOptions(),
      onBeforeFirstAttempt: async (signal) => {
        preparedSignal = signal;
        throw new CodexNativeRpcError(
          "Could not decode the compaction blob",
          { code: -32001, message: "Could not decode the compaction blob" },
          "thread/resume",
        );
      },
      onBeforeRetry: async (retry) => {
        retrySignal = retry.signal;
        await gate;
        return {
          operationGeneration: "replacement-generation",
          threadId: "replacement-thread",
        };
      },
    });
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(retrySignal).toBeDefined());
    expect(retrySignal).toBe(preparedSignal);
    await expect(f.runtime.interruptChat("chat", "root")).resolves.toEqual({
      interrupted: true,
    });
    expect(preparedSignal.aborted).toBe(true);
    finishRenew();
    await rejected;
    expect(attempt).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not dispatch a turn when Stop wins an initial preparation response", async () => {
    const f = setup();
    let finishPrepare!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
    const prepare = vi.fn(async () => {
      await gate;
      return { threadId: "prepared-thread" };
    });
    const attempt = vi.spyOn(
      f.runtime as unknown as {
        runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
      },
      "runTurnAttempt",
    );
    const running = f.runtime.runTurn({
      ...guiOptions(),
      onBeforeFirstAttempt: prepare,
    });
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await expect(f.runtime.interruptChat("chat", "root")).resolves.toEqual({
      interrupted: true,
    });
    finishPrepare();
    await rejected;
    expect(attempt).not.toHaveBeenCalled();
  });

  it("lets fresh admission replace a corrupt native thread instead of silently changing the managed identity", async () => {
    const f = setup();
    const error = new Error("Could not decode the compaction blob");
    const attempt = vi
      .spyOn(
        f.runtime as unknown as {
          runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
        },
        "runTurnAttempt",
      )
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ turnId: "new-turn" });
    const renew = vi.fn(async () => ({
      operationGeneration: "replacement-generation",
      threadId: "replacement-thread",
    }));
    await expect(
      f.runtime.runTurn({ ...guiOptions(), onBeforeRetry: renew }),
    ).resolves.toEqual({ turnId: "new-turn" });
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid-compaction",
        operationGeneration: "generation-a",
        threadId: "root",
        turnId: null,
        nextThreadId: null,
        error,
      }),
    );
    expect(attempt.mock.calls[1][0]).toMatchObject({
      operationGeneration: "replacement-generation",
      threadId: "replacement-thread",
    });
  });

  it("surfaces the actual failed native attempt when no fresh managed retry hook exists", async () => {
    const f = setup();
    const error = new CodexTurnFailureError(
      "overloaded",
      "serverOverloaded",
      "actual-root",
      "actual-turn",
    );
    const attempt = vi
      .spyOn(
        f.runtime as unknown as {
          runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
        },
        "runTurnAttempt",
      )
      .mockRejectedValue(error);
    await expect(f.runtime.runTurn(guiOptions())).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("obtains fresh per-attempt options only after the delay and preserves exact failed identities", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const error = new CodexTurnFailureError(
        "overloaded",
        "serverOverloaded",
        "actual-root",
        "actual-turn",
      );
      const attempt = vi
        .spyOn(
          f.runtime as unknown as {
            runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
          },
          "runTurnAttempt",
        )
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ turnId: "next-turn" });
      const freshDispatch = vi.fn(async () => {});
      const renew = vi.fn(async () => ({
        operationGeneration: "generation-b",
        threadId: "actual-root",
        onBeforeNativeDispatch: freshDispatch,
      }));
      const result = f.runtime.runTurn({
        ...guiOptions(),
        onBeforeRetry: renew,
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(renew).not.toHaveBeenCalled();
      expect(attempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ turnId: "next-turn" });
      expect(renew).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "capacity",
          attempt: 2,
          operationGeneration: "generation-a",
          threadId: "actual-root",
          turnId: "actual-turn",
          error,
        }),
      );
      expect(attempt.mock.calls[1][0]).toMatchObject({
        operationGeneration: "generation-b",
        threadId: "actual-root",
        onBeforeNativeDispatch: freshDispatch,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Stop cancel fresh admission after the retry delay without sending another turn", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const error = new CodexTurnFailureError(
        "overloaded",
        "serverOverloaded",
        "root",
        "turn-a",
      );
      const attempt = vi
        .spyOn(
          f.runtime as unknown as {
            runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
          },
          "runTurnAttempt",
        )
        .mockRejectedValue(error);
      let finish!: () => void;
      let retrySignal!: AbortSignal;
      const renewal = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const result = f.runtime.runTurn({
        ...guiOptions(),
        onBeforeRetry: async (retry) => {
          retrySignal = retry.signal;
          await renewal;
          return { operationGeneration: "generation-b" };
        },
      });
      const rejected = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10000);
      expect(retrySignal.aborted).toBe(false);
      await f.runtime.interruptChat("chat", "root");
      expect(retrySignal.aborted).toBe(true);
      finish();
      await rejected;
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a managed attempt when renewal returns the same generation", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const error = new CodexTurnFailureError(
        "overloaded",
        "serverOverloaded",
        "root",
        "turn-a",
      );
      const attempt = vi
        .spyOn(
          f.runtime as unknown as {
            runTurnAttempt(options: RunAgentTurnOptions): Promise<unknown>;
          },
          "runTurnAttempt",
        )
        .mockRejectedValue(error);
      const result = f.runtime.runTurn({
        ...guiOptions(),
        onBeforeRetry: async () => ({ operationGeneration: "generation-a" }),
      });
      const rejected = expect(result).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers ownership, checks dispatch, and reports actual receipt before terminal completion", async () => {
    const f = setup();
    const order: string[] = [];
    f.request.mockImplementation(async (method) => {
      if (method !== "turn/start") throw new Error(`unexpected ${method}`);
      order.push("native");
      f.start();
      expect(f.resolve()).toMatchObject({
        operationGeneration: "generation-a",
      });
      return { turn: { id: "turn-a" } };
    });
    const result = f.runtime.runTurn({
      ...guiOptions(),
      onBeforeNativeDispatch: async (threadId) => {
        expect(threadId).toBe("root");
        order.push("dispatch");
      },
      onNativeReceipt: async (receipt) => {
        expect(receipt).toEqual({ turn: { id: "turn-a" } });
        order.push("receipt");
      },
    });
    await vi.waitFor(() =>
      expect(order).toEqual(["dispatch", "native", "receipt"]),
    );
    f.end();
    await expect(result).resolves.toMatchObject({
      turnId: "turn-a",
      status: "completed",
    });
  });
  it("never forwards a GUI mutation whose immediate dispatch check fails", async () => {
    const f = setup();
    await expect(
      f.runtime.runTurn({
        ...guiOptions(),
        onBeforeNativeDispatch: async () => {
          throw new Error("admission revoked");
        },
      }),
    ).rejects.toThrow("admission revoked");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolve()).toBeNull();
  });
});
