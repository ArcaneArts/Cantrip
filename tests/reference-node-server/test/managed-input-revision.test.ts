import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import { mutateManagedGuiQueue } from "../src/app/runtime/managed-queue-input.js";
import { queuedPromptOpaqueContentSchema } from "@cantrip/protocol";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeEach(async () => {
  f = await createNativeSettingsFixture();
}, 60000);
afterEach(async () => {
  await f.close();
});
const context = () =>
  f.repository.getChatExecutionContext(owner, f.chatId).then((value) => value!);
async function input() {
  return {
    ...(await f.input("gui")),
    method: "turn/start",
    intent: { scope: "thread" as const, settingKeys: [], expectedTurnId: null },
  };
}
it("retains Stop across a database restart and durably rejects the waiting operation, including replay", async () => {
  const pending = await context();
  const request = await input();
  expect(await f.commands.stopAutonomy(owner, f.chatId, null)).toBe(true);
  await f.restart();
  const rejected = await f.commands.admit(owner, request, {
    expectedInputRevision: pending.managedInputRevision,
  });
  expect(rejected.receipt).toMatchObject({
    status: "rejected",
    rejectionCode: "cancelled-before-admission",
  });
  expect((await context()).executionLaneId).toBeNull();
  expect(
    (
      await f.commands.admit(owner, request, {
        expectedInputRevision: (await context()).managedInputRevision,
      })
    ).receipt,
  ).toEqual(rejected.receipt);
});
it("allows newly submitted input after Stop and does not let a stale Stop cancel it", async () => {
  await f.commands.stopAutonomy(owner, f.chatId, null);
  const current = await context();
  const admitted = await f.commands.admit(owner, await input(), {
    expectedInputRevision: current.managedInputRevision,
  });
  expect(admitted.receipt.status).toBe("accepted");
  expect(await f.commands.stopAutonomy(owner, f.chatId, null)).toBe(false);
  expect((await context()).managedInputRevision).toBe(
    current.managedInputRevision,
  );
  expect((await context()).executionLaneId).toBe(
    admitted.execution!.executionLaneId,
  );
});
it("each explicit Stop cancels pending input even when autonomy was already stopped", async () => {
  await f.commands.stopAutonomy(owner, f.chatId, null);
  const pending = await context();
  await f.commands.stopAutonomy(owner, f.chatId, null);
  const rejected = await f.commands.admit(owner, await input(), {
    expectedInputRevision: pending.managedInputRevision,
  });
  expect(rejected.receipt.rejectionCode).toBe("cancelled-before-admission");
});
it("does not let a delayed GUI queue addition undo Stop, but allows a fresh addition", async () => {
  const pending = await context();
  const mutation = {
    kind: "add" as const,
    prompt: queuedPromptOpaqueContentSchema.parse({
      id: randomUUID(),
      classification: { mode: "default", attachmentIds: [] },
      protectedContent: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: settingsEnvelope,
      },
      modelId: pending.modelId!,
      reasoningEffort: null,
      worktreeId: pending.worktreeId,
      frozen: false,
      idempotencyKey: randomUUID(),
      pendingMessage: {
        id: randomUUID(),
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: settingsEnvelope,
        },
        reasoningEffort: null,
        idempotencyKey: randomUUID(),
      },
    }),
    attachments: [],
  };
  await f.commands.stopAutonomy(owner, f.chatId, null);
  await expect(
    mutateManagedGuiQueue(f.repository, owner, pending, mutation, {
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "cancelled-before-admission" });
  expect(
    (await f.repository.managedQueue.snapshot(owner, f.chatId)).items,
  ).toEqual([]);
  const accepted = await mutateManagedGuiQueue(
    f.repository,
    owner,
    await context(),
    mutation,
    { operationId: randomUUID() },
  );
  expect(accepted.receipt.status).toBe("applied");
  expect(accepted.items.map((item) => item.id)).toEqual([mutation.prompt.id]);
});
