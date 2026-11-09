import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { queuedPromptOpaqueContentSchema } from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { acquireChatTurnExecution } from "../src/app/runtime/chat-turn-admission.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

it("settles a rejected GUI start, retains the prompt, and exposes an editable claim across restart", async () => {
  const f = await createNativeSettingsFixture();
  try {
    const [model] = await f.db.select().from(schema.modelProfiles).limit(1);
    const protectedContent = {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: settingsEnvelope,
    };
    const prompt = queuedPromptOpaqueContentSchema.parse({
      id: randomUUID(),
      classification: { mode: "default", attachmentIds: [] },
      protectedContent,
      modelId: model!.id,
      idempotencyKey: "rejected-input",
      pendingMessage: {
        id: randomUUID(),
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent,
        idempotencyKey: "rejected-input",
        reasoningEffort: null,
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
    const { nativeCommandReceipt: receipt } = await acquireChatTurnExecution({
      repository: f.repository,
      ownerId: LOCAL_USER_ID,
      context: (await f.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        f.chatId,
      ))!,
      options: {
        managedQueueClaim: {
          id: claim.id,
          promptRevision: claim.promptRevision,
        },
      },
      protectedAdmissionInput: prompt.pendingMessage!,
      observeTaskTurnBootstrapStage: (_stage, run) => run(),
    });
    expect(receipt).toBeTruthy();
    const dispatch = {
      workerId: f.workerId,
      operationId: receipt!.operationId,
      operationGeneration: receipt!.operationGeneration,
      payloadDigest: receipt!.payloadDigest,
      session: (await f.input("gui")).session,
    };
    await f.commands.bindPreparation(LOCAL_USER_ID, dispatch);
    await f.commands.dispatch(LOCAL_USER_ID, dispatch);
    const before = await f.repository.managedQueue.snapshot(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(before.claims).toEqual([
      expect.objectContaining({ id: claim.id, status: "dispatched" }),
    ]);
    await f.commands.settle(LOCAL_USER_ID, {
      workerId: f.workerId,
      operationId: receipt!.operationId,
      operationGeneration: receipt!.operationGeneration,
      status: "rejected",
      rejectionCode: "native-request-rejected",
      resultDigest: "d".repeat(64),
      protectedResult: settingsEnvelope,
      executionComplete: false,
    });
    expect(
      await f.commands.finishLogicalGui(
        LOCAL_USER_ID,
        f.workerId,
        receipt!.operationId,
        receipt!.operationGeneration,
        "failed",
      ),
    ).toBe(true);
    await f.restart();
    const after = await f.repository.managedQueue.snapshot(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.claims).toEqual([
      expect.objectContaining({ id: claim.id, status: "rejected" }),
    ]);
    expect(
      await f.repository.listEncryptedQueuedPrompts(LOCAL_USER_ID, f.chatId),
    ).toEqual([expect.objectContaining({ id: prompt.id })]);
    // Rejected inputs require a deliberate user retry, never an automatic replay.
    expect(
      await f.repository.managedQueue.claimNext(LOCAL_USER_ID, f.chatId),
    ).toBeNull();
  } finally {
    await f.close();
  }
}, 60_000);
