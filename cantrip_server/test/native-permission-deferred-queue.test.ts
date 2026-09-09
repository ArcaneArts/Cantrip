import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.js";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  queuedPromptOpaqueContentSchema,
  type NativeCommandSettlement,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  f = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});
it("retains the exact queue revision after proven no-input deferral, survives restart, and admits a fresh attempt", async () => {
  const [model] = await f.db.select().from(schema.modelProfiles).limit(1);
  const classification = { mode: "default" as const, attachmentIds: [] };
  const protectedContent = {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: settingsEnvelope,
  };
  const messageId = randomUUID();
  const prompt = queuedPromptOpaqueContentSchema.parse({
    id: randomUUID(),
    classification,
    protectedContent,
    modelId: model!.id,
    idempotencyKey: "permission-deferred-input",
    pendingMessage: {
      id: messageId,
      classification: { role: "user", ...classification },
      protectedContent,
      reasoningEffort: null,
      idempotencyKey: "permission-deferred-input",
    },
  });
  await f.repository.createEncryptedQueuedPrompt(
    LOCAL_USER_ID,
    f.chatId,
    prompt,
    [],
  );
  const claim = (await f.repository.managedQueue.claimNext(
    LOCAL_USER_ID,
    f.chatId,
  ))!;
  expect(claim).toBeTruthy();
  const request = await f.input("gui");
  request.method = "turn/start";
  request.intent = { scope: "thread", settingKeys: [], expectedTurnId: null };
  request.queueClaim = { id: claim.id, promptRevision: claim.promptRevision };
  const grant = await f.commands.admit(LOCAL_USER_ID, request);
  expect(grant.receipt.status).toBe("accepted");
  await f.commands.dispatch(LOCAL_USER_ID, {
    workerId: f.workerId,
    operationId: request.operationId,
    operationGeneration: grant.receipt.operationGeneration,
    payloadDigest: request.payloadDigest,
    session: request.session,
  });
  const settlement: NativeCommandSettlement = {
    workerId: f.workerId,
    operationId: request.operationId,
    operationGeneration: grant.receipt.operationGeneration,
    status: "rejected",
    rejectionCode: null,
    resultDigest: "d".repeat(64),
    protectedResult: settingsEnvelope,
    executionComplete: true,
    deferred: {
      reason: "pendingSettings",
      inputConsumed: false,
      threadId: request.session.threadId!,
      runtimeGeneration: request.session.runtimeGeneration!,
    },
  };
  await expect(
    f.commands.settle(LOCAL_USER_ID, {
      ...settlement,
      deferred: { ...settlement.deferred!, runtimeGeneration: "old-runtime" },
    }),
  ).rejects.toMatchObject({ code: "stale-native-deferral" });
  // A pending applied-policy publication prevents a premature wake.
  await f.db.insert(schema.nativeSettingsStates).values({
    chatId: f.chatId,
    state: {
      chatId: f.chatId,
      revision: "1",
      desiredRevision: "1",
      desired: null,
      desiredStatus: null,
      binding: null,
      effective: null,
      permissionPolicy: null,
      pending: [
        {
          intent: {
            operationId: "policy",
            operationGeneration: "policy-generation",
            origin: "terminal",
            source: {
              workerId: f.workerId,
              threadId: request.session.threadId,
              runtimeGeneration: request.session.runtimeGeneration,
            },
            payloadDigest: "c".repeat(64),
            protectedContent: settingsEnvelope,
            permissionTransition: {
              selectedId: ":workspace",
              resolvedSelectedId: ":workspace",
              effectiveId: ":workspace",
              expectedRevision: "0",
            },
          },
          desiredRevision: "1",
          bindingId: null,
          status: "dispatched",
        },
      ],
    },
  });
  expect(await f.commands.settle(LOCAL_USER_ID, settlement)).toMatchObject({
    status: "rejected",
    rejectionCode: "native-settings-pending",
    resumeQueue: false,
  });
  expect(
    await f.repository.managedQueue.claim(LOCAL_USER_ID, f.chatId, claim.id),
  ).toMatchObject({
    status: "deferred",
    promptId: prompt.id,
    promptRevision: claim.promptRevision,
  });
  expect(
    await f.repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
  ).toMatchObject({
    state: "pending",
    revision: claim.promptRevision,
    pendingMessage: { id: messageId },
  });
  expect(
    (await f.repository.getChatExecutionContext(LOCAL_USER_ID, f.chatId))
      ?.status,
  ).toBe("idle");
  expect(
    await f.repository.managedQueue.claimNext(LOCAL_USER_ID, f.chatId),
  ).toBeNull();
  expect(
    await f.repository.managedQueue.pendingDispatches(),
  ).not.toContainEqual({ ownerId: LOCAL_USER_ID, chatId: f.chatId });
  // Native publication can race ahead of a retried deferred acknowledgement.
  const [stored] = await f.db
    .select()
    .from(schema.nativeSettingsStates)
    .where(eq(schema.nativeSettingsStates.chatId, f.chatId));
  await f.db
    .update(schema.nativeSettingsStates)
    .set({ state: { ...stored!.state, revision: "2", pending: [] } })
    .where(eq(schema.nativeSettingsStates.chatId, f.chatId));
  await f.restart();
  expect(await f.commands.settle(LOCAL_USER_ID, settlement)).toMatchObject({
    resumeQueue: true,
  });
  const next = (await f.repository.managedQueue.claimNext(
    LOCAL_USER_ID,
    f.chatId,
  ))!;
  expect(next).toMatchObject({
    promptId: prompt.id,
    promptRevision: claim.promptRevision,
    status: "claimed",
  });
  expect(next.id).not.toBe(claim.id);
  const retry = await f.input("gui");
  retry.method = "turn/start";
  retry.intent = { scope: "thread", settingKeys: [], expectedTurnId: null };
  retry.queueClaim = { id: next.id, promptRevision: next.promptRevision };
  expect((await f.commands.admit(LOCAL_USER_ID, retry)).receipt.status).toBe(
    "accepted",
  );
  expect((await f.commands.admit(LOCAL_USER_ID, request)).replayed).toBe(true);
});
it.each([false, true])(
  "retains an original GUI message once after administrative completion=%s",
  async (retired) => {
    const fixture = await createNativeSettingsFixture();
    try {
      const request = await fixture.input("gui");
      request.method = "turn/start";
      request.intent = {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
      };
      const messageId = randomUUID();
      const grant = await fixture.commands.admit(LOCAL_USER_ID, request, {
        clientMessageId: messageId,
      });
      await fixture.commands.dispatch(LOCAL_USER_ID, {
        workerId: fixture.workerId,
        operationId: request.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        payloadDigest: request.payloadDigest,
        session: request.session,
      });
      const [model] = await fixture.db
        .select()
        .from(schema.modelProfiles)
        .limit(1);
      const classification = { mode: "default" as const, attachmentIds: [] };
      const protectedContent = {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: request.protectedPayload,
      };
      const prompt = queuedPromptOpaqueContentSchema.parse({
        id: randomUUID(),
        classification,
        protectedContent,
        modelId: model!.id,
        idempotencyKey: `deferred:${messageId}`,
        nativeAction: "literal",
        executionMethod: "turn/start",
        nativeClientUserMessageId: `cantrip:${messageId}`,
        protectedNativeInput: settingsEnvelope,
        pendingMessage: {
          id: messageId,
          classification: { role: "user", ...classification },
          protectedContent,
          reasoningEffort: null,
          idempotencyKey: messageId,
        },
      });
      const settlement: NativeCommandSettlement = {
        workerId: fixture.workerId,
        operationId: request.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "rejected",
        rejectionCode: null,
        resultDigest: "e".repeat(64),
        protectedResult: settingsEnvelope,
        executionComplete: true,
        deferred: {
          reason: "pendingSettings",
          inputConsumed: false,
          threadId: request.session.threadId!,
          runtimeGeneration: request.session.runtimeGeneration!,
          retainedPrompt: prompt,
          attachments: [],
        },
      };
      await expect(
        fixture.commands.settle(LOCAL_USER_ID, {
          ...settlement,
          deferred: {
            ...settlement.deferred!,
            retainedPrompt: {
              ...prompt,
              pendingMessage: { ...prompt.pendingMessage, id: randomUUID() },
            },
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-deferred-prompt" });
      if (retired) {
        await fixture.commands.settle(LOCAL_USER_ID, {
          workerId: fixture.workerId,
          operationId: request.operationId,
          operationGeneration: grant.receipt.operationGeneration,
          status: "uncertain",
          rejectionCode: "missing-native-receipt",
          resultDigest: null,
          protectedResult: null,
          executionComplete: true,
          executionStatus: "failed",
        });
        await fixture.restart();
      }
      await fixture.commands.settle(LOCAL_USER_ID, settlement);
      expect(
        await fixture.commands.hasDeferredLogicalGui(
          LOCAL_USER_ID,
          fixture.workerId,
          request.operationId,
          grant.receipt.operationGeneration,
        ),
      ).toBe(true);
      await fixture.restart();
      await fixture.commands.settle(LOCAL_USER_ID, settlement);
      const retained = await fixture.repository.listEncryptedQueuedPrompts(
        LOCAL_USER_ID,
        fixture.chatId,
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        id: prompt.id,
        state: "pending",
        pendingMessage: prompt.pendingMessage,
        protectedNativeInput: settingsEnvelope,
      });
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            fixture.chatId,
          )
        )?.status,
      ).toBe("idle");
    } finally {
      await fixture.close();
    }
  },
);

it("accepts actual worker GUI retention with canonical native client identity and separate protected fields", async () => {
  const fixture = await createNativeSettingsFixture();
  try {
    const [model] = await fixture.db
      .select()
      .from(schema.modelProfiles)
      .limit(1);
    const encryption = {
      ownerId: () => LOCAL_USER_ID,
      serverIdentity: () => "server",
      componentKey: () => ({
        keyRevision: 1,
        key: new Uint8Array(32).fill(19),
      }),
    } as unknown as WorkerEncryptionService;
    const messageId = randomUUID();
    const original = await protectChatTurn({
      service: encryption,
      messageId,
      promptId: randomUUID(),
      idempotencyKey: messageId,
      text: "Original GUI text",
      mode: "default",
      modelId: model!.id,
      reasoningEffort: null,
    });
    const codec = createManagedQueueInputCodec({
      encryption,
      chatId: fixture.chatId,
      defaults: () => ({
        mode: "default",
        modelId: model!.id,
        reasoningEffort: null,
      }),
    });
    const retained = await codec.retainGuiPrompt({
      pendingMessage: original.queuedPrompt.pendingMessage,
      attachments: [],
      input: [{ type: "text", text: "Exact unconsumed native retry context" }],
    });
    const request = await fixture.input("gui");
    request.method = "turn/start";
    request.intent = { scope: "thread", settingKeys: [], expectedTurnId: null };
    request.protectedPayload =
      original.queuedPrompt.pendingMessage.protectedContent.envelope;
    const grant = await fixture.commands.admit(LOCAL_USER_ID, request, {
      clientMessageId: messageId,
    });
    await fixture.commands.dispatch(LOCAL_USER_ID, {
      workerId: fixture.workerId,
      operationId: request.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      payloadDigest: request.payloadDigest,
      session: request.session,
    });
    await fixture.commands.settle(LOCAL_USER_ID, {
      workerId: fixture.workerId,
      operationId: request.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "rejected",
      rejectionCode: null,
      resultDigest: "d".repeat(64),
      protectedResult: settingsEnvelope,
      executionComplete: true,
      deferred: {
        reason: "pendingSettings",
        inputConsumed: false,
        threadId: request.session.threadId!,
        runtimeGeneration: request.session.runtimeGeneration!,
        retainedPrompt: retained.prompt,
        attachments: retained.attachments,
      },
    });
    const [queued] = await fixture.repository.listEncryptedQueuedPrompts(
      LOCAL_USER_ID,
      fixture.chatId,
    );
    expect(queued!.pendingMessage).toEqual(
      original.queuedPrompt.pendingMessage,
    );
    expect(await codec.openPrompt(queued!)).toMatchObject({
      clientUserMessageId: `cantrip:${messageId}`,
      input: [{ type: "text", text: "Exact unconsumed native retry context" }],
    });
  } finally {
    await fixture.close();
  }
});
it.each(["active", "retired", "replacement", "observed", "stopped"] as const)(
  "retains exact terminal input after %s recovery without replacing newer work",
  async (recovery) => {
    const fixture = await createNativeSettingsFixture();
    try {
      const request = await fixture.input("terminal");
      request.method = "turn/start";
      request.intent = {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        nativeClientUserMessageId: "terminal-client-message",
      };
      const [model] = await fixture.db
        .select()
        .from(schema.modelProfiles)
        .limit(1);
      const encryption = {
        ownerId: () => LOCAL_USER_ID,
        serverIdentity: () => "server",
        componentKey: () => ({
          keyRevision: 1,
          key: new Uint8Array(32).fill(29),
        }),
      } as unknown as WorkerEncryptionService;
      const codec = createManagedQueueInputCodec({
        encryption,
        chatId: fixture.chatId,
        defaults: () => ({
          mode: "default",
          modelId: model!.id,
          reasoningEffort: null,
        }),
      });
      const protectedTerminal = await codec.retainTerminalPrompt({
        operationId: request.operationId,
        origin: "terminal",
        kind: "start",
        method: "turn/start",
        connectionId: "view-one",
        frame: {
          params: {
            threadId: request.session.threadId,
            input: [{ type: "text", text: "Native terminal input" }],
            clientUserMessageId: "terminal-client-message",
          },
        },
        identity: {
          ...request.session,
          serverId: "server",
          ownerId: LOCAL_USER_ID,
          workerId: fixture.workerId,
          threadId: request.session.threadId!,
          runtimeGeneration: request.session.runtimeGeneration!,
        },
      });
      const prepared = {
        prompt: protectedTerminal.retainedPrompt,
        attachments: protectedTerminal.attachments,
      };
      const grant = await fixture.commands.admit(LOCAL_USER_ID, request);
      await fixture.commands.dispatch(LOCAL_USER_ID, {
        workerId: fixture.workerId,
        operationId: request.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        payloadDigest: request.payloadDigest,
        session: request.session,
      });
      const settlement: NativeCommandSettlement = {
        workerId: fixture.workerId,
        operationId: request.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "rejected",
        rejectionCode: null,
        resultDigest: "e".repeat(64),
        protectedResult: settingsEnvelope,
        executionComplete: true,
        deferred: {
          reason: "pendingSettings",
          inputConsumed: false,
          threadId: request.session.threadId!,
          runtimeGeneration: request.session.runtimeGeneration!,
        },
      };
      await expect(
        fixture.commands.settle(LOCAL_USER_ID, settlement),
      ).rejects.toMatchObject({ code: "deferred-prompt-required" });
      const retained = {
        ...settlement,
        deferred: {
          ...settlement.deferred!,
          retainedPrompt: prepared.prompt,
          attachments: prepared.attachments,
        },
      };
      await expect(
        fixture.commands.settle(LOCAL_USER_ID, {
          ...retained,
          deferred: {
            ...retained.deferred,
            retainedPrompt: {
              ...prepared.prompt,
              nativeClientUserMessageId: "different-input",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-deferred-prompt" });
      if (recovery !== "active") {
        await fixture.commands.finishExecution(
          LOCAL_USER_ID,
          fixture.workerId,
          request.operationId,
          grant.receipt.operationGeneration,
          "failed",
        );
        await fixture.restart();
      }
      if (recovery === "observed") {
        await fixture.db.insert(schema.nativeCommandTurns).values({
          operationId: request.operationId,
          chatId: fixture.chatId,
          threadId: request.session.threadId!,
          runtimeGeneration: request.session.runtimeGeneration!,
          turnId: "already-observed-turn",
        });
        await expect(
          fixture.commands.settle(LOCAL_USER_ID, retained),
        ).rejects.toMatchObject({ code: "stale-native-deferral" });
        expect(
          await fixture.repository.listEncryptedQueuedPrompts(
            LOCAL_USER_ID,
            fixture.chatId,
          ),
        ).toHaveLength(0);
        return;
      }
      if (recovery === "replacement") {
        const next = await fixture.input("terminal");
        next.method = "turn/start";
        next.intent = {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: null,
        };
        const nextGrant = await fixture.commands.admit(LOCAL_USER_ID, next);
        await fixture.commands.dispatch(LOCAL_USER_ID, {
          workerId: fixture.workerId,
          operationId: next.operationId,
          operationGeneration: nextGrant.receipt.operationGeneration,
          payloadDigest: next.payloadDigest,
          session: next.session,
        });
      }
      if (recovery === "stopped")
        await fixture.commands.stopAutonomy(
          LOCAL_USER_ID,
          fixture.chatId,
          null,
        );
      const activationBefore = await fixture.db
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, fixture.chatId));
      await fixture.commands.settle(LOCAL_USER_ID, retained);
      await fixture.restart();
      await fixture.commands.settle(LOCAL_USER_ID, retained);
      if (recovery === "replacement") {
        const activationAfter = await fixture.db
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, fixture.chatId));
        expect(activationAfter).toEqual(activationBefore);
        expect(activationAfter[0]!.active).toBe(true);
      }
      const queued = await fixture.repository.listEncryptedQueuedPrompts(
        LOCAL_USER_ID,
        fixture.chatId,
      );
      expect(queued).toHaveLength(1);
      expect(await codec.openPrompt(queued[0]!)).toMatchObject({
        clientUserMessageId: "terminal-client-message",
        input: [{ type: "text", text: "Native terminal input" }],
      });
      if (recovery === "stopped") {
        expect(
          (
            await fixture.repository.managedQueue.snapshot(
              LOCAL_USER_ID,
              fixture.chatId,
            )
          ).paused,
        ).toBe(true);
        expect(
          await fixture.repository.managedQueue.claimNext(
            LOCAL_USER_ID,
            fixture.chatId,
          ),
        ).toBeNull();
      } else if (recovery !== "replacement")
        expect(
          (
            await fixture.repository.managedQueue.claimNext(
              LOCAL_USER_ID,
              fixture.chatId,
            )
          )?.promptId,
        ).toBe(prepared.prompt.id);
    } finally {
      await fixture.close();
    }
  },
);
