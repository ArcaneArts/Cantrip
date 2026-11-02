import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  until,
  settingsChat as chat,
} from "./native-settings-http-fixture.mjs";
import { standalone } from "./native-event-http-setup.mjs";
import { queuedPromptOpaqueContentSchema } from "../../packages/protocol/dist/index.js";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";

export async function additionalPublicChatCases({
  h,
  modelWorker,
  visit,
  make,
  messages,
  mutation,
  prove,
}) {
  const followupGate = modelWorker.holdNext();
  const parent = await make(5),
    followup = await make(6);
  await visit(
    "queued continuation parent starts",
    "POST",
    `/api/chats/${chat}/turns`,
    { json: parent, status: 202 },
  );
  await until(() => followupGate.dispatched, Boolean);
  mutation(`gui-queue:add:${chat}:${followup.queuedPrompt.id}`, {
    kind: "add",
    prompt: followup.queuedPrompt,
    attachments: [],
  });
  const queued = await visit(
    "actual queued continuation submitted",
    "POST",
    `/api/chats/${chat}/turns`,
    { json: followup, status: 202 },
  );
  assert.equal(queued.status, "queued");
  followupGate.release();
  await messages(9);
  await until(() => modelWorker.acknowledgments.length >= 5, Boolean);
  assert.equal(modelWorker.turns.length, 5);
  assert.deepEqual(
    modelWorker.turns.map((v) => v.command.clientMessageId),
    [1, 4, 2, 5, 6].map(
      (n) => `e1e1e1e1-1111-4111-8111-${String(n).padStart(12, "0")}`,
    ),
  );
  const empty = await visit(
    "queued continuation consumed its real receipt",
    "GET",
    `/api/chats/${chat}/queue`,
  );
  assert.equal(empty.items.length, 0);
  assert.equal(empty.claims.length, 0);

  const route = `/api/chats/${standalone}/queue`;
  const a = await make(60, true),
    b = await make(61, true);
  await visit("standalone frozen queue add", "POST", route, {
    json: a.queuedPrompt,
    status: 201,
  });
  await visit("standalone second frozen queue add", "POST", route, {
    json: b.queuedPrompt,
    status: 201,
  });
  const listed = await visit(
    "standalone queue uses legacy array shape",
    "GET",
    route,
  );
  assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 2);
  const ids = [b.queuedPrompt.id, a.queuedPrompt.id];
  await visit(
    "standalone reorder needs no canonical revision",
    "PATCH",
    route + "/order",
    { json: { ids }, status: 204 },
  );
  const order = await visit("standalone queue order", "GET", route);
  assert.deepEqual(
    order.map((p) => p.id),
    ids,
  );
  const replacement = await make(62, true);
  const sealed = await protectChatTurn({
    service: h.encryption,
    text: "private-public-chat-62",
    mode: "default",
    modelId: "public-model",
    reasoningEffort: null,
    idempotencyKey: "public-message-62",
    messageId: replacement.message.id,
    promptId: a.queuedPrompt.id,
  });
  const prompt = queuedPromptOpaqueContentSchema.parse({
    ...sealed.queuedPrompt,
    frozen: true,
  });
  await visit(
    "standalone prompt edit needs no canonical revision",
    "PATCH",
    `/api/queued-prompts/${prompt.id}`,
    { json: { prompt } },
  );
  for (const id of ids)
    await visit(
      "standalone deletes " + id,
      "DELETE",
      `/api/queued-prompts/${id}`,
      { status: 204 },
    );
  assert.deepEqual(
    await visit("standalone legacy queue empty", "GET", route),
    [],
  );

  const gate = modelWorker.holdNext();
  const root = await make(63),
    steer = await make(64);
  await visit(
    "standalone encrypted public turn",
    "POST",
    `/api/chats/${standalone}/turns`,
    { json: root, status: 202 },
  );
  await until(() => gate.dispatched, Boolean);
  await visit("standalone active queued prompt", "POST", route, {
    json: steer.queuedPrompt,
    status: 201,
  });
  const steered = await visit(
    "standalone steering uses its active worker",
    "POST",
    `/api/queued-prompts/${steer.queuedPrompt.id}/steer`,
    { json: {} },
  );
  assert.equal(steered.steered, true);
  assert.deepEqual(
    await visit("standalone steer removes legacy queue item", "GET", route),
    [],
  );
  gate.release();
  const deadline = Date.now() + 15000;
  let list, status;
  do {
    await delay(30);
    await h.fixture.observe(
      "standalone completion messages",
      "GET",
      `/api/chats/${standalone}/messages`,
    );
    list = h.fixture.records.get("standalone completion messages");
    await prove(list);
    await h.fixture.observe(
      "standalone completion state",
      "GET",
      "/api/chats?context=standalone",
    );
    status = h.fixture.records
      .get("standalone completion state")
      .find((c) => c.id === standalone)?.status;
    if (list.messages.length === 3 && status === "idle") break;
  } while (Date.now() < deadline);
  assert.equal(list.messages.length, 3);
  assert.equal(status, "idle");
  await visit(
    "standalone durable messages",
    "GET",
    `/api/chats/${standalone}/messages`,
  );
  const goal = await make(65, false, { mode: "goal" });
  await visit(
    "standalone keeps default-mode restriction",
    "POST",
    `/api/chats/${standalone}/turns`,
    { json: goal, status: 400 },
  );
  assert.equal(modelWorker.turns.length, 6);
  assert.equal(modelWorker.controls.at(-1).type, "chat.steer");
  return {
    projectMessages: 9,
    standaloneMessages: 3,
    consumedClaims: 2,
    workerTurns: 6,
  };
}
