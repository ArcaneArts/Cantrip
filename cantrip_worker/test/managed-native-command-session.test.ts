import { describe, expect, it, vi } from "vitest";
import type {
  AgentTurnResult,
  NativeCommandReceipt,
  NativeCommandSession,
  NativeCommandSettlement,
} from "@cantrip/protocol";
import { openNativeCommandContent } from "../src/native-command-content.js";
import { ManagedNativeCommandSession } from "../src/codex/managed-native-command-session.js";
import {
  CodexNativeRpcError,
  type AdmittedNativeExecution,
} from "../src/codex/app-server.js";
import type { NativeCommandClient } from "../src/native-command-client.js";
import type { ManagedNativeOperation } from "../src/codex/managed-native-gateway.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const identity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  placementId: "placement",
  contextKind: "project" as const,
};
const session: NativeCommandSession = {
  chatId: "chat",
  threadId: "thread",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  runtimeGeneration: "transport",
  modelRouteId: "route",
  providerAccountId: null,
  connectionId: "view",
};
const receipt: NativeCommandReceipt = {
  operationId: "operation",
  operationGeneration: "operation-generation",
  activationGeneration: "activation",
  startsExecution: true,
  chatId: "chat",
  executionLaneId: "lane",
  status: "accepted",
  method: "turn/start",
  payloadDigest: "a".repeat(64),
  rejectionCode: null,
  threadId: "thread",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
function fixture(start = true) {
  const order: string[] = [];
  const done = deferred<AgentTurnResult>();
  const controller = new AbortController();
  const handle: AdmittedNativeExecution = {
    operationGeneration: receipt.operationGeneration,
    threadId: "thread",
    signal: controller.signal,
    completion: done.promise,
    assertCurrent: vi.fn(),
    bindReceipt: vi.fn(),
    fail: vi.fn((error) => done.reject(error)),
  };
  const client = {
    admit: vi.fn(async () => ({
      receipt: { ...receipt, startsExecution: start },
      execution: null,
      computerUseAuthority: null,
    })),
    dispatch: vi.fn(async () => {
      order.push("dispatch");
    }),
    settle: vi.fn(async (input: Omit<NativeCommandSettlement, "workerId">) => {
      order.push(input.executionComplete ? "finish" : "receipt");
    }),
    pending: vi.fn(async () => {}),
    bindPreparation: vi.fn(async () => {
      order.push("bind-preparation");
      return { receipt };
    }),
  };
  const runtime = {
    transportGeneration: "transport",
    prepareAdmittedNativeExecution: vi.fn(async () => {
      order.push("register");
      return handle;
    }),
    awaitPendingAdmittedNativeReply: vi.fn(async () => ({ turnId: "turn" })),
    resolveAdmittedNativeReply: vi.fn(),
    resolveManagedExecution: vi.fn(async () => {
      order.push("allow");
      return { accepted: true };
    }),
  };
  const publication = {
    options: {
      chatId: "chat",
      cwd: "/tmp",
      captureProtectedDiagnostics: false,
      model: {
        id: "model",
        routeId: "route",
        name: "model",
        reasoningEffort: null,
      },
      provider: {
        id: "provider",
        name: "provider",
        kind: "chatgpt" as const,
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
    },
    complete: vi.fn(async () => {
      order.push("complete");
    }),
    failed: vi.fn(async () => {
      order.push("failed");
    }),
    release: vi.fn(async () => {
      order.push("release");
    }),
  };
  const onError = vi.fn();
  const adapter = new ManagedNativeCommandSession({
    identity,
    runtime: runtime as never,
    client: client as unknown as NativeCommandClient,
    encryption: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
    },
    policy: {
      cwd: "/tmp",
      codexHome: "/tmp",
      permissionProfileId: "profile",
      security: {},
    },
    beginExecution: vi.fn(async () => publication),
    beforeNativeDispatch: async (method) => {
      if (method === "turn/interrupt") order.push("invalidate-runner");
    },
    onError,
  });
  const operation: ManagedNativeOperation = {
    operationId: "operation",
    origin: "terminal",
    identity: {
      ...identity,
      threadId: "thread",
      runtimeGeneration: "transport",
      modelRouteId: "route",
      providerAccountId: null,
    },
    connectionId: "view",
    kind: start ? "start" : "control",
    method: start ? "turn/start" : "turn/interrupt",
    frame: {
      id: 1,
      method: start ? "turn/start" : "turn/interrupt",
      params: { threadId: "thread", turnId: "turn" },
    },
  };
  return {
    adapter,
    client,
    runtime,
    publication,
    handle,
    done,
    order,
    onError,
    operation,
  };
}
const result = {
  threadId: "thread",
  turnId: "turn",
  text: "done",
} as AgentTurnResult;

describe("managed native command session", () => {
  it("binds accepted GUI preparation identity before mediated rollback without creating execution authority", async () => {
    const f = fixture(false);
    const preparedSession = {
      ...session,
      connectionId: `gui:${receipt.operationGeneration}`,
    };
    let released!: Promise<void>;
    await f.adapter.withGuiPreparation(receipt, preparedSession, async () => {
      expect(f.adapter.currentActivationGeneration).toBe(
        receipt.activationGeneration,
      );
      released = f.adapter.awaitExecutionReleased();
      await f.adapter.executeGuiCommand(preparedSession, {
        method: "thread/rollback",
        params: { threadId: "thread", numTurns: 1 },
        dispatch: async () => {
          f.order.push("rollback");
          return {};
        },
      });
    });
    await released;
    expect(f.client.bindPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        session: preparedSession,
      }),
    );
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActivationGeneration: receipt.activationGeneration,
      }),
    );
    expect(f.order).toEqual([
      "bind-preparation",
      "dispatch",
      "rollback",
      "receipt",
    ]);
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
    expect(f.adapter.currentActivationGeneration).toBeNull();
    await f.adapter.dispatchGui(receipt, preparedSession);
    expect(f.adapter.currentActivationGeneration).toBe(
      receipt.activationGeneration,
    );
  });

  it("cleans up an owned GUI preparation join after callback failure", async () => {
    const f = fixture(false);
    await expect(
      f.adapter.withGuiPreparation(
        receipt,
        { ...session, connectionId: `gui:${receipt.operationGeneration}` },
        async () => {
          throw new Error("rollback failed");
        },
      ),
    ).rejects.toThrow("rollback failed");
    expect(f.adapter.currentActivationGeneration).toBeNull();
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
    await expect(
      f.adapter.withGuiPreparation(receipt, session, async () => {}),
    ).rejects.toThrow("connection identity");
    expect(f.client.bindPreparation).toHaveBeenCalledTimes(1);
  });

  it("does not release a matching join owned by an outer GUI preparation", async () => {
    const f = fixture(false);
    const preparedSession = {
      ...session,
      connectionId: `gui:${receipt.operationGeneration}`,
    };
    await f.adapter.withGuiPreparation(receipt, preparedSession, async () => {
      await expect(
        f.adapter.withGuiPreparation(receipt, preparedSession, async () => {
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
      expect(f.adapter.currentActivationGeneration).toBe(
        receipt.activationGeneration,
      );
    });
    expect(f.adapter.currentActivationGeneration).toBeNull();
  });

  it("waits for real GUI publication release, then registers a native attempt before allowing its ticket", async () => {
    const f = fixture();
    await f.adapter.dispatchGui(
      { ...receipt, operationGeneration: "previous" },
      session,
    );
    f.order.length = 0;
    f.client.admit.mockImplementation(async (input) => ({
      receipt: { ...receipt, operationId: input.operationId },
      execution: null,
      computerUseAuthority: null,
    }));
    const attempt = {
      threadId: "thread",
      runnerGeneration: "runner",
      attemptId: "attempt",
      turnId: "turn",
      trigger: "goal" as const,
      input: {
        input: { ResponseItem: { actual: "native continuation" } },
        threadSettings: {},
        start: {},
      },
    };
    const running = f.adapter.admitAutonomousAttempt(
      attempt,
      session,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(f.client.admit).not.toHaveBeenCalled();
    f.adapter.releaseGui("previous");
    await running;
    expect(f.order).toEqual(["register", "dispatch", "allow", "receipt"]);
    expect(f.runtime.prepareAdmittedNativeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTurnId: "turn" }),
    );
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "autonomous",
        method: "turn/start",
        intent: expect.objectContaining({ expectedTurnId: "turn" }),
      }),
    );
    expect(f.client.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "uncertain",
        executionComplete: false,
      }),
    );
    f.adapter.declineAutonomousAttempt({
      ...attempt,
      operationGeneration: "operation-generation",
      reason: "ticket invalidated",
    });
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalledTimes(2));
    expect(f.client.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "rejected",
        executionComplete: true,
        resultDigest: null,
        protectedResult: null,
        terminalResult: {
          resultDigest: expect.any(String),
          protectedResult: expect.any(Object),
        },
        decline: {
          nativeTurnId: "turn",
          runtimeGeneration: "transport",
          runnerGeneration: "runner",
          attemptId: "attempt",
        },
      }),
    );
    const terminal = f.client.settle.mock.calls[1]![0];
    expect(terminal).not.toHaveProperty("reconciliation");
    expect(f.publication.complete).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(["physical", "logical"] as const)(
    "holds the GUI lane until both exact cleanup acknowledgments arrive (%s first)",
    async (first) => {
      const f = fixture();
      await f.adapter.dispatchGui(receipt, session);
      const released = vi.fn();
      const waiting = f.adapter.awaitExecutionReleased().then(released);
      if (first === "physical")
        f.adapter.markGuiFinished(
          receipt.operationId,
          receipt.operationGeneration,
        );
      else
        f.adapter.completeGuiLogical(
          receipt.operationId,
          receipt.operationGeneration,
        );
      f.adapter.completeGuiLogical("foreign", receipt.operationGeneration);
      await Promise.resolve();
      expect(released).not.toHaveBeenCalled();
      expect(f.adapter.currentActivationGeneration).toBe("activation");
      if (first === "physical")
        f.adapter.completeGuiLogical(
          receipt.operationId,
          receipt.operationGeneration,
        );
      else
        f.adapter.markGuiFinished(
          receipt.operationId,
          receipt.operationGeneration,
        );
      await waiting;
      expect(released).toHaveBeenCalledOnce();
      expect(f.adapter.currentActivationGeneration).toBeNull();
    },
  );

  it("atomically transfers a GUI retry barrier without waking an autonomous successor between attempts", async () => {
    const f = fixture();
    await f.adapter.dispatchGui(receipt, session);
    const released = vi.fn();
    const waiting = f.adapter.awaitExecutionReleased().then(released);
    const continuation = {
      ...receipt,
      operationId: "continuation",
      operationGeneration: "next-generation",
      activationGeneration: "next-activation",
    };
    f.adapter.adoptGuiContinuation(
      receipt.operationGeneration,
      continuation,
      session,
      receipt,
    );
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    expect(f.adapter.currentActivationGeneration).toBe("next-activation");
    f.adapter.releaseGui(receipt.operationGeneration);
    f.adapter.completeGuiLogical("foreign", receipt.operationGeneration);
    expect(f.adapter.currentActivationGeneration).toBe("next-activation");
    await f.adapter.dispatchGui(continuation, session, receipt);
    f.adapter.markGuiFinished(receipt.operationId, receipt.operationGeneration);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    f.adapter.completeGuiLogical(
      receipt.operationId,
      receipt.operationGeneration,
    );
    await waiting;
    expect(released).toHaveBeenCalledOnce();
  });

  it("keeps Stop dispatch independent while the GUI waits for logical completion", async () => {
    const f = fixture(false);
    await f.adapter.dispatchGui(receipt, session);
    f.adapter.markGuiFinished(receipt.operationId, receipt.operationGeneration);
    const dispatch = vi.fn(async () => ({ interrupted: false }));
    await expect(
      f.adapter.executeGuiCommand(session, {
        method: "turn/interrupt",
        params: { threadId: "thread" },
        dispatch,
      }),
    ).resolves.toEqual({ interrupted: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.adapter.currentActivationGeneration).toBe("activation");
    f.adapter.completeGuiLogical(
      receipt.operationId,
      receipt.operationGeneration,
    );
  });

  it("joins a prepared replacement adapter only when its expected local owner is empty", async () => {
    const f = fixture();
    const continuation = {
      ...receipt,
      operationId: "continuation",
      operationGeneration: "next-generation",
      activationGeneration: "next-activation",
    };
    f.adapter.adoptGuiContinuation(null, continuation, session, receipt);
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(f.adapter.currentActivationGeneration).toBe("next-activation");
    expect(() =>
      f.adapter.adoptGuiContinuation(
        null,
        { ...continuation, operationGeneration: "another" },
        session,
        receipt,
      ),
    ).toThrow("previous logical attempt");
    f.adapter.markGuiFinished(receipt.operationId, receipt.operationGeneration);
    f.adapter.completeGuiLogical(
      receipt.operationId,
      receipt.operationGeneration,
    );
  });

  it("aborts the GUI barrier on actual bridge loss without letting its old listener clear a replacement", async () => {
    const f = fixture();
    const old = new AbortController();
    await f.adapter.dispatchGui(receipt, session, receipt, old.signal);
    const next = new AbortController();
    const continuation = {
      ...receipt,
      operationId: "continuation",
      operationGeneration: "next-generation",
      activationGeneration: "next-activation",
    };
    f.adapter.adoptGuiContinuation(
      receipt.operationGeneration,
      continuation,
      session,
      receipt,
      next.signal,
    );
    const released = vi.fn();
    const waiting = f.adapter.awaitExecutionReleased().then(released);
    old.abort();
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    expect(f.adapter.currentActivationGeneration).toBe("next-activation");
    next.abort();
    await waiting;
    expect(f.adapter.currentActivationGeneration).toBeNull();
  });

  it("aborts an autonomous attempt waiting for prior cleanup without creating an admission", async () => {
    const f = fixture();
    await f.adapter.dispatchGui(receipt, session);
    const controller = new AbortController();
    const waiting = f.adapter.awaitExecutionReleased(controller.signal);
    controller.abort(new Error("runner invalidated"));
    await expect(waiting).rejects.toThrow("runner invalidated");
    expect(f.client.admit).not.toHaveBeenCalled();
    f.adapter.releaseGui(receipt.operationGeneration);
  });

  it("retains server-captured activation across asynchronous GUI input preparation", async () => {
    const f = fixture(false);
    await f.adapter.dispatchGui(receipt, session);
    const ready = deferred<void>();
    const dispatch = vi.fn(async () => ({}));
    const command = f.adapter.withExpectedActivationGeneration(
      "activation",
      async () => {
        await ready.promise;
        return f.adapter.executeGuiCommand(session, {
          method: "turn/steer",
          params: { threadId: "thread", expectedTurnId: "turn", input: [] },
          dispatch,
        });
      },
    );
    f.adapter.releaseGui(receipt.operationGeneration);
    await f.adapter.dispatchGui(
      {
        ...receipt,
        operationGeneration: "new",
        activationGeneration: "replacement",
      },
      session,
    );
    ready.resolve();
    await expect(command).rejects.toThrow("replaced activation");
    expect(f.client.admit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("registers before dispatch and waits for the native receipt when completion wins the race", async () => {
    const f = fixture();
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    expect(f.order).toEqual(["register", "dispatch"]);
    f.done.resolve(result);
    await Promise.resolve();
    expect(f.client.settle).not.toHaveBeenCalled();
    await admission.settle({ result: { turn: { id: "turn" } } });
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalledTimes(2));
    expect(f.order).toEqual([
      "register",
      "dispatch",
      "receipt",
      "complete",
      "release",
      "finish",
    ]);
    expect(f.publication.release).toHaveBeenCalledTimes(1);
    const [ack, terminal] = f.client.settle.mock.calls.map(([value]) => value);
    expect(ack!.resultDigest).toEqual(expect.any(String));
    expect(ack!).not.toHaveProperty("terminalResult");
    expect(terminal).toMatchObject({
      resultDigest: null,
      protectedResult: null,
    });
    expect(terminal!.terminalResult!.resultDigest).not.toBe(ack!.resultDigest);
    const encryption = {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
    };
    const context = { chatId: "chat", operationId: "operation" };
    await expect(
      openNativeCommandContent({
        service: encryption,
        context: { ...context, direction: "result" },
        envelope: ack!.protectedResult!,
      }),
    ).resolves.toEqual({ result: { turn: { id: "turn" } } });
    await expect(
      openNativeCommandContent({
        service: encryption,
        context: { ...context, direction: "terminal-result" },
        envelope: terminal!.terminalResult!.protectedResult!,
      }),
    ).resolves.toEqual(result);
    await expect(
      openNativeCommandContent({
        service: encryption,
        context: { ...context, direction: "result" },
        envelope: terminal!.terminalResult!.protectedResult!,
      }),
    ).rejects.toThrow();
  });

  it("does not claim a nested autonomous turn returned by a scoped queue mutation", async () => {
    const f = fixture(false);
    const admission = await f.adapter.admit({
      ...f.operation,
      kind: "mutation",
      method: "thread/queue/start",
      frame: { method: "thread/queue/start", params: { threadId: "thread" } },
    });
    await admission.beforeForward();
    await admission.settle({ result: { turn: { id: "autonomous-turn" } } });
    expect(f.client.settle).toHaveBeenCalledOnce();
    expect(f.client.settle.mock.calls[0]![0]).not.toHaveProperty(
      "reconciliation",
    );
    expect(f.client.settle.mock.calls[0]![0]).toMatchObject({
      status: "applied",
      executionComplete: false,
    });
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
  });

  it("retains explicit native rejection through asynchronous execution cleanup", async () => {
    const f = fixture();
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    await admission.settle({ error: { code: -1, message: "rejected" } });
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalledTimes(2));
    expect(f.client.settle.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ status: "rejected", executionComplete: false }),
      expect.objectContaining({ status: "rejected", executionComplete: true }),
    ]);
    expect(f.publication.complete).not.toHaveBeenCalled();
    expect(f.order.indexOf("release")).toBeLessThan(f.order.indexOf("finish"));
  });

  it("keeps an uncertain acceptance until actual completion reconciles it and ignores duplicate settlement", async () => {
    const f = fixture();
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    await admission.settle(null);
    await admission.settle({ error: { code: -1, message: "late" } });
    expect(f.handle.fail).not.toHaveBeenCalled();
    expect(f.client.settle).toHaveBeenCalledTimes(1);
    expect(f.client.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "uncertain",
        executionComplete: false,
      }),
    );
    f.done.resolve(result);
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalledTimes(2));
    expect(f.client.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "applied",
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn",
          runtimeGeneration: "transport",
        },
      }),
    );
  });

  it("does not convert lost transport plus missing acceptance into native success", async () => {
    const f = fixture();
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    await admission.settle(null);
    f.done.reject(new Error("transport lost"));
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalledTimes(2));
    expect(f.client.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "uncertain", executionComplete: true }),
    );
  });

  it("reports a pending stable-ID replay without dispatching its mutation", async () => {
    const f = fixture(false);
    f.client.admit.mockResolvedValue({
      receipt,
      execution: null,
      computerUseAuthority: null,
      replayed: true,
    });
    const dispatch = vi.fn(async () => ({}));
    await expect(
      f.adapter.executeGuiCommand(session, {
        operationId: "stable-user-message",
        method: "thread/goal/set",
        params: { threadId: "thread", status: "active" },
        dispatch,
      }),
    ).rejects.toThrow("already accepted");
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });

  it("uses the supplied goal operation ID and never replays a completed receipt", async () => {
    const f = fixture(false);
    const dispatch = vi.fn(async () => ({}));
    await f.adapter.executeGuiCommand(session, {
      operationId: "stable-user-message",
      method: "thread/goal/set",
      params: { threadId: "thread", objective: "same goal", status: "active" },
      dispatch,
    });
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "stable-user-message" }),
    );
    f.client.admit.mockResolvedValue({
      receipt: { ...receipt, status: "applied", startsExecution: false },
      execution: null,
      computerUseAuthority: null,
    });
    await expect(
      f.adapter.executeGuiCommand(session, {
        operationId: "stable-user-message",
        method: "thread/goal/set",
        params: {
          threadId: "thread",
          objective: "same goal",
          status: "active",
        },
        dispatch,
      }),
    ).rejects.toThrow("admission rejected");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("admits GUI controls with the actual identity and persists native acceptance", async () => {
    const f = fixture(false);
    const dispatch = vi.fn(async () => {
      f.order.push("native");
      return { turnId: "turn" };
    });
    await expect(
      f.adapter.executeGuiCommand(session, {
        method: "turn/steer",
        params: { threadId: "thread", expectedTurnId: "turn", input: [] },
        dispatch,
      }),
    ).resolves.toEqual({ turnId: "turn" });
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "gui", method: "turn/steer", session }),
    );
    expect(f.order).toEqual(["dispatch", "native", "receipt"]);
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
  });

  it("invalidates an autonomous runner after durable admission but before native Stop", async () => {
    const f = fixture(false);
    await f.adapter.executeGuiCommand(session, {
      method: "turn/interrupt",
      params: { threadId: "thread", turnId: "turn" },
      dispatch: async () => {
        f.order.push("native-stop");
        return {};
      },
    });
    expect(f.order).toEqual([
      "dispatch",
      "invalidate-runner",
      "native-stop",
      "receipt",
    ]);
  });

  it.each([true, false])(
    "distinguishes a received GUI native rejection from transport failure (%s)",
    async (nativeRejected) => {
      const f = fixture(false);
      const error = nativeRejected
        ? new CodexNativeRpcError("no", { code: -1, message: "no" })
        : new Error("socket closed");
      await expect(
        f.adapter.executeGuiCommand(session, {
          method: "turn/interrupt",
          params: { threadId: "thread", turnId: "turn" },
          dispatch: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(f.client.settle).toHaveBeenCalledWith(
        expect.objectContaining({
          status: nativeRejected ? "rejected" : "uncertain",
        }),
      );
    },
  );

  it("registers the pending GUI reply and admits it before consuming the one runtime ledger", async () => {
    const f = fixture(false);
    await f.adapter.dispatchGui(receipt, session);
    f.order.length = 0;
    const dispatch = vi.fn(async () => {
      f.order.push("native-reply");
      return { accepted: true };
    });
    await f.adapter.executeGuiCommand(session, {
      method: "serverRequest/reply",
      params: { result: { decision: "accept" } },
      reply: {
        requestId: 1,
        requestMethod: "item/commandExecution/requestApproval",
        turnId: "turn",
      },
      dispatch,
    });
    expect(f.client.pending).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeRequestId: "number:1",
        activationGeneration: "activation",
      }),
    );
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "gui",
        method: "serverRequest/reply",
        expectedActivationGeneration: "activation",
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.runtime.resolveAdmittedNativeReply).not.toHaveBeenCalled();
    expect(f.order).toEqual(["dispatch", "native-reply", "receipt"]);
  });
});
