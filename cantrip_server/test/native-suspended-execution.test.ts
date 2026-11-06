import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { retainSuspendedChatTurn } from "../src/app/runtime/retain-suspended-chat-turn.js";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import { createDurableChatStopRuntime } from "../src/app/runtime/durable-chat-stop.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
const owner = LOCAL_USER_ID;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 120_000);
beforeEach(async () => {
  await fixture.db.execute(
    sql`UPDATE chats SET native_suspension_state=NULL,automation_paused=false,managed_autonomy_stopped=false WHERE id=${fixture.chatId}`,
  );
});
afterAll(async () => {
  await fixture?.close();
});

async function capture(origin: "gui" | "terminal", fail = false) {
  const base = await fixture.input(origin);
  const session = base.session;
  const workerGeneration = randomUUID();
  const input = {
    ...base,
    method: "turn/start",
    intent: { scope: "thread" as const, settingKeys: [], expectedTurnId: null },
  };
  const { receipt: root } = await fixture.commands.admit(owner, input);
  expect(root.status).toBe("accepted");
  await fixture.commands.dispatch(owner, {
    workerId: fixture.workerId,
    workerGeneration,
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
    payloadDigest: input.payloadDigest,
    session,
  });
  const active = {
    threadId: session.threadId!,
    turnId: `turn-${root.operationId}`,
  };
  const rootAck = {
    workerId: fixture.workerId,
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
    status: "applied" as const,
    resultDigest: "b".repeat(64),
    protectedResult: settingsEnvelope,
    rejectionCode: null,
    executionComplete: false,
    reconciliation: {
      nativeTurnId: active.turnId,
      runtimeGeneration: session.runtimeGeneration!,
    },
  };
  await fixture.commands.settle(owner, rootAck);
  const control = async (stop = false) => {
    const request = {
      ...base,
      operationId: randomUUID(),
      method: stop ? "turn/interrupt" : "turn/pause",
      expectedActivationGeneration: root.activationGeneration,
      intent: {
        scope: "thread" as const,
        settingKeys: [],
        durableSuspension: true as const,
        workerGeneration,
        expectedTurnId: active.turnId,
        ...(stop ? {} : { paused: true, resumeAutonomy: false }),
      },
    };
    const { receipt } = await fixture.commands.admit(owner, request);
    expect(receipt.status).toBe("accepted");
    await fixture.commands.dispatch(owner, {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: request.payloadDigest,
      session,
    });
    return {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied" as const,
      resultDigest: "c".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: false,
      durableSuspension: true as const,
    };
  };
  const pause = await control();
  const evidence = {
    suspension: { ...active, checkpointId: randomUUID(), revision: 1 },
    storageId: randomUUID(),
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  await fixture.commands.settle(
    owner,
    fail
      ? {
          ...pause,
          status: "uncertain",
          resultDigest: null,
          protectedResult: null,
          rejectionCode: "native-resources-active",
        }
      : { ...pause, suspensionEvidence: evidence },
  );
  return { root, rootAck, active, evidence, control };
}

describe("committed native suspension retains execution across transport loss", () => {
  it.each([false, true])(
    "uses a surviving Stop owner without resolving an unavailable model route (capture failed: %s)",
    async (fail) => {
      const captured = await capture("gui", fail);
      const saved = await fixture.repository.nativeSuspensions.read(
        owner,
        fixture.chatId,
      );
      const context = await fixture.commands.controlContext(
        owner,
        fixture.chatId,
      );
      await fixture.commands.stopAutonomy(
        owner,
        fixture.chatId,
        context.activationGeneration,
      );
      const request = vi.fn(async (_worker, command) => {
        expect(command.type).toBe("chat.native-control");
        expect(command.control).toEqual({ kind: "interrupt" });
        await fixture.commands.settle(owner, await captured.control(true));
        return { interrupted: true };
      });
      const runtimeForContext = vi.fn(async () => null);
      const stop = createDurableChatStopRuntime({
        repository: fixture.repository,
        bridge: { request, isConnected: () => true } as never,
        runtimeForContext,
        routePairsForConfiguration: vi.fn() as never,
        publishChatSummary: vi.fn(),
      });
      await expect(
        stop(owner, context.context!, context, saved!),
      ).resolves.toEqual({ interrupted: true });
      expect(request).toHaveBeenCalledOnce();
      expect(runtimeForContext).not.toHaveBeenCalled();
      await fixture.commands.finishLogicalGui(
        owner,
        fixture.workerId,
        captured.root.operationId,
        captured.root.operationGeneration,
        "idle",
      );
    },
  );
  it("retains a failed live Stop without attempting a fresh attachment when no checkpoint exists", async () => {
    const captured = await capture("gui", true);
    const saved = await fixture.repository.nativeSuspensions.read(
      owner,
      fixture.chatId,
    );
    const control = await fixture.commands.controlContext(
      owner,
      fixture.chatId,
    );
    const request = vi.fn(async () => {
      throw new Error("Original worker is unavailable");
    });
    const runtimeForContext = vi.fn(async () => null);
    const stop = createDurableChatStopRuntime({
      repository: fixture.repository,
      bridge: { request, isConnected: () => true } as never,
      runtimeForContext,
      routePairsForConfiguration: vi.fn() as never,
      publishChatSummary: vi.fn(),
    });
    await expect(
      stop(owner, control.context!, control, saved!),
    ).rejects.toThrow("No durable pause was saved");
    expect(request).toHaveBeenCalledOnce();
    expect(runtimeForContext).not.toHaveBeenCalled();
    expect(
      await fixture.repository.nativeSuspensions.read(owner, fixture.chatId),
    ).toMatchObject({
      phase: "error",
      action: "stop",
      checkpoint: null,
      error: { code: "stop-failed" },
    });
    const [chat] = await fixture.db
      .select({ paused: schema.chats.automationPaused })
      .from(schema.chats)
      .where(eq(schema.chats.id, fixture.chatId));
    expect(chat.paused).toBe(true);
    await fixture.commands.settle(owner, await captured.control(true));
    await fixture.commands.finishLogicalGui(
      owner,
      fixture.workerId,
      captured.root.operationId,
      captured.root.operationGeneration,
      "idle",
    );
  });
  it("admits only a Stop observer after Stop fences a pending Resume and cancels autonomy", async () => {
    const { root, evidence } = await capture("gui");
    const resume = await fixture.repository.nativeSuspensions.request(
      owner,
      fixture.chatId,
      "resume",
    );
    const base = await fixture.input("gui");
    const request = {
      workerId: fixture.workerId,
      workerGeneration: randomUUID(),
      session: {
        ...base.session,
        runtimeGeneration: "pending-resume-runtime",
        connectionId: "pending-resume-owner",
      },
      operationId: randomUUID(),
      controlId: resume.state.controlId,
      checkpoint: evidence,
      payloadDigest: "e".repeat(64),
      protectedPayload: settingsEnvelope,
    };
    const pending = await fixture.commands.admitSuspendedExecution(
      owner,
      request,
    );
    const stopping = await fixture.repository.nativeSuspensions.request(
      owner,
      fixture.chatId,
      "stop",
    );
    await fixture.commands.stopAutonomy(
      owner,
      fixture.chatId,
      pending.receipt.activationGeneration,
    );
    const stop = {
      ...request,
      action: "stop" as const,
      operationId: randomUUID(),
      controlId: stopping.state.controlId,
      session: {
        ...request.session,
        connectionId: "stop-owner",
      },
    };
    await expect(
      fixture.commands.admitSuspendedExecution(owner, {
        ...stop,
        action: "resume",
      }),
    ).rejects.toMatchObject({ code: "suspension-control-stale" });
    const admitted = await fixture.commands.admitSuspendedExecution(
      owner,
      stop,
    );
    expect(admitted.source.operationId).toBe(root.operationId);
    expect(admitted.suspension).toMatchObject({
      action: "stop",
      phase: "stopping",
      checkpoint: evidence,
    });
    expect(
      (
        await fixture.commands.admitSuspendedExecution(owner, {
          ...stop,
          operationId: randomUUID(),
        })
      ).receipt.operationId,
    ).toBe(admitted.receipt.operationId);
    await expect(
      fixture.commands.dispatch(owner, {
        workerId: request.workerId,
        workerGeneration: request.workerGeneration,
        session: request.session,
        operationId: pending.receipt.operationId,
        operationGeneration: pending.receipt.operationGeneration,
        payloadDigest: request.payloadDigest,
      }),
    ).rejects.toBeDefined();
    await fixture.commands.dispatch(owner, {
      workerId: stop.workerId,
      workerGeneration: stop.workerGeneration,
      session: stop.session,
      operationId: admitted.receipt.operationId,
      operationGeneration: admitted.receipt.operationGeneration,
      payloadDigest: stop.payloadDigest,
    });
    const [activation] = await fixture.db
      .select()
      .from(schema.nativeCommandActivations)
      .where(eq(schema.nativeCommandActivations.chatId, fixture.chatId));
    expect(activation).toMatchObject({
      logicalCancelled: true,
      operationId: admitted.receipt.operationId,
    });
    const [chat] = await fixture.db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, fixture.chatId));
    expect(chat?.managedAutonomyStopped).toBe(true);
    await fixture.repository.nativeSuspensions.stopped(
      owner,
      fixture.chatId,
      stopping.state.controlId,
      admitted.suspension.actor,
    );
    await fixture.commands.finishLogicalGui(
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
      "idle",
    );
  });
  it("requires the current authenticated worker incarnation and correlates canonical admission through the actual HTTP handler", async () => {
    const { root, active, evidence } = await capture("gui");
    const resume = await fixture.repository.nativeSuspensions.request(
      owner,
      fixture.chatId,
      "resume",
    );
    const base = await fixture.input("gui");
    const workerGeneration = randomUUID();
    const session = {
      ...base.session,
      runtimeGeneration: "http-cold-runtime",
      connectionId: "http-cold-owner",
    };
    const app = Fastify();
    installInternalNativeCommandRoutes(app, {
      config: fixture.config,
      serverId: "fixture-server",
      repository: fixture.repository,
      runAsOwner: async (_owner, run) => run(),
      dispatchNextQueuedPrompt: async () => {},
      bridge: {
        connectionIdentity: () => ({
          ownerId: owner,
          workerProcessGeneration: workerGeneration,
        }),
        isConnected: () => true,
      } as never,
      live: {
        publishEncryptedChatMessage() {},
        publishTaskMessage() {},
        publishChatSummary() {},
        publishChatTurnBoundary() {},
        publishChatInvalidation() {},
      },
    });
    const request = {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: randomUUID(),
      session,
      controlId: resume.state.controlId,
      checkpoint: evidence,
      payloadDigest: "e".repeat(64),
      protectedPayload: settingsEnvelope,
    };
    const post = (body: unknown, authorized = true) =>
      app.inject({
        method: "POST",
        url: "/api/internal/native-commands/suspension-execution",
        headers: authorized
          ? { authorization: `Bearer ${fixture.config.workerToken}` }
          : {},
        payload: body as never,
      });
    try {
      expect((await post(request, false)).statusCode).toBe(401);
      expect(
        (await post({ ...request, workerGeneration: randomUUID() })).statusCode,
      ).toBe(409);
      expect(
        (await fixture.repository.nativeSuspensions.read(owner, fixture.chatId))
          ?.executionOwner,
      ).toBeUndefined();
      let corruptScope: "receipt" | "execution" | "suspension" | null = null;
      const client = new NativeCommandClient({
        workerId: fixture.workerId,
        workerGeneration,
        serverUrl: "http://fixture.invalid",
        token: () => fixture.config.workerToken,
        fetch: async (url, init) => {
          const response = await app.inject({
            method: "POST",
            url: new URL(String(url)).pathname,
            headers: init?.headers as never,
            payload: init?.body as string,
          });
          const result = response.json();
          if (corruptScope === "suspension")
            result.suspension.target.placementId = "foreign";
          else if (corruptScope) result[corruptScope].chatId = "foreign";
          return new Response(JSON.stringify(result), {
            status: response.statusCode,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const {
        workerId: _worker,
        workerGeneration: _generation,
        ...input
      } = request;
      const admitted = await client.admitSuspendedExecution(input);
      expect(
        (
          await client.admitSuspendedExecution({
            ...input,
            operationId: randomUUID(),
          })
        ).receipt.operationId,
      ).toBe(admitted.receipt.operationId);
      for (const scope of ["receipt", "execution", "suspension"] as const) {
        corruptScope = scope;
        await expect(client.admitSuspendedExecution(input)).rejects.toThrow(
          "another observer owner",
        );
      }
      corruptScope = null;
      const stopping = await fixture.repository.nativeSuspensions.request(
        owner,
        fixture.chatId,
        "stop",
      );
      await fixture.repository.nativeSuspensions.claim(
        owner,
        fixture.chatId,
        stopping.state.controlId,
        stopping.state.actor,
        admitted.suspension.executionOwner!,
        active,
      );
      await fixture.repository.nativeSuspensions.stopped(
        owner,
        fixture.chatId,
        stopping.state.controlId,
        admitted.suspension.executionOwner!,
      );
      await fixture.commands.finishLogicalGui(
        owner,
        fixture.workerId,
        root.operationId,
        root.operationGeneration,
        "idle",
      );
    } finally {
      await app.close();
    }
  });
  it("admits a fresh physical observer without replacing input, turn or canonical history ownership", async () => {
    const { root, active, evidence } = await capture("gui");
    const resumed = await fixture.repository.nativeSuspensions.request(
      owner,
      fixture.chatId,
      "resume",
    );
    const base = await fixture.input("gui");
    const workerGeneration = randomUUID();
    const session = {
      ...base.session,
      runtimeGeneration: "fresh-cold-runtime",
      connectionId: "fresh-cold-owner",
    };
    const request = {
      workerId: fixture.workerId,
      workerGeneration,
      session,
      operationId: randomUUID(),
      controlId: resumed.state.controlId,
      checkpoint: evidence,
      payloadDigest: "e".repeat(64),
      protectedPayload: settingsEnvelope,
    };
    const admitted = await fixture.commands.admitSuspendedExecution(
      owner,
      request,
    );
    expect(admitted.receipt).toMatchObject({
      startsExecution: true,
      method: "thread/resume",
      status: "accepted",
      logicalOperationId: root.operationId,
      previousOperationId: root.operationId,
      executionLaneId: root.executionLaneId,
    });
    expect(admitted.source).toEqual({
      operationId: root.operationId,
      operationGeneration: root.operationGeneration,
    });
    expect(admitted.logicalRoot).toEqual(admitted.source);
    expect(admitted.suspension.executionOwner).toMatchObject({
      workerGeneration,
      runtimeGeneration: session.runtimeGeneration,
      operationId: admitted.receipt.operationId,
      operationGeneration: admitted.receipt.operationGeneration,
    });
    const duplicate = await fixture.commands.admitSuspendedExecution(owner, {
      ...request,
      operationId: randomUUID(),
    });
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.receipt.operationId).toBe(admitted.receipt.operationId);
    expect(
      (
        await fixture.commands.suspendedExecution(
          owner,
          fixture.workerId,
          root.operationId,
          root.operationGeneration,
        )
      )?.checkpoint,
    ).toEqual(evidence);
    await fixture.commands.dispatch(owner, {
      workerId: fixture.workerId,
      workerGeneration,
      session,
      operationId: admitted.receipt.operationId,
      operationGeneration: admitted.receipt.operationGeneration,
      payloadDigest: request.payloadDigest,
    });
    const acknowledgement = {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: admitted.receipt.operationId,
      operationGeneration: admitted.receipt.operationGeneration,
      status: "applied" as const,
      resultDigest: "f".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: active.turnId,
        runtimeGeneration: session.runtimeGeneration,
      },
    };
    await fixture.commands.settle(owner, acknowledgement);
    const child = {
      ...base,
      operationId: randomUUID(),
      method: "turn/pause",
      session,
      expectedActivationGeneration: admitted.receipt.activationGeneration,
      intent: {
        scope: "thread" as const,
        settingKeys: [],
        expectedTurnId: active.turnId,
        durableSuspension: true as const,
        workerGeneration,
        paused: false,
        resumeAutonomy: true,
        expectedSuspensionControlId: resumed.state.controlId,
      },
    };
    const childReceipt = (await fixture.commands.admit(owner, child)).receipt;
    expect(childReceipt.status).toBe("accepted");
    await fixture.commands.dispatch(owner, {
      workerId: fixture.workerId,
      workerGeneration,
      session,
      operationId: childReceipt.operationId,
      operationGeneration: childReceipt.operationGeneration,
      payloadDigest: child.payloadDigest,
    });
    await fixture.commands.settle(owner, {
      workerId: fixture.workerId,
      workerGeneration,
      durableSuspension: true,
      operationId: childReceipt.operationId,
      operationGeneration: childReceipt.operationGeneration,
      status: "applied",
      resultDigest: "1".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: false,
    });
    expect(
      (await fixture.repository.nativeSuspensions.read(owner, fixture.chatId))
        ?.phase,
    ).toBe("running");
    // The superseded GUI transport cannot close the newly running observer.
    expect(
      await fixture.commands.finishLogicalGui(
        owner,
        fixture.workerId,
        root.operationId,
        root.operationGeneration,
        "failed",
        true,
      ),
    ).toBe(false);
    expect(
      (
        await fixture.commands.suspendedExecution(
          owner,
          fixture.workerId,
          root.operationId,
          root.operationGeneration,
        )
      )?.phase,
    ).toBe("running");
    expect(
      await fixture.db
        .select()
        .from(schema.nativeCommandTurns)
        .where(
          and(
            eq(schema.nativeCommandTurns.chatId, fixture.chatId),
            eq(schema.nativeCommandTurns.threadId, active.threadId),
            eq(schema.nativeCommandTurns.turnId, active.turnId),
          ),
        ),
    ).toHaveLength(1);
    await fixture.commands.settle(owner, {
      ...acknowledgement,
      resultDigest: null,
      protectedResult: null,
      executionComplete: true,
      executionStatus: "idle",
      terminalResult: {
        resultDigest: "2".repeat(64),
        protectedResult: settingsEnvelope,
      },
      reconciliation: {
        ...acknowledgement.reconciliation,
        terminalStatus: "completed",
      },
    });
    await fixture.commands.finishLogicalGui(
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
      "idle",
    );
    expect(
      (await fixture.repository.nativeSuspensions.read(owner, fixture.chatId))
        ?.checkpoint,
    ).toBeNull();
    expect(
      (await fixture.repository.getChatExecutionContext(owner, fixture.chatId))
        ?.status,
    ).toBe("idle");
  });
  it.each(["gui", "terminal"] as const)(
    "keeps the %s root and original checkpoint through administrative cleanup and database reopen",
    async (origin) => {
      const { root, rootAck, evidence } = await capture(origin);
      const args = [
        owner,
        fixture.workerId,
        root.operationId,
        root.operationGeneration,
      ] as const;
      const rows = () =>
        fixture.db
          .select()
          .from(schema.nativeCommands)
          .where(eq(schema.nativeCommands.operationId, root.operationId));
      const before = await rows();
      expect(
        (await fixture.commands.suspendedExecution(...args))?.checkpoint,
      ).toEqual(evidence);
      expect(await fixture.commands.finishExecution(...args, "failed")).toBe(
        false,
      );
      if (origin === "gui")
        expect(
          await fixture.commands.finishLogicalGui(...args, "failed", true),
        ).toBe(false);
      expect(await rows()).toEqual(before);
      expect(
        await fixture.commands.getLogicalCompletion(
          owner,
          fixture.workerId,
          fixture.chatId,
          root.operationId,
          root.operationGeneration,
        ),
      ).toBeNull();
      const summary = vi.fn();
      const log = vi.fn();
      expect(
        await retainSuspendedChatTurn(
          {
            repository: fixture.repository,
            app: { log: { info: log } } as never,
            publishChatSummary: summary,
          },
          owner,
          fixture.workerId,
          root,
        ),
      ).toBe(true);
      expect(summary).toHaveBeenCalledWith(fixture.chatId, expect.any(String));
      expect(log).toHaveBeenCalledOnce();
      await fixture.restart();
      expect(
        (await fixture.commands.suspendedExecution(...args))?.checkpoint,
      ).toEqual(evidence);
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            owner,
            fixture.chatId,
          )
        )?.status,
      ).toBe("running");
      await fixture.commands.settle(owner, {
        ...rootAck,
        resultDigest: null,
        protectedResult: null,
        executionComplete: true,
        executionStatus: "idle",
        terminalResult: {
          resultDigest: "d".repeat(64),
          protectedResult: settingsEnvelope,
        },
        reconciliation: {
          ...rootAck.reconciliation,
          terminalStatus: "completed",
        },
      });
      expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
      if (origin === "gui") {
        await fixture.commands.finishLogicalGui(...args, "idle");
        expect((await rows())[0]!.logicalCompletedAt).not.toBeNull();
      }
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            owner,
            fixture.chatId,
          )
        )?.status,
      ).toBe("idle");
    },
  );

  it("allows explicit Stop to retire a held root and fences foreign generations", async () => {
    const { root, control } = await capture("gui");
    const args = [
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
    ] as const;
    await expect(
      fixture.commands.suspendedExecution(
        owner,
        fixture.workerId,
        root.operationId,
        "foreign",
      ),
    ).rejects.toBeDefined();
    const stop = await control(true);
    expect(
      await fixture.commands.finishLogicalGui(...args, "failed", true),
    ).toBe(false);
    await fixture.commands.settle(owner, stop);
    expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
    expect(await fixture.commands.finishLogicalGui(...args, "idle")).toBe(true);
  });

  it("releases the root when native ends before the Stop receipt arrives", async () => {
    const { root, rootAck, control } = await capture("gui");
    const args = [
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
    ] as const;
    const stop = await control(true);
    await fixture.commands.settle(owner, {
      ...rootAck,
      resultDigest: null,
      protectedResult: null,
      executionComplete: true,
      executionStatus: "idle",
      terminalResult: {
        resultDigest: "d".repeat(64),
        protectedResult: settingsEnvelope,
      },
      reconciliation: {
        ...rootAck.reconciliation,
        terminalStatus: "interrupted",
      },
    });
    expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
    expect(
      (await fixture.repository.getChatExecutionContext(owner, fixture.chatId))
        ?.status,
    ).toBe("idle");
    await fixture.commands.settle(owner, stop);
    await fixture.commands.finishLogicalGui(...args, "idle");
    expect(
      (await fixture.repository.nativeSuspensions.read(owner, fixture.chatId))
        ?.phase,
    ).toBe("stopped");
  });
});
