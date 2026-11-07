import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { describe, expect, it, vi } from "vitest";
import { queuedPromptOpaqueContentSchema } from "@cantrip/protocol";
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
  CodexTurnFailureError,
  type AdmittedNativeExecution,
} from "../src/codex/app-server.js";
import type { NativeCommandClient } from "../src/native-command-client.js";
import { workerTurnContinuationSchema } from "../src/codex/worker-turn-continuation.js";
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
function fixture(
  start = true,
  captureSuspension?: (input: {
    session: NativeCommandSession;
    turnId: string;
  }) => Promise<unknown>,
) {
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
    bindRestoredSuspension: vi.fn(),
    fail: vi.fn((error) => done.reject(error)),
  };
  const client = {
    resolvePermissionTransition: vi.fn(async () => ({
      bindingId: "binding",
      permissionTransition: {
        selectedId: ":yolo",
        resolvedSelectedId: ":yolo",
        effectiveId: ":read-only",
        expectedRevision: "4",
      },
    })),
    refreshSettings: vi.fn(async () => ({})),
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
      return { receipt };
    }),
    pending: vi.fn(async () => {}),
    bindPreparation: vi.fn(async () => {
      order.push("bind-preparation");
      return { receipt };
    }),
  };
  const settingsHistory = new NativeHistoryObservations();
  settingsHistory.replace("transport");
  const settingsDelivery = {
    track: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
  };
  const runtime = {
    observeNativeHistory: (
      threadId: string,
      observer: Parameters<NativeHistoryObservations["subscribe"]>[1],
    ) =>
      settingsHistory.subscribe(threadId, observer, async () => {
        throw new Error("No snapshot expected");
      }),
    transportGeneration: "transport",
    prepareAdmittedNativeExecution: vi.fn(async () => {
      order.push("register");
      return handle;
    }),
    prepareRestoredNativeExecution: vi.fn(async () => {
      order.push("restore");
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
  const onDeferredReady = vi.fn();
  const protectedContent = {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  };
  const retained = {
    retainedPrompt: queuedPromptOpaqueContentSchema.parse({
      id: "456789ab-1234-4234-8234-000000000002",
      classification: { mode: "default", attachmentIds: [] },
      protectedContent,
      modelId: "model",
      idempotencyKey: "terminal-prompt",
      pendingMessage: {
        id: "456789ab-1234-4234-8234-000000000001",
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent,
        idempotencyKey: "terminal-message",
      },
      nativeAction: "literal",
      executionMethod: "turn/start",
      nativeClientUserMessageId: "native-user",
      protectedNativeInput: protectedContent.envelope,
    }),
    attachments: [],
  };
  const retainDeferredInput = vi.fn(async () => retained as never);
  const beginExecution = vi.fn(async () => publication);
  const adapter = new ManagedNativeCommandSession({
    identity,
    runtime: runtime as never,
    client: client as unknown as NativeCommandClient,
    captureSuspension,
    settingsDelivery,
    onDeferredReady,
    retainDeferredInput,
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
    beginExecution,
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
    beginExecution,
    settingsDelivery,
    settingsHistory,
    client,
    runtime,
    publication,
    handle,
    done,
    order,
    onError,
    onDeferredReady,
    operation,
    retained,
    retainDeferredInput,
  };
}
const result = {
  threadId: "thread",
  turnId: "turn",
  text: "done",
} as AgentTurnResult;

const durablePauseResult = {
  paused: true,
  suspension: {
    threadId: "thread",
    turnId: "turn",
    checkpointId: "checkpoint",
    revision: 1,
  },
};

describe("managed native command session", () => {
  it.each(["completed", "failed", "interrupted"] as const)(
    "records actual GUI native %s before separate logical cleanup",
    async (terminalStatus) => {
      const f = fixture(false);
      await f.adapter.guiTerminal(receipt, session, "turn", terminalStatus);
      expect(f.client.settle).toHaveBeenCalledExactlyOnceWith({
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: false,
        reconciliation: {
          nativeTurnId: "turn",
          runtimeGeneration: "transport",
          terminalStatus,
        },
      });
      expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "keeps the original inference source alive for paused=%s",
    async (paused) => {
      const f = fixture();
      const root = await f.adapter.admit(f.operation);
      await root.beforeForward();
      await root.settle({ result: { turn: { id: "turn" } } });
      const calls = f.runtime.prepareAdmittedNativeExecution.mock
        .calls as unknown as Array<
        [{ inferenceSource: { signal: AbortSignal; assertCurrent(): void } }]
      >;
      const source = calls[0]![0].inferenceSource;
      expect(source.signal.aborted).toBe(false);
      f.client.admit.mockResolvedValueOnce({
        receipt: {
          ...receipt,
          startsExecution: false,
          operationId: "pause-control",
          operationGeneration: "pause-generation",
        },
        execution: null,
        computerUseAuthority: null,
      });
      const control = await f.adapter.admit({
        ...f.operation,
        operationId: "pause-control",
        kind: "control",
        method: "turn/pause",
        frame: {
          method: "turn/pause",
          params: { threadId: "thread", turnId: "turn", paused },
        },
      });
      await control.beforeForward();
      expect(source.signal.aborted).toBe(false);
      expect(() => source.assertCurrent()).not.toThrow();
      await control.settle({ result: {} });
      f.done.resolve(result);
      await vi.waitFor(() => expect(f.publication.complete).toHaveBeenCalled());
    },
  );
  it("confirms Pause only after native capture and worker storage acknowledge", async () => {
    const committed = deferred<void>();
    const capture = vi.fn(async () => {
      await committed.promise;
      return {
        suspension: durablePauseResult.suspension,
        storageId: "00000000-0000-4000-8000-000000000001",
        runtimeVersion: "fixture",
        runtimeFingerprint: null,
      };
    });
    const f = fixture(false, capture);
    f.operation.method = "turn/pause";
    f.operation.frame.method = "turn/pause";
    f.operation.frame.params = {
      threadId: "thread",
      turnId: "turn",
      paused: true,
    };
    const admitted = await f.adapter.admit(f.operation);
    expect(admitted.forward).toEqual({
      method: "turn/suspension",
      params: {
        threadId: "thread",
        operation: { type: "pause", turnId: "turn" },
      },
    });
    await admitted.beforeForward();
    let confirmed = false;
    const settlement = admitted
      .settle({ result: durablePauseResult })
      .then(() => {
        confirmed = true;
      });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(capture).toHaveBeenCalledWith({
      session,
      turnId: "turn",
      suspension: durablePauseResult.suspension,
    });
    expect(confirmed).toBe(false);
    expect(f.client.settle).not.toHaveBeenCalled();
    committed.resolve();
    await settlement;
    expect(confirmed).toBe(true);
    expect(f.client.settle).toHaveBeenCalledOnce();
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
  });

  it("does not confirm a failed durable capture or repeat an uncertain native action", async () => {
    const capture = vi.fn(async () => {
      throw new Error("actual checkpoint write failed");
    });
    const f = fixture(false, capture);
    f.operation.method = "turn/pause";
    f.operation.frame.method = "turn/pause";
    f.operation.frame.params = {
      threadId: "thread",
      turnId: "turn",
      paused: true,
    };
    const admitted = await f.adapter.admit(f.operation);
    await admitted.beforeForward();
    await expect(
      admitted.settle({ result: durablePauseResult }),
    ).rejects.toThrow("actual checkpoint write failed");
    await expect(
      admitted.settle({ result: durablePauseResult }),
    ).rejects.toThrow("actual checkpoint write failed");
    expect(capture).toHaveBeenCalledOnce();
    expect(f.client.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: "uncertain",
        durableSuspension: true,
        protectedResult: null,
      }),
    );
  });
  it.each(["interrupted", "failed"] as const)(
    "settles native %s with its authoritative terminal outcome",
    async (outcome) => {
      const f = fixture();
      const admission = await f.adapter.admit(f.operation);
      await admission.beforeForward();
      await admission.settle({ result: { turn: { id: "turn" } } });
      // Deliberately use the same text: classification must come from native status.
      const error = new CodexTurnFailureError(
        "The provider connection was interrupted.",
        null,
        "thread",
        "turn",
        outcome,
      );
      f.done.reject(error);
      await expect
        .poll(
          () =>
            f.client.settle.mock.calls.filter(([input]) => input.terminalResult)
              .length,
        )
        .toBe(1);
      const terminal = f.client.settle.mock.calls
        .map(([input]) => input)
        .find((input) => input.terminalResult);
      expect(terminal).toMatchObject({
        status: "applied",
        executionComplete: true,
        executionStatus: outcome === "interrupted" ? "idle" : "failed",
        reconciliation: { nativeTurnId: "turn" },
      });
      await expect(
        openNativeCommandContent({
          service: {
            ownerId: () => "owner",
            serverIdentity: () => "server",
            componentKey: () => ({
              keyRevision: 1,
              key: new Uint8Array(32).fill(7),
            }),
          },
          context: {
            chatId: "chat",
            operationId: "operation",
            direction: "terminal-result",
          },
          envelope: terminal!.terminalResult!.protectedResult!,
        }),
      ).resolves.toEqual(
        outcome === "interrupted" ? { interrupted: true } : { failed: true },
      );
      expect(f.publication.failed).toHaveBeenCalledExactlyOnceWith(error);
      expect(f.publication.release).toHaveBeenCalledTimes(1);
      expect(f.onError).not.toHaveBeenCalled();
    },
  );

  it("settles explicitly unconsumed pending-permission input idle without publishing a failed turn", async () => {
    const f = fixture();
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    await admission.settle({
      error: {
        code: -32001,
        message: "input not consumed",
        data: { reason: "pendingSettings", inputConsumed: false },
      },
    });
    await expect.poll(() => f.publication.release.mock.calls.length).toBe(1);
    expect(f.publication.failed).not.toHaveBeenCalled();
    expect(f.client.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        executionComplete: true,
        executionStatus: "idle",
        rejectionCode: "native-settings-pending",
        deferred: {
          reason: "pendingSettings",
          inputConsumed: false,
          threadId: "thread",
          runtimeGeneration: "transport",
        },
      }),
    );
    expect(f.retainDeferredInput).toHaveBeenCalledWith(f.operation);
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        retainedInput: { prompt: f.retained.retainedPrompt, attachments: [] },
        intent: expect.objectContaining({
          nativeClientUserMessageId: "native-user",
        }),
      }),
      undefined,
    );
    expect(f.client.settle).toHaveBeenCalledTimes(1);
  });
  it("reports canonical queue ownership only after durable settlement", async () => {
    const f = fixture();
    const write = deferred<void>();
    f.client.settle.mockImplementationOnce(async () => {
      await write.promise;
      return { receipt };
    });
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    const frame = {
      error: {
        code: -32001,
        message: "pending",
        data: {
          reason: "pendingSettings",
          inputConsumed: false,
        } as Record<string, unknown>,
      },
    };
    const settling = admission.settle(frame);
    await expect.poll(() => f.client.settle.mock.calls.length).toBe(1);
    expect(frame.error.data.queueRetained).toBeUndefined();
    write.resolve();
    await settling;
    expect(frame.error.data.queueRetained).toBe(true);
  });
  it("never claims queue retention when durable settlement fails", async () => {
    const f = fixture();
    f.client.settle.mockRejectedValueOnce(new Error("persistence unavailable"));
    const admission = await f.adapter.admit(f.operation);
    await admission.beforeForward();
    const frame = {
      error: {
        code: -32001,
        message: "pending",
        data: {
          reason: "pendingSettings",
          inputConsumed: false,
        } as Record<string, unknown>,
      },
    };
    await expect(admission.settle(frame)).rejects.toMatchObject({
      queueRetention: "uncertain",
      cause: { message: "persistence unavailable" },
    });
    expect(frame.error.data.queueRetained).toBeUndefined();
  });
  it("persists a GUI start rejection as protected evidence before logical cleanup", async () => {
    const f = fixture();
    await f.adapter.dispatchGui(receipt, session);
    const frame = {
      error: { code: -32600, message: "PRIVATE native turn is durably paused" },
    };
    await expect(
      f.adapter.guiRejected(
        { ...receipt, operationGeneration: "stale" },
        session,
        frame,
      ),
    ).rejects.toThrow("matching native dispatch identity");
    expect(f.client.settle).not.toHaveBeenCalled();
    await f.adapter.guiRejected(receipt, session, frame);
    const settlement = f.client.settle.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      status: "rejected",
      rejectionCode: "native-request-rejected",
      executionComplete: false,
    });
    expect(JSON.stringify(settlement)).not.toContain("PRIVATE");
    expect(
      await openNativeCommandContent({
        service: {
          ownerId: () => "owner",
          serverIdentity: () => "server",
          componentKey: () => ({
            keyRevision: 1,
            key: new Uint8Array(32).fill(7),
          }),
        },
        context: {
          chatId: "chat",
          operationId: receipt.operationId,
          direction: "result",
        },
        envelope: settlement.protectedResult!,
        digest: settlement.resultDigest!,
      }),
    ).toEqual(frame);
  });

  it("keeps an existing deferred queue claim without creating another prompt", async () => {
    const f = fixture();
    const admission = await f.adapter.admit({
      ...f.operation,
      queueClaim: { id: "claim", promptRevision: 1 },
    });
    await admission.beforeForward();
    const frame = {
      error: {
        code: -32001,
        message: "pending",
        data: {
          reason: "pendingSettings",
          inputConsumed: false,
        } as Record<string, unknown>,
      },
    };
    await admission.settle(frame);
    expect(f.retainDeferredInput).not.toHaveBeenCalled();
    expect(frame.error.data.queueRetained).toBe(true);
  });
  it("wakes recovery when canonical settlement makes a late deferral eligible", async () => {
    const f = fixture();
    f.client.settle.mockResolvedValueOnce({
      receipt: { ...receipt, resumeQueue: true },
    });
    await f.adapter.dispatchGui(receipt, session);
    await f.adapter.guiDeferred(
      receipt,
      session,
      {
        error: {
          code: -32001,
          message: "pending",
          data: { reason: "pendingSettings", inputConsumed: false },
        },
      },
      {},
    );
    expect(f.onDeferredReady).toHaveBeenCalledTimes(1);
    expect(f.client.settle).toHaveBeenCalledTimes(1);
  });

  it("persists GUI no-consumption evidence without ending a newer or started turn", async () => {
    const f = fixture();
    const frame = {
      error: {
        code: -32001,
        message: "pending",
        data: { reason: "pendingSettings", inputConsumed: false },
      },
    };
    await f.adapter.dispatchGui(receipt, session);
    await expect(
      f.adapter.guiDeferred(
        receipt,
        { ...session, runtimeGeneration: "replacement" },
        frame,
        {},
      ),
    ).rejects.toThrow("matching native deferral");
    expect(f.client.settle).not.toHaveBeenCalled();
    await f.adapter.guiDeferred(receipt, session, frame, {});
    expect(f.client.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        executionComplete: true,
        executionStatus: "idle",
        deferred: {
          reason: "pendingSettings",
          inputConsumed: false,
          threadId: "thread",
          runtimeGeneration: "transport",
        },
      }),
    );
    expect(f.publication.failed).not.toHaveBeenCalled();
    const started = fixture();
    await started.adapter.dispatchGui(receipt, session);
    await started.adapter.guiReceipt(receipt, session, {
      turn: { id: "actual-turn" },
    });
    await expect(
      started.adapter.guiDeferred(receipt, session, frame, {}),
    ).rejects.toThrow("matching native deferral");
    expect(started.client.settle).toHaveBeenCalledTimes(1);
  });

  it("resolves TUI permissions before encrypting the exact forced-policy frame", async () => {
    const f = fixture(false);
    const admitted = await f.adapter.admit({
      ...f.operation,
      kind: "settings",
      method: "thread/settings/update",
      frame: {
        id: 1,
        method: "thread/settings/update",
        params: {
          threadId: "thread",
          permissions: ":danger-full-access",
          approvalPolicy: "never",
          model: "fixture",
        },
      },
    });
    expect(f.client.resolvePermissionTransition).toHaveBeenCalledWith(
      session,
      ":yolo",
    );
    expect(f.client.refreshSettings).not.toHaveBeenCalled();
    expect(admitted.forward).toEqual({
      method: "thread/settings/update",
      params: {
        threadId: "thread",
        operationId: "operation",
        permissions: ":read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        model: "fixture",
        applyAt: "quiescent",
      },
    });
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          settingsBindingId: "binding",
          permissionTransition: {
            selectedId: ":yolo",
            resolvedSelectedId: ":yolo",
            effectiveId: ":read-only",
            expectedRevision: "4",
          },
        }),
      }),
      undefined,
    );
    expect(f.settingsDelivery.track).not.toHaveBeenCalled();
    await admitted.beforeForward();
    expect(f.settingsDelivery.track).toHaveBeenCalledWith(
      expect.objectContaining({ nativeOperationId: "operation" }),
      {
        transition: {
          selectedId: ":yolo",
          resolvedSelectedId: ":yolo",
          effectiveId: ":read-only",
          expectedRevision: "4",
        },
        source: {
          chatId: "chat",
          workerId: "worker",
          threadId: "thread",
          contextKind: "project",
          projectId: "project",
          placementId: "placement",
          modelRouteId: "route",
          providerAccountId: null,
          runtimeGeneration: "transport",
        },
      },
    );
  });
  it("admits the exact normalized TUI settings frame and registers evidence before forwarding", async () => {
    const f = fixture(false);
    const command = await f.adapter.admit({
      ...f.operation,
      kind: "settings",
      method: "thread/settings/update",
      frame: {
        id: 13,
        method: "thread/settings/update",
        params: { threadId: "thread", effort: "high", serviceTier: null },
      },
    });
    expect(command.forward).toEqual({
      method: "thread/settings/update",
      params: {
        threadId: "thread",
        effort: "high",
        serviceTier: null,
        operationId: "operation",
      },
    });
    const admission = f.client.admit.mock.calls[0]![0] as any;
    expect(admission.intent.settingKeys).toEqual(["effort", "serviceTier"]);
    expect(admission.intent.nativeSettingsOperationId).toBe("operation");
    const content = await openNativeCommandContent({
      service: {
        ownerId: () => "owner",
        serverIdentity: () => "server",
        componentKey: () => ({
          keyRevision: 1,
          key: new Uint8Array(32).fill(7),
        }),
      },
      context: {
        chatId: "chat",
        operationId: "operation",
        direction: "request",
      },
      envelope: admission.protectedPayload,
    });
    expect(content).toEqual({ id: 13, ...command.forward });
    expect(f.settingsDelivery.track).not.toHaveBeenCalled();
    await command.beforeForward();
    expect(f.settingsDelivery.track).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation",
        nativeOperationId: "operation",
        operationGeneration: "operation-generation",
        runtimeGeneration: "transport",
      }),
    );
    await command.settle({
      result: { operationId: "operation", submissionId: "queued-submission" },
    });
    expect(f.settingsDelivery.record).toHaveBeenCalledWith(
      expect.anything(),
      "queued",
      "queued-submission",
      expect.anything(),
    );
    expect(f.publication.complete).not.toHaveBeenCalled();
  });

  it("passes the admitted settings rewrite to GUI dispatch and retains immediate native rejection", async () => {
    const f = fixture(false);
    const dispatch = vi.fn(async (forward) => {
      expect(f.settingsDelivery.track).toHaveBeenCalledTimes(1);
      expect(forward.params.operationId).toBe("operation");
      throw new CodexNativeRpcError("Invalid effort", {
        code: -32600,
        message: "Invalid effort",
      });
    });
    await expect(
      f.adapter.executeGuiCommand(session, {
        operationId: "operation",
        method: "thread/settings/update",
        params: { threadId: "thread", effort: "bad" },
        dispatch,
      }),
    ).rejects.toThrow("Invalid effort");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.settingsDelivery.record).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation" }),
      "rejected",
      null,
      { error: { code: -32600, message: "Invalid effort" } },
    );
    expect(f.client.settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", executionComplete: false }),
    );
  });

  it("orders clear after the prior native setter response without waiting for its server receipt or model work", async () => {
    const f = fixture(false);
    const setter = await f.adapter.admit({
      ...f.operation,
      kind: "mutation",
      method: "thread/goal/set",
      queueClaim: { id: "claim", promptRevision: 1 },
      frame: {
        method: "thread/goal/set",
        params: { threadId: "thread", objective: "earlier" },
      },
    });
    await setter.beforeForward();
    const clear = await f.adapter.admit({
      ...f.operation,
      operationId: "clear",
      kind: "mutation",
      method: "thread/goal/clear",
      frame: { method: "thread/goal/clear", params: { threadId: "thread" } },
    });
    const forwarded = vi.fn();
    const clearing = clear.beforeForward().then(forwarded);
    await vi.waitFor(() => expect(f.client.dispatch).toHaveBeenCalledTimes(2));
    expect(forwarded).not.toHaveBeenCalled();
    const serverReceipt = deferred<void>();
    f.client.settle.mockImplementation(async () => serverReceipt.promise);
    const setting = setter.settle({
      result: { goal: {}, goalEpoch: "goal:1" },
    });
    await clearing;
    expect(forwarded).toHaveBeenCalledOnce();
    expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
    serverReceipt.resolve();
    await setting;
    await clear.settle({ result: {} });
  });

  it("holds a queued goal handoff until its actual epoch receipt is durably settled, while cancellation remains immediate", async () => {
    const f = fixture(false);
    const admission = await f.adapter.admit({
      ...f.operation,
      kind: "mutation",
      method: "thread/goal/set",
      queueClaim: { id: "claim", promptRevision: 1 },
      frame: {
        method: "thread/goal/set",
        params: { threadId: "thread", objective: "first goal" },
      },
    });
    await admission.beforeForward();
    const settled = deferred<void>();
    f.client.settle.mockImplementation(async () => settled.promise);
    const waiter = vi.fn();
    const waiting = f.adapter
      .awaitGoalMutationSettled(new AbortController().signal)
      .then(waiter);
    const cancelled = new AbortController();
    const stopped = f.adapter.awaitGoalMutationSettled(cancelled.signal);
    cancelled.abort(new Error("Stop"));
    await expect(stopped).rejects.toThrow("Stop");
    const acknowledgment = admission.settle({
      result: { goal: { objective: "first goal" }, goalEpoch: "goal-id:4" },
    });
    await vi.waitFor(() => expect(f.client.settle).toHaveBeenCalled());
    expect(f.client.settle).toHaveBeenCalledWith(
      expect.objectContaining({ goalEpoch: "goal-id:4", status: "applied" }),
    );
    expect(waiter).not.toHaveBeenCalled();
    settled.resolve();
    await Promise.all([acknowledgment, waiting]);
    expect(waiter).toHaveBeenCalledOnce();
  });

  it("binds a queued command claim to the exact GUI mutation admission", async () => {
    const f = fixture(false);
    const dispatch = vi.fn(async () => ({}));
    await f.adapter.executeGuiCommand(session, {
      operationId: "queued-effect",
      queueClaim: { id: "claim", promptRevision: 7 },
      method: "thread/settings/update",
      params: { threadId: "thread", model: "model" },
      dispatch,
    });
    expect(f.client.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "queued-effect",
        queueClaim: { id: "claim", promptRevision: 7 },
      }),
      undefined,
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });
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
        method: "thread/revert",
        params: { threadId: "thread", beforeTurnId: "turn" },
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
      undefined,
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
      goalEpoch: "goal-id:4",
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
      {
        claimId: "claim",
        operationId: "parent-goal",
        operationGeneration: "parent-generation",
        goalEpoch: "goal-id:4",
      },
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
        goalQueueHandoff: {
          claimId: "claim",
          operationId: "parent-goal",
          operationGeneration: "parent-generation",
          goalEpoch: "goal-id:4",
        },
        intent: expect.objectContaining({ expectedTurnId: "turn" }),
      }),
      { continueUnobservedGoalAdmission: true },
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
          terminalStatus: "completed",
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
      undefined,
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

  it("binds explicit GUI settings in admission metadata without adding native parameters", async () => {
    const f = fixture(false);
    const params = {
      threadId: "thread",
      operationId: "operation",
      effort: "high",
      serviceTier: null,
    };
    const dispatch = vi.fn(async () => ({
      operationId: "operation",
      submissionId: "submission",
    }));
    await f.adapter.executeGuiCommand(session, {
      operationId: "operation",
      settingsBindingId: "settings-source",
      method: "thread/settings/update",
      params,
      dispatch,
    });
    const input = f.client.admit.mock.calls[0]![0];
    expect(input.intent).toMatchObject({
      settingsBindingId: "settings-source",
      nativeSettingsOperationId: "operation",
      settingKeys: ["effort", "serviceTier"],
    });
    expect(
      await openNativeCommandContent({
        service: {
          ownerId: () => "owner",
          serverIdentity: () => "server",
          componentKey: () => ({
            keyRevision: 1,
            key: new Uint8Array(32).fill(7),
          }),
        },
        context: {
          chatId: "chat",
          operationId: "operation",
          direction: "request",
        },
        envelope: input.protectedPayload,
      }),
    ).toEqual({ id: "operation", method: "thread/settings/update", params });
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
      undefined,
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
      undefined,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.runtime.resolveAdmittedNativeReply).not.toHaveBeenCalled();
    expect(f.order).toEqual(["dispatch", "native-reply", "receipt"]);
  });
});

function restoredFixture(logical = true) {
  const f = fixture();
  const source = {
    operationId: "original-input",
    operationGeneration: "original-generation",
  };
  const logicalRoot = logical
    ? {
        operationId: "logical-input",
        operationGeneration: "logical-generation",
      }
    : null;
  const restoredReceipt = {
    ...receipt,
    method: "thread/resume",
    operationId: "restored-observer",
    logicalOperationId: logicalRoot?.operationId ?? null,
  };
  const controlId = "f57d812b-37d4-4d1e-b87a-3503b0d89b23";
  const owner = {
    workerGeneration: "current-worker-generation",
    runtimeGeneration: "transport",
    operationId: restoredReceipt.operationId,
    operationGeneration: restoredReceipt.operationGeneration,
  };
  const grant: Awaited<
    ReturnType<NativeCommandClient["admitSuspendedExecution"]>
  > = {
    receipt: restoredReceipt,
    execution: null,
    computerUseAuthority: null,
    source,
    logicalRoot,
    suspension: {
      version: 1,
      controlId,
      action: "resume",
      phase: "resuming",
      target: {
        workerId: "worker",
        contextKind: "project",
        projectId: "project",
        placementId: "placement",
        placementRevision: 1,
        cantripOsBindingId: null,
        executionLaneId: "lane",
        modelRouteId: "route",
        providerAccountId: null,
        threadId: "thread",
        originalOperationId: source.operationId,
      },
      active: { threadId: "thread", turnId: "turn" },
      checkpoint: {
        suspension: durablePauseResult.suspension,
        storageId: controlId,
        runtimeVersion: "fixture",
        runtimeFingerprint: null,
      },
      actor: owner,
      executionOwner: owner,
      actorControlId: controlId,
      error: null,
      requestedAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      pausedAt: receipt.createdAt,
      pausedMilliseconds: 0,
    },
  };
  const continuation = workerTurnContinuationSchema.parse({
    version: 1,
    threadId: "thread",
    turnId: "turn",
    chatId: "chat",
    cwd: "/tmp",
    capturedAtMs: 1,
    startedAtMs: 1,
    providerId: "provider",
    providerKind: "chatgpt",
    executionKind: "chat",
    baseline: [],
    model: f.publication.options.model,
    initialSettings: null,
    nativeModelAttribution: null,
    inheritThreadSettings: true,
    collaborationMode: null,
    latestUsage: null,
    contextUsage: null,
    contextUsageUpdatedAtMs: null,
    delta: "",
    finalText: null,
    durationMs: null,
    diffChanges: [],
    commandTelemetry: [],
    completedCommandIds: [],
    fileStartedAtMs: [],
    itemStartedAtMs: [],
    liveAgentMessageFingerprints: [],
    observedActivityFingerprints: [],
    pendingActivities: [],
    pendingAgentMessage: null,
    streamingAgentMessage: null,
    reasoningSummaries: [],
    structuredChat: false,
    structuredOutputSchema: null,
    goalCompletion: null,
  });
  return { ...f, grant, continuation };
}

describe("restored managed execution publication", () => {
  it.each([true, false])(
    "restores an idle observer and preserves original provenance (GUI logical input: %s)",
    async (logical) => {
      const f = restoredFixture(logical);
      const restored = await f.adapter.restoreSuspendedExecution(
        f.grant,
        session,
        f.continuation,
      );
      expect(f.runtime.prepareAdmittedNativeExecution).not.toHaveBeenCalled();
      expect(f.runtime.prepareRestoredNativeExecution).toHaveBeenCalledOnce();
      expect(f.beginExecution).toHaveBeenCalledWith(
        f.grant,
        session,
        f.grant.source,
      );
      expect(f.order).toEqual(["dispatch", "restore", "receipt"]);
      const prepared = f.runtime.prepareRestoredNativeExecution.mock
        .calls[0] as unknown as [Record<string, unknown>, unknown, unknown];
      expect(prepared[0]).toMatchObject({
        operationGeneration: receipt.operationGeneration,
        expectedTurnId: "turn",
        threadId: "thread",
      });
      expect(prepared.slice(1)).toEqual([
        durablePauseResult.suspension,
        f.continuation,
      ]);
      expect(f.client.settle.mock.calls[0]![0]).toMatchObject({
        operationId: "restored-observer",
        executionComplete: false,
      });
      restored.assertCurrent();
      f.done.resolve(result);
      await restored.completion;
      expect(f.order).toEqual([
        "dispatch",
        "restore",
        "receipt",
        "complete",
        "release",
        "finish",
      ]);
      expect(f.client.settle.mock.lastCall![0]).toMatchObject({
        operationId: "restored-observer",
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn",
          runtimeGeneration: "transport",
          terminalStatus: "completed",
        },
      });
    },
  );

  it("joins concurrent restoration and a lost preparation acknowledgement without another dispatch", async () => {
    const f = restoredFixture();
    const [first, second] = await Promise.all([
      f.adapter.restoreSuspendedExecution(f.grant, session, f.continuation),
      f.adapter.restoreSuspendedExecution(f.grant, session, f.continuation),
    ]);
    expect(first).toBe(second);
    const replayed = {
      ...f.grant,
      replayed: true,
      receipt: { ...f.grant.receipt, status: "applied" as const },
    };
    expect(
      await f.adapter.restoreSuspendedExecution(
        replayed,
        session,
        f.continuation,
      ),
    ).toBe(first);
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(f.runtime.prepareRestoredNativeExecution).toHaveBeenCalledOnce();
    const other = structuredClone(f.grant);
    other.suspension.checkpoint!.suspension.revision++;
    await expect(
      f.adapter.restoreSuspendedExecution(other, session, f.continuation),
    ).rejects.toThrow("Another restored observer");
    f.done.resolve(result);
    await first.completion;
  });

  it("retains an immutable comparison when caller bookkeeping changes after preparation", async () => {
    const f = restoredFixture();
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    f.continuation.delta = "different saved bookkeeping";
    await expect(
      f.adapter.restoreSuspendedExecution(f.grant, session, f.continuation),
    ).rejects.toThrow("Another restored observer");
    f.done.resolve(result);
    await restored.completion;
  });

  it("forwards restored inference only at the admitted explicit Resume boundary", async () => {
    const f = restoredFixture();
    const dispatchInference = vi.fn(() => {
      f.order.push("forward-restored-inference");
    });
    f.handle.dispatchInference = dispatchInference;
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    expect(dispatchInference).not.toHaveBeenCalled();
    f.client.admit.mockResolvedValueOnce({
      receipt: {
        ...receipt,
        method: "turn/pause",
        operationId: "resume-control",
        operationGeneration: "resume-generation",
        startsExecution: false,
      },
      execution: null,
      computerUseAuthority: null,
    });
    const resume = await f.adapter.admit({
      ...f.operation,
      operationId: "resume-control",
      kind: "control",
      method: "turn/pause",
      frame: {
        id: 2,
        method: "turn/pause",
        params: { threadId: "thread", turnId: "turn", paused: false },
      },
    });
    expect(dispatchInference).not.toHaveBeenCalled();
    await resume.beforeForward();
    expect(f.order.slice(0, 5)).toEqual([
      "dispatch",
      "restore",
      "receipt",
      "dispatch",
      "forward-restored-inference",
    ]);
    await resume.beforeForward();
    expect(dispatchInference).toHaveBeenCalledOnce();
    await resume.settle({ result: {} });
    f.done.resolve(result);
    await restored.completion;
  });

  it("keeps the restored source current when a stale Stop is rejected at dispatch", async () => {
    const f = restoredFixture();
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    const source = (
      f.runtime.prepareRestoredNativeExecution.mock.calls[0] as unknown as [
        { inferenceSource: { assertCurrent(): void } },
      ]
    )[0].inferenceSource;
    f.client.admit.mockResolvedValueOnce({
      receipt: {
        ...receipt,
        method: "turn/interrupt",
        operationId: "stale-stop",
        operationGeneration: "stale-stop-generation",
        startsExecution: false,
      },
      execution: null,
      computerUseAuthority: null,
    });
    const stop = await f.adapter.admit({
      ...f.operation,
      operationId: "stale-stop",
      kind: "control",
      method: "turn/interrupt",
    });
    f.client.dispatch.mockRejectedValueOnce(new Error("stale control epoch"));
    await expect(stop.beforeForward()).rejects.toThrow("stale control epoch");
    expect(() => source.assertCurrent()).not.toThrow();
    f.done.resolve(result);
    await restored.completion;
  });

  it("waits for protected publication before sending terminal evidence", async () => {
    const f = restoredFixture();
    const flushed = deferred<void>();
    f.publication.complete.mockImplementation(async () => {
      await flushed.promise;
    });
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    f.done.resolve(result);
    await vi.waitFor(() =>
      expect(f.publication.complete).toHaveBeenCalledOnce(),
    );
    expect(f.client.settle).toHaveBeenCalledTimes(1);
    flushed.resolve();
    await restored.completion;
    expect(f.client.settle.mock.lastCall![0].executionComplete).toBe(true);
  });

  it("keeps transport loss nonterminal and reports the observer failure", async () => {
    const f = restoredFixture();
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    f.done.reject(new Error("transport lost"));
    await expect(restored.completion).rejects.toThrow("transport lost");
    expect(
      f.client.settle.mock.calls.every(([input]) => !input.executionComplete),
    ).toBe(true);
    expect(f.client.settle.mock.lastCall![0]).toMatchObject({
      status: "uncertain",
      executionComplete: false,
    });
    expect(f.onError).toHaveBeenCalledOnce();
    await f.adapter.awaitExecutionReleased();
  });

  it("settles an actual native Stop idle after publication", async () => {
    const f = restoredFixture();
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    f.done.reject(
      new CodexTurnFailureError(
        "stopped",
        null,
        "thread",
        "turn",
        "interrupted",
      ),
    );
    await restored.completion;
    expect(f.client.settle.mock.lastCall![0]).toMatchObject({
      executionComplete: true,
      executionStatus: "idle",
      reconciliation: {
        nativeTurnId: "turn",
        runtimeGeneration: "transport",
        terminalStatus: "interrupted",
      },
    });
    expect(f.publication.release).toHaveBeenCalledOnce();
  });

  it("releases a failed restoration without manufacturing a terminal receipt", async () => {
    const f = restoredFixture();
    f.runtime.prepareRestoredNativeExecution.mockRejectedValueOnce(
      new Error("corrupt checkpoint"),
    );
    await expect(
      f.adapter.restoreSuspendedExecution(f.grant, session, f.continuation),
    ).rejects.toThrow("corrupt checkpoint");
    expect(f.publication.release).toHaveBeenCalledOnce();
    expect(f.client.settle).not.toHaveBeenCalled();
    await f.adapter.awaitExecutionReleased();
  });

  it("does not publish or restore after actual dispatch rejection", async () => {
    const f = restoredFixture();
    f.client.dispatch.mockRejectedValueOnce(new Error("stale control"));
    await expect(
      f.adapter.restoreSuspendedExecution(f.grant, session, f.continuation),
    ).rejects.toThrow("stale control");
    expect(f.beginExecution).not.toHaveBeenCalled();
    expect(f.runtime.prepareRestoredNativeExecution).not.toHaveBeenCalled();
    expect(f.client.settle).not.toHaveBeenCalled();
    await f.adapter.awaitExecutionReleased();
  });

  it("does not settle terminal success when publication fails", async () => {
    const f = restoredFixture();
    f.publication.complete.mockRejectedValueOnce(
      new Error("publication unavailable"),
    );
    const restored = await f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
    );
    f.done.resolve(result);
    await expect(restored.completion).rejects.toThrow(
      "publication unavailable",
    );
    expect(
      f.client.settle.mock.calls.every(([input]) => !input.executionComplete),
    ).toBe(true);
    expect(f.publication.release).toHaveBeenCalledOnce();
  });

  it("cancels a pending restoration with the worker lifetime without terminal evidence", async () => {
    const f = restoredFixture();
    const pending = deferred<AdmittedNativeExecution>();
    const worker = new AbortController();
    f.runtime.prepareRestoredNativeExecution.mockImplementationOnce(
      () => pending.promise,
    );
    const restore = f.adapter.restoreSuspendedExecution(
      f.grant,
      session,
      f.continuation,
      worker.signal,
    );
    await vi.waitFor(() =>
      expect(f.runtime.prepareRestoredNativeExecution).toHaveBeenCalledOnce(),
    );
    worker.abort(new Error("worker transport ended"));
    pending.resolve(f.handle);
    await expect(restore).rejects.toThrow("no longer owns inference");
    expect(f.client.settle).not.toHaveBeenCalled();
    expect(f.publication.release).toHaveBeenCalledOnce();
    await f.adapter.awaitExecutionReleased();
  });

  it("rejects a replaced transport and does not accept another observer identity", async () => {
    const f = restoredFixture();
    await expect(
      f.adapter.restoreSuspendedExecution(
        f.grant,
        { ...session, runtimeGeneration: "old" },
        f.continuation,
      ),
    ).rejects.toThrow("transport was replaced");
    const other = structuredClone(f.grant);
    other.suspension.executionOwner!.operationGeneration = "different-owner";
    await expect(
      f.adapter.restoreSuspendedExecution(other, session, f.continuation),
    ).rejects.toThrow("current suspension admission");
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });
});
