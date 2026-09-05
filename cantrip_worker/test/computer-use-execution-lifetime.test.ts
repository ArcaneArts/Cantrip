import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
import { CodexExecutionLifetime } from "../src/codex/execution-lifetime.js";

describe("observed Codex turn lifetime", () => {
  it("keeps one signal per turn and cannot revive its terminal signal", () => {
    const lifetime = new CodexExecutionLifetime();
    expect(lifetime.signal("turn")).toBeNull();
    lifetime.observe("turn");
    const signal = lifetime.signal("turn")!;
    lifetime.observe("turn");
    expect(lifetime.signal("turn")).toBe(signal);
    expect(lifetime.signal("another")).toBeNull();
    lifetime.abort();
    lifetime.observe("turn");
    expect(signal.aborted).toBe(true);
    expect(lifetime.signal("turn")).toBeNull();
    lifetime.observe("next");
    expect(lifetime.signal("next")?.aborted).toBe(false);
  });

  it("aborts the previous signal before replacing a turn", () => {
    const lifetime = new CodexExecutionLifetime();
    lifetime.observe("first");
    const first = lifetime.signal("first")!;
    lifetime.observe("second");
    expect(first.aborted).toBe(true);
    expect(lifetime.signal("first")).toBeNull();
    expect(lifetime.signal("second")?.aborted).toBe(false);
    expect(lifetime.abort("first")).toBe(false);
    expect(lifetime.signal("second")?.aborted).toBe(false);
  });

  it("remembers a terminal event which arrives before its start acknowledgement", () => {
    const lifetime = new CodexExecutionLifetime();
    lifetime.abort("first");
    lifetime.observe("first");
    expect(lifetime.signal("first")).toBeNull();
    lifetime.observe("second");
    expect(lifetime.signal("second")?.aborted).toBe(false);
  });
});

// Drive the existing native notification receiver directly. No process, model,
// filesystem, CUA helper or permission prompt is needed for these state tests.
function fixture(executionKind = "chat") {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    registerRootExecution(active: unknown): void;
    bindTurnStartResponse(turnId: string, active: unknown): void;
    handleMessage(data: Buffer): void;
    releaseActiveTurn(active: unknown, turnId?: string): boolean;
    handleExit(error: Error): void;
    request(method: string, params: unknown): Promise<unknown>;
    completeTurn(
      active: unknown,
      turnId: string,
      at: number,
      diagnostic: string | null,
    ): Promise<void>;
    failTurn(active: unknown, turnId: string, error: Error): Promise<void>;
    reconcileSubagentExecution(): Promise<void>;
    settleDescendantsAtRootBoundary(): void;
  };
  const active = {
    chatId: "chat",
    threadId: "root",
    executionKind,
    agentScope: null,
    baseline: new Map(),
    captureProtectedDiagnostics: false,
    commandTelemetry: new Map(),
    completedCommandIds: new Set(),
    cwd: "/unused",
    delta: "",
    diffChanges: [],
    durationMs: null,
    fileStartedAtMs: new Map(),
    finalText: null,
    interactionMode: "interactive",
    interruptionRequestedAtMs: null,
    itemStartedAtMs: new Map(),
    latestUsage: null,
    liveAgentMessageFingerprints: new Set(),
    observedActivityFingerprints: new Set(),
    pendingActivities: new Map(),
    pendingAgentMessage: null,
    reasoningSummaries: new Map(),
    startedAtMs: 1,
    streamingAgentMessage: null,
    structuredChat: false,
    timeout: null,
    resolve: vi.fn(),
    reject: vi.fn(),
  };
  native.registerRootExecution(active);
  native.bindTurnStartResponse("root-turn", active);
  const notify = (method: string, params: unknown) =>
    native.handleMessage(Buffer.from(JSON.stringify({ method, params })));
  const start = (threadId: string, turnId: string) =>
    notify("turn/started", {
      threadId,
      turn: { id: turnId, startedAt: 1 },
    });
  const child = (threadId = "child", parentThreadId = "root") => {
    notify("thread/started", {
      thread: {
        id: threadId,
        parentThreadId,
        status: { type: "active", activeFlags: [] },
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: parentThreadId, depth: 1 },
          },
        },
      },
    });
    start(threadId, `${threadId}-turn`);
  };
  const resolve = (threadId = "root", turnId = "root-turn", chatId = "chat") =>
    runtime.resolveComputerUseExecution({ chatId, threadId, turnId });
  const complete = (threadId: string, turnId: string, status = "completed") =>
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status,
        completedAt: 2,
        durationMs: 1,
        error: null,
      },
    });
  return { runtime, native, active, notify, start, child, resolve, complete };
}

describe("Codex runtime computer-use scope", () => {
  it("returns exact root and nested child ownership with stable live signals", () => {
    const f = fixture();
    f.child();
    f.child("nested", "child");
    expect(f.resolve()).toMatchObject({
      chatId: "chat",
      threadId: "root",
      turnId: "root-turn",
      rootThreadId: "root",
      rootTurnId: "root-turn",
      parentThreadId: null,
    });
    expect(f.resolve("nested", "nested-turn")).toMatchObject({
      chatId: "chat",
      threadId: "nested",
      turnId: "nested-turn",
      rootThreadId: "root",
      rootTurnId: "root-turn",
      parentThreadId: "child",
    });
    expect(f.resolve()?.signal).toBe(f.resolve()?.signal);
    expect(Object.keys(f.resolve()!)).not.toContain("ownerId");
    expect(Object.keys(f.resolve()!)).not.toContain("taskId");
    expect(Object.keys(f.resolve()!)).not.toContain("executionLaneId");
    f.runtime.close();
  });

  it("recognizes owned native children before their first turn without granting turn authority", () => {
    const f = fixture();
    expect(f.runtime.ownsComputerUseThread("root", "root")).toBe(true);
    expect(f.runtime.ownsComputerUseThread("root", "unknown")).toBe(false);
    f.notify("thread/started", {
      thread: {
        id: "pending-child",
        parentThreadId: "root",
        status: { type: "active", activeFlags: [] },
        source: {
          subAgent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
        },
      },
    });
    expect(f.runtime.ownsComputerUseThread("root", "pending-child")).toBe(true);
    expect(f.resolve("pending-child", "unobserved-turn")).toBeNull();
    f.child("nested", "pending-child");
    expect(f.runtime.ownsComputerUseThread("root", "nested")).toBe(true);
    expect(f.runtime.ownsComputerUseThread("pending-child", "nested")).toBe(
      false,
    );
    f.runtime.close();
    expect(f.runtime.ownsComputerUseThread("root", "pending-child")).toBe(
      false,
    );
  });

  it("keeps native ownership scoped to the actual root when multiple chats share a runtime", () => {
    const f = fixture();
    f.child();
    const other = { ...f.active, chatId: "other-chat", threadId: "other-root" };
    f.native.registerRootExecution(other);
    f.native.bindTurnStartResponse("other-turn", other);
    f.child("other-child", "other-root");
    expect(f.runtime.ownsComputerUseThread("root", "child")).toBe(true);
    expect(f.runtime.ownsComputerUseThread("root", "other-child")).toBe(false);
    expect(f.runtime.ownsComputerUseThread("other-root", "child")).toBe(false);
    expect(f.runtime.ownsComputerUseThread("other-root", "other-child")).toBe(
      true,
    );
    expect(f.runtime.ownsComputerUseThread("unknown-root", "other-child")).toBe(
      false,
    );
    f.native.releaseActiveTurn(other);
    expect(f.runtime.ownsComputerUseThread("other-root", "other-child")).toBe(
      false,
    );
    expect(f.runtime.ownsComputerUseThread("root", "child")).toBe(true);
    f.runtime.close();
  });

  it("rejects missing, wrong-chat, wrong-turn and operation scopes without rebinding", () => {
    const f = fixture();
    f.child();
    const signal = f.resolve()!.signal;
    expect(f.resolve("unknown", "root-turn")).toBeNull();
    expect(f.resolve("root", "invented")).toBeNull();
    expect(f.resolve("root", "root-turn", "other-chat")).toBeNull();
    expect(f.resolve("child", "root-turn")).toBeNull();
    expect(f.resolve()?.signal).toBe(signal);
    expect(signal.aborted).toBe(false);
    f.runtime.close();
    const operation = fixture("operation");
    expect(operation.resolve()).toBeNull();
    operation.runtime.close();
  });

  it("ends only a completed child turn and rejects a late same-turn notification", () => {
    const f = fixture();
    f.child();
    const child = f.resolve("child", "child-turn")!.signal;
    const root = f.resolve()!.signal;
    f.complete("child", "child-turn");
    expect(child.aborted).toBe(true);
    expect(root.aborted).toBe(false);
    f.start("child", "child-turn");
    expect(f.resolve("child", "child-turn")).toBeNull();
    // The real next turn, not the previous turn's late message, gets a new lease.
    f.complete("child", "child-turn");
    f.start("child", "child-next");
    expect(f.resolve("child", "child-next")?.signal.aborted).toBe(false);
    f.runtime.close();
  });

  it("aborts root and children before async completion even when the execution is retained", async () => {
    const f = fixture();
    f.child();
    const root = f.resolve()!.signal;
    const child = f.resolve("child", "child-turn")!.signal;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completeTurn = vi
      .spyOn(f.native, "completeTurn")
      .mockReturnValue(completion);
    f.complete("root", "root-turn");
    expect(completeTurn).toHaveBeenCalledOnce();
    expect(root.aborted).toBe(true);
    expect(child.aborted).toBe(true);
    expect(f.resolve()).toBeNull();
    f.native.bindTurnStartResponse("root-turn", f.active);
    expect(f.resolve()).toBeNull();
    f.start("root", "next-root-turn");
    expect(f.resolve("root", "next-root-turn")?.signal.aborted).toBe(false);
    expect(f.resolve("child", "child-turn")).toBeNull();
    finish();
    await completion;
    f.runtime.close();
  });

  it("aborts root and child authority on replacement and release", () => {
    const f = fixture();
    f.child();
    const root = f.resolve()!.signal;
    const child = f.resolve("child", "child-turn")!.signal;
    f.start("root", "replacement");
    expect(root.aborted).toBe(true);
    expect(child.aborted).toBe(true);
    const replacement = f.resolve("root", "replacement")!.signal;
    f.native.releaseActiveTurn(f.active);
    expect(replacement.aborted).toBe(true);
    expect(f.resolve("root", "replacement")).toBeNull();
    f.runtime.close();
  });

  it("ignores old root telemetry, completion and start acknowledgement after a genuine newer turn", () => {
    const f = fixture();
    const completeTurn = vi.spyOn(f.native, "completeTurn").mockResolvedValue();
    const old = f.resolve()!.signal;
    f.complete("root", "root-turn");
    f.start("root", "new-root-turn");
    const current = f.resolve("root", "new-root-turn")!.signal;
    f.notify("item/started", {
      threadId: "root",
      turnId: "root-turn",
      item: {
        type: "agentMessage",
        id: "old-item",
        text: "late",
        phase: "commentary",
      },
    });
    expect(f.resolve()).toBeNull();
    expect(f.resolve("root", "new-root-turn")?.signal).toBe(current);
    f.complete("root", "root-turn");
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(f.native.releaseActiveTurn(f.active, "root-turn")).toBe(false);
    f.native.bindTurnStartResponse("root-turn", f.active);
    expect(old.aborted).toBe(true);
    expect(current.aborted).toBe(false);
    expect(f.active.agentScope).toMatchObject({ rootTurnId: "new-root-turn" });
    expect(f.resolve()).toBeNull();
    expect(f.resolve("root", "new-root-turn")?.signal).toBe(current);
    f.complete("root", "new-root-turn");
    expect(current.aborted).toBe(true);
    expect(completeTurn).toHaveBeenCalledTimes(2);
    expect(f.native.releaseActiveTurn(f.active, "new-root-turn")).toBe(true);
    expect(f.resolve("root", "new-root-turn")).toBeNull();
    f.runtime.close();
  });

  it("ignores old child telemetry and completion without cancelling the new child or root", () => {
    const f = fixture();
    f.child();
    const root = f.resolve()!.signal;
    const old = f.resolve("child", "child-turn")!.signal;
    f.complete("child", "child-turn");
    f.start("child", "new-child-turn");
    const current = f.resolve("child", "new-child-turn")!.signal;
    f.notify("item/started", {
      threadId: "child",
      turnId: "child-turn",
      item: {
        type: "agentMessage",
        id: "old-child-item",
        text: "late",
        phase: "commentary",
      },
    });
    f.complete("child", "child-turn");
    expect(old.aborted).toBe(true);
    expect(f.resolve("child", "child-turn")).toBeNull();
    expect(f.resolve("child", "new-child-turn")?.signal).toBe(current);
    expect(current.aborted).toBe(false);
    expect(root.aborted).toBe(false);
    f.complete("child", "new-child-turn");
    expect(current.aborted).toBe(true);
    expect(f.resolve("child", "new-child-turn")).toBeNull();
    expect(root.aborted).toBe(false);
    f.runtime.close();
  });

  it("advances a genuine child B start while A still appears running and delivers B activity", () => {
    const f = fixture();
    const activities = vi.fn();
    Object.defineProperty(f.active, "onActivity", { value: activities });
    f.child();
    const old = f.resolve("child", "child-turn")!.signal;
    f.start("child", "child-B");
    const current = f.resolve("child", "child-B")!.signal;
    f.complete("child", "child-turn");
    f.notify("item/started", {
      threadId: "child",
      turnId: "child-B",
      item: {
        type: "commandExecution",
        id: "B-command",
        command: "echo B",
        cwd: "/unused",
        processId: null,
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: "",
        exitCode: null,
        durationMs: null,
      },
    });
    expect(activities.mock.calls.map(([activity]) => activity)).toContainEqual(
      expect.objectContaining({
        id: "B-command",
        type: "command",
        command: "echo B",
        correlation: expect.objectContaining({
          threadId: "child",
          turnId: "child-B",
        }),
      }),
    );
    expect(old.aborted).toBe(true);
    expect(current.aborted).toBe(false);
    expect(f.resolve("child", "child-turn")).toBeNull();
    f.complete("child", "child-B");
    expect(current.aborted).toBe(true);
    f.runtime.close();
  });

  it("never creates child authority from telemetry before an actual turn start", () => {
    const f = fixture();
    f.child();
    f.complete("child", "child-turn");
    f.notify("item/started", {
      threadId: "child",
      turnId: "telemetry-only",
      item: {
        type: "agentMessage",
        id: "item",
        text: "late",
        phase: "commentary",
      },
    });
    expect(f.resolve("child", "telemetry-only")).toBeNull();
    f.start("child", "actual-start");
    const current = f.resolve("child", "actual-start")!.signal;
    f.complete("child", "actual-start");
    expect(current.aborted).toBe(true);
    expect(f.resolve("child", "actual-start")).toBeNull();
    f.runtime.close();
  });

  it.each(["completeTurn", "failTurn"] as const)(
    "discards obsolete %s workspace results when B starts during the awaited read",
    async (method) => {
      const f = fixture();
      const finishing =
        method === "completeTurn"
          ? f.native.completeTurn(f.active, "root-turn", 2, null)
          : f.native.failTurn(f.active, "root-turn", new Error("old failure"));
      f.start("root", "new-root-turn");
      f.active.delta = "new turn text";
      const nextChanges = [{ path: "new-turn-file" }] as never[];
      f.active.diffChanges = nextChanges;
      const signal = f.resolve("root", "new-root-turn")!.signal;
      await finishing;
      expect(f.active.delta).toBe("new turn text");
      expect(f.active.diffChanges).toBe(nextChanges);
      expect(f.active.resolve).not.toHaveBeenCalled();
      expect(f.active.reject).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      f.runtime.close();
    },
  );

  it.each(["completeTurn", "failTurn"] as const)(
    "stops obsolete %s after a deferred reconciliation without settling B descendants",
    async (method) => {
      const f = fixture();
      let entered!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const deferred = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(f.native, "reconcileSubagentExecution").mockImplementation(
        () => {
          entered();
          return deferred;
        },
      );
      const settle = vi.spyOn(f.native, "settleDescendantsAtRootBoundary");
      const finishing =
        method === "completeTurn"
          ? f.native.completeTurn(f.active, "root-turn", 2, null)
          : f.native.failTurn(f.active, "root-turn", new Error("old failure"));
      await started;
      f.start("root", "new-root-turn");
      f.child();
      f.active.delta = "B text";
      f.active.pendingActivities.set("B activity", { id: "B activity" });
      const root = f.resolve("root", "new-root-turn")!.signal;
      const child = f.resolve("child", "child-turn")!.signal;
      finish();
      await finishing;
      expect(settle).not.toHaveBeenCalled();
      expect(f.active.delta).toBe("B text");
      expect(f.active.pendingActivities.has("B activity")).toBe(true);
      expect(f.active.resolve).not.toHaveBeenCalled();
      expect(f.active.reject).not.toHaveBeenCalled();
      expect(root.aborted).toBe(false);
      expect(child.aborted).toBe(false);
      f.runtime.close();
    },
  );

  it.each(["closed", "notLoaded", "systemError"])(
    "cancels only the child on genuine native thread %s without turn/completed",
    (status) => {
      const f = fixture();
      f.child();
      const root = f.resolve()!.signal;
      const child = f.resolve("child", "child-turn")!.signal;
      if (status === "closed") f.notify("thread/closed", { threadId: "child" });
      else
        f.notify("thread/status/changed", {
          threadId: "child",
          status: { type: status },
        });
      expect(child.aborted).toBe(true);
      expect(root.aborted).toBe(false);
      expect(f.resolve("child", "child-turn")).toBeNull();
      f.runtime.close();
    },
  );

  it("ignores stale parent close-agent telemetry but honors the current native close", () => {
    const f = fixture();
    f.start("root", "new-root-turn");
    f.child();
    const child = f.resolve("child", "child-turn")!.signal;
    const close = (turnId: string) =>
      f.notify("item/completed", {
        threadId: "root",
        turnId,
        item: {
          type: "collabAgentToolCall",
          id: `close-${turnId}`,
          tool: "close_agent",
          senderThreadId: "root",
          receiverThreadIds: ["child"],
          prompt: "",
          model: null,
          status: "completed",
          agentsStates: { child: { status: "shutdown", message: null } },
        },
      });
    close("root-turn");
    expect(child.aborted).toBe(false);
    expect(f.resolve("child", "child-turn")?.signal).toBe(child);
    close("new-root-turn");
    expect(child.aborted).toBe(true);
    expect(f.resolve("root", "new-root-turn")?.signal.aborted).toBe(false);
    f.runtime.close();
  });

  it.each(["exit", "close"])(
    "aborts all captured signals on runtime %s",
    (kind) => {
      const f = fixture();
      f.child();
      const root = f.resolve()!.signal;
      const child = f.resolve("child", "child-turn")!.signal;
      if (kind === "exit") f.native.handleExit(new Error("fake runtime exit"));
      else f.runtime.close();
      expect(root.aborted).toBe(true);
      expect(child.aborted).toBe(true);
      expect(f.resolve()).toBeNull();
    },
  );

  it("cancels immediately on interrupt without waiting for or undoing a failed acknowledgement", async () => {
    const f = fixture();
    f.child();
    const root = f.resolve()!.signal;
    const child = f.resolve("child", "child-turn")!.signal;
    let reject!: (error: Error) => void;
    const rpc = new Promise<never>((_resolve, failed) => {
      reject = failed;
    });
    vi.spyOn(f.native, "request").mockReturnValue(rpc);
    const interrupted = f.runtime.interruptChat("chat", "root");
    expect(root.aborted).toBe(true);
    expect(child.aborted).toBe(true);
    reject(new Error("fake acknowledgement failure"));
    await expect(interrupted).rejects.toThrow("fake acknowledgement failure");
    expect(f.resolve()).toBeNull();
    f.runtime.close();
  });
});
