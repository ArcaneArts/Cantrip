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
  mutation(`gui-queue:add:${chat}:${parent.queuedPrompt.id}`, {
    kind: "add",
    prompt: parent.queuedPrompt,
    attachments: [],
  });
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
  for (const value of [a, b])
    mutation(`gui-queue:add:${standalone}:${value.queuedPrompt.id}`, {
      kind: "add",
      prompt: value.queuedPrompt,
      attachments: [],
    });
  await visit("standalone frozen queue add", "POST", route, {
    json: a.queuedPrompt,
    status: 201,
  });
  await visit("standalone second frozen queue add", "POST", route, {
    json: b.queuedPrompt,
    status: 201,
  });
  const listed = await visit(
    "standalone queue uses canonical snapshot",
    "GET",
    route,
  );
  assert.ok(Number.isSafeInteger(listed.revision));
  assert.equal(listed.items.length, 2);
  const ids = [b.queuedPrompt.id, a.queuedPrompt.id];
  await visit(
    "standalone reorder requires canonical revision",
    "PATCH",
    route + "/order",
    { json: { ids }, status: 409 },
  );
  mutation("standalone-order", { kind: "reorder", ids });
  await visit("standalone canonical reorder", "PATCH", route + "/order", {
    json: {
      ids,
      expectedRevision: listed.revision,
      operationId: "standalone-order",
    },
    status: 204,
  });
  const order = await visit("standalone queue order", "GET", route);
  assert.deepEqual(
    order.items.map((p) => p.id),
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
    "standalone prompt edit requires canonical revision",
    "PATCH",
    `/api/queued-prompts/${prompt.id}`,
    { json: { prompt }, status: 409 },
  );
  const update = {
    prompt,
    expectedItemRevision: order.items.find((value) => value.id === prompt.id)
      .revision,
    operationId: "standalone-edit",
  };
  mutation(update.operationId, {
    kind: "update",
    id: prompt.id,
    expectedItemRevision: update.expectedItemRevision,
    prompt,
    attachments: [],
  });
  await visit(
    "standalone canonical edit",
    "PATCH",
    `/api/queued-prompts/${prompt.id}`,
    {
      json: update,
    },
  );
  for (const id of ids) {
    const snapshot = await visit(
      "standalone deletion snapshot " + id,
      "GET",
      route,
    );
    const current = snapshot.items.find((value) => value.id === id);
    const operationId = "standalone-delete:" + id;
    mutation(operationId, {
      kind: "delete",
      id,
      expectedItemRevision: current.revision,
    });
    await visit(
      "standalone deletes " + id,
      "DELETE",
      `/api/queued-prompts/${id}?expectedItemRevision=${current.revision}&operationId=${operationId}`,
      { status: 204 },
    );
  }
  const emptyStandalone = await visit(
    "standalone canonical queue empty",
    "GET",
    route,
  );
  assert.equal(emptyStandalone.items.length, 0);
  assert.equal(emptyStandalone.claims.length, 0);

  const gate = modelWorker.holdNext();
  const root = await make(63),
    steer = await make(64);
  for (const value of [root, steer])
    mutation(`gui-queue:add:${standalone}:${value.queuedPrompt.id}`, {
      kind: "add",
      prompt: value.queuedPrompt,
      attachments: [],
    });
  await visit(
    "standalone encrypted public turn",
    "POST",
    `/api/chats/${standalone}/turns`,
    { json: root, status: 202 },
  );
  await until(() => gate.dispatched, Boolean);
  const queuedStandalone = await visit(
    "standalone active queued prompt",
    "POST",
    route,
    {
      json: steer.queuedPrompt,
      status: 201,
    },
  );
  await visit(
    "standalone steering requires canonical revision",
    "POST",
    `/api/queued-prompts/${steer.queuedPrompt.id}/steer`,
    {
      json: {},
      status: 409,
    },
  );
  const steered = await visit(
    "standalone steering uses its active worker",
    "POST",
    `/api/queued-prompts/${steer.queuedPrompt.id}/steer`,
    {
      json: {
        expectedItemRevision: queuedStandalone.revision,
        operationId: "standalone-steer",
      },
    },
  );
  assert.equal(steered.steered, true);
  const afterSteer = await visit(
    "standalone steer consumes canonical queue item",
    "GET",
    route,
  );
  assert.deepEqual(
    afterSteer.items.map((item) => item.id),
    [root.queuedPrompt.id],
  );
  assert.equal(afterSteer.claims.length, 1);
  assert.equal(afterSteer.claims[0].promptId, root.queuedPrompt.id);
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
  const completedStandalone = await visit(
    "completed standalone root leaves canonical queue",
    "GET",
    route,
  );
  assert.equal(completedStandalone.items.length, 0);
  assert.equal(completedStandalone.claims.length, 0);
  await visit(
    "standalone durable messages",
    "GET",
    `/api/chats/${standalone}/messages`,
  );
  const goal = await make(65, false, { mode: "goal" });
  const rejectedGoal = await visit(
    "standalone keeps default-mode restriction",
    "POST",
    `/api/chats/${standalone}/turns`,
    { json: goal, status: 409 },
  );
  assert.deepEqual(rejectedGoal, {
    error:
      "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
  });
  assert.equal(modelWorker.turns.length, 6);
  assert.equal(modelWorker.controls.at(-1).type, "chat.native-control");
  return {
    projectMessages: 9,
    standaloneMessages: 3,
    consumedClaims: 5,
    workerTurns: 6,
  };
}
