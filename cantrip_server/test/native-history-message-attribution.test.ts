import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type {
  NativeHistoryBinding,
  NativeHistoryPreparedBatch,
  NativeTurnModelAttribution,
} from "@cantrip/protocol";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { protectNativeHistoryTurnMetadata } from "../../cantrip_worker/src/native-history-turn-content.js";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.js";
import { decryptNativeHistoryTurn } from "../../packages/crypto/src/native-history-turn.js";
import { readChatNativeHistoryTurns } from "../src/db/repository/native-history-turn-read.js";
let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let binding: NativeHistoryBinding;
let capture: NativeTurnModelAttribution;
let streamId: string;
let sequence = 0;
let previousDigest: string | null = null;
const service = {
  ownerId: () => LOCAL_USER_ID,
  serverIdentity: () => "fixture",
  componentKey: () => ({ key: new Uint8Array(32).fill(9), keyRevision: 1 }),
};
beforeAll(async () => {
  f = await createNativeSettingsFixture();
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  const context = await f.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    f.chatId,
  );
  await f.repository.updateChatRuntime(
    f.chatId,
    f.workerId,
    context!.worktreeId!,
    "native-thread",
    runtime!.routeId,
    "ready",
    null,
  );
  binding = await f.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
    workerId: f.workerId,
    chatId: f.chatId,
    threadId: "native-thread",
    provenance: { kind: "current" },
  });
  capture = {
    threadId: binding.threadId,
    turnId: "turn",
    isRoot: true,
    reasoningEffort: "low",
    selection: {
      status: "resolved",
      workerId: binding.workerId,
      providerAccountId: binding.providerAccountId,
      providerId: runtime!.provider.id,
      modelId: runtime!.model.id,
      routeId: runtime!.routeId,
    },
  };
}, 60000);
beforeEach(async () => {
  await f.db.delete(schema.nativeHistoryReceipts);
  await f.db.delete(schema.nativeHistoryStreams);
  await f.db.delete(schema.nativeHistoryTurns);
  await f.db.delete(schema.nativeHistoryItems);
  await f.db.delete(schema.chatMessages);
  streamId = randomUUID();
  sequence = 0;
  previousDigest = null;
});
afterAll(async () => {
  await f?.close();
});
async function turn(attribution: NativeTurnModelAttribution = capture) {
  return protectNativeHistoryTurnMetadata({
    service,
    binding,
    header: {
      threadId: binding.threadId,
      turnId: "turn",
      revision: sequence + 1,
      ordinal: 0,
      status: "completed",
      startedAtMs: 1000,
      completedAtMs: 2000,
      modelAttribution: attribution,
    },
    content: { originalTurnModel: attribution },
  });
}
async function item(turnId = "turn") {
  const identity = {
    threadId: binding.threadId,
    turnId,
    itemId: randomUUID(),
    component: "assistant",
    identityKind: "canonical" as const,
  };
  const [mapping] = await f.repository.nativeHistoryItems.resolve(
    LOCAL_USER_ID,
    {
      workerId: f.workerId,
      chatId: f.chatId,
      bindingId: binding.id,
      items: [{ identity, association: { kind: "native" } }],
    },
  );
  const message = await protectChatMessage({
    id: mapping!.messageId,
    service: service as never,
    message: {
      role: "assistant",
      mode: "default",
      content: [{ type: "text", text: "native result" }],
      reasoningEffort: "high",
      idempotencyKey: mapping!.idempotencyKey,
    },
  });
  return {
    identity,
    revision: 1,
    state: "completed" as const,
    order: { turn: 0, item: sequence, component: 0 },
    attachments: [],
    message,
  };
}
async function ingest(batch: NativeHistoryPreparedBatch) {
  const next = sequence + 1;
  const input = {
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: binding.id,
    streamId,
    sequence: next,
    previousDigest,
    recordId: randomUUID(),
    digest: next.toString(16).padStart(64, "0"),
    batch,
  };
  await f.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input);
  sequence = next;
  previousDigest = input.digest;
  return input;
}
async function message(id: string) {
  return (
    await f.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id))
  )[0]!;
}
it("labels zero-usage turns through late GUI writes, restart and browser decryption", async () => {
  const output = await item();
  await ingest({ items: [output], turns: [await turn()] });
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  expect(await message(output.message.id)).toMatchObject({
    modelId: runtime!.model.id,
    appliedReasoningEffort: "low",
    reasoningEffort: "high",
    reasoningAdjusted: true,
    nativeModelAttribution: capture,
  });
  expect(await f.db.select().from(schema.tokenUsageRecords)).toEqual([]);
  const result = await f.repository.setEncryptedMessageModelRoute(
    LOCAL_USER_ID,
    output.message.id,
    runtime!.model.id,
    { ...runtime!, model: { ...runtime!.model, name: "next-model" } },
    { appliedReasoningEffort: "high", reasoningAdjusted: false },
  );
  expect(result).toMatchObject({
    providerModelName: runtime!.model.name,
    appliedReasoningEffort: "low",
    reasoningAdjusted: true,
  });
  await f.restart();
  expect((await message(output.message.id)).nativeModelAttribution).toEqual(
    capture,
  );
  const archived = await readChatNativeHistoryTurns(
    f.db,
    LOCAL_USER_ID,
    f.chatId,
    { turns: [{ threadId: binding.threadId, turnId: "turn" }] },
  );
  expect(archived.turns[0]!.turn.modelAttribution).toEqual(capture);
  expect(
    await decryptNativeHistoryTurn({
      ownerId: LOCAL_USER_ID,
      serverId: "fixture",
      componentKey: service.componentKey().key,
      chatId: f.chatId,
      bindingId: binding.id,
      workerId: binding.workerId,
      turn: archived.turns[0]!.turn,
    }),
  ).toEqual({ originalTurnModel: capture });
});
it("converges for either delivery order and keeps original capture across revisions", async () => {
  const first = await item();
  await ingest({ items: [first], turns: [] });
  expect((await message(first.message.id)).modelId).toBeNull();
  await ingest({ items: [], turns: [await turn()] });
  expect((await message(first.message.id)).appliedReasoningEffort).toBe("low");
  await ingest({
    items: [],
    turns: [await turn({ ...capture, reasoningEffort: "high" })],
  });
  const later = await item();
  await ingest({ items: [later], turns: [] });
  expect((await message(later.message.id)).appliedReasoningEffort).toBe("low");
  const other = await item("other-turn");
  await ingest({ items: [other], turns: [] });
  expect((await message(other.message.id)).nativeModelAttribution).toBeNull();
});
it("keeps unavailable model selection unknown after late bootstrap", async () => {
  const output = await item();
  await ingest({
    items: [output],
    turns: [await turn({ ...capture, selection: { status: "unavailable" } })],
  });
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  const result = await f.repository.setEncryptedMessageModelRoute(
    LOCAL_USER_ID,
    output.message.id,
    runtime!.model.id,
    runtime!,
  );
  expect(result).toMatchObject({
    modelId: null,
    modelRouteId: null,
    providerName: null,
    appliedReasoningEffort: "low",
  });
});
it("does not label another worker's model as this session's", async () => {
  if (capture.selection.status !== "resolved") throw new Error("fixture");
  const output = await item();
  await ingest({
    items: [output],
    turns: [
      await turn({
        ...capture,
        selection: { ...capture.selection, workerId: "another-worker" },
      }),
    ],
  });
  expect((await message(output.message.id)).modelId).toBeNull();
});
it("rolls back labels and receipt on real storage failure and retries once", async () => {
  const output = await item();
  const batch = { items: [output], turns: [await turn()] };
  await f.db.execute(
    sql`ALTER TABLE chat_messages ADD CONSTRAINT reject_native_label CHECK (native_model_attribution IS NULL)`,
  );
  try {
    await expect(ingest(batch)).rejects.toThrow();
  } finally {
    await f.db.execute(
      sql`ALTER TABLE chat_messages DROP CONSTRAINT reject_native_label`,
    );
  }
  expect(await f.db.select().from(schema.nativeHistoryReceipts)).toEqual([]);
  expect(await f.db.select().from(schema.chatMessages)).toEqual([]);
  const input = await ingest(batch);
  await f.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input);
  expect(await f.db.select().from(schema.chatMessages)).toHaveLength(1);
  expect((await message(output.message.id)).nativeModelAttribution).toEqual(
    capture,
  );
});
it("keeps attribution through concurrent GUI labeling and turn ingestion", async () => {
  const output = await item();
  await ingest({ items: [output], turns: [] });
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  await Promise.all([
    ingest({ items: [], turns: [await turn()] }),
    f.repository.setEncryptedMessageModelRoute(
      LOCAL_USER_ID,
      output.message.id,
      runtime!.model.id,
      { ...runtime!, model: { ...runtime!.model, name: "bootstrap-name" } },
      { appliedReasoningEffort: "high", reasoningAdjusted: false },
    ),
  ]);
  expect(await message(output.message.id)).toMatchObject({
    providerModelName: runtime!.model.name,
    appliedReasoningEffort: "low",
    nativeModelAttribution: capture,
  });
});
it("accepts late capture from an active snapshot without reopening a completed turn", async () => {
  const output = await item();
  const completed = await turn();
  const {
    modelAttribution: _capture,
    metadata: _metadata,
    ...header
  } = completed;
  await ingest({
    items: [output],
    turns: [
      await protectNativeHistoryTurnMetadata({
        service,
        binding,
        header,
        content: { old: true },
      }),
    ],
  });
  const active = await protectNativeHistoryTurnMetadata({
    service,
    binding,
    header: {
      ...header,
      revision: sequence + 1,
      status: "inProgress",
      completedAtMs: null,
      modelAttribution: capture,
    },
    content: { lateStart: true },
  });
  await ingest({ items: [], turns: [active] });
  expect((await message(output.message.id)).nativeModelAttribution).toEqual(
    capture,
  );
  expect(
    (await f.db.select().from(schema.nativeHistoryTurns))[0],
  ).toMatchObject({
    status: "completed",
    completedAtMs: 2000,
    revision: 1,
    modelAttribution: null,
    capturedModelAttribution: capture,
  });
});
it("does not borrow labels from a deleted route or relabel existing history", async () => {
  if (capture.selection.status !== "resolved") throw new Error("fixture");
  const selected = capture.selection;
  const output = await item();
  await ingest({ items: [output], turns: [await turn()] });
  const old = await message(output.message.id);
  const [route] = await f.db
    .select()
    .from(schema.modelRoutes)
    .where(eq(schema.modelRoutes.id, selected.routeId));
  await f.db
    .delete(schema.modelRoutes)
    .where(eq(schema.modelRoutes.id, selected.routeId));
  try {
    const later = await item();
    await ingest({ items: [later], turns: [] });
    expect((await message(output.message.id)).providerModelName).toBe(
      old.providerModelName,
    );
    expect((await message(later.message.id)).modelId).toBeNull();
  } finally {
    await f.db.insert(schema.modelRoutes).values(route!);
  }
});
