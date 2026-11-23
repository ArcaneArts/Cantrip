import assert from "node:assert/strict";
import { settingsChat as chat } from "./native-settings-http-fixture.mjs";
import { eventPlan } from "./native-event-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";

export async function runChatPlanHttpCases({ h, profile, controller }) {
  const url = `/api/chats/${chat}/plan`;
  const get = (name, options = {}) => h.visit(name, "GET", url, options);
  const patch = (name, body, status = 200) =>
    h.visit(name, "PATCH", url, { json: body, status });
  await patch("Plan rejects invalid body", {}, 400);
  await h.visit("Plan missing chat read", "GET", "/api/chats/missing/plan", {
    status: 404,
  });
  await h.visit(
    "Plan missing chat mutation",
    "PATCH",
    "/api/chats/missing/plan",
    { json: { mode: "plan" }, status: 404 },
  );
  if (profile !== "none") {
    await get("Plan read requires login", { client: "stranger", status: 401 });
    await h.visit("Plan write requires CSRF", "PATCH", url, {
      csrf: false,
      json: { mode: "plan" },
      status: 403,
    });
  }
  if (profile === "accounts") {
    await get("Plan foreign owner read", { client: "other", status: 404 });
    await h.visit("Plan foreign owner mutation", "PATCH", url, {
      client: "other",
      json: { mode: "plan" },
      status: 404,
    });
  }
  controller.setPlanMode("default");
  assert.deepEqual(await get("Plan initial stored state"), {
    kind: "chat-encrypted",
    chatId: chat,
    mode: "default",
    hasQuestion: false,
    state: null,
  });
  assert.deepEqual(await patch("Plan native mode write", { mode: "plan" }), {
    kind: "chat-encrypted",
    chatId: chat,
    mode: "plan",
    hasQuestion: false,
    state: null,
  });
  await h.fixture.sql([
    `UPDATE chats SET protected_plan=${json(eventPlan)},has_pending_plan_question=true WHERE id=${literal(chat)}`,
  ]);
  const expected = {
    kind: "chat-encrypted",
    chatId: chat,
    mode: "plan",
    hasQuestion: true,
    state: eventPlan,
  };
  assert.deepEqual(await get("Plan opaque state read"), expected);
  controller.setPlanFailure("error");
  assert.deepEqual(
    await get("Plan worker refresh failure retains history"),
    expected,
  );
  const failed = await patch(
    "Plan worker write failure",
    { mode: "default" },
    409,
  );
  assert.equal(failed.error, "controlled Plan failure");
  controller.setPlanFailure("thread");
  const invalid = await patch(
    "Plan invalid worker thread",
    { mode: "default" },
    409,
  );
  assert.equal(invalid.error, "Codex did not return a Plan Mode thread.");
  controller.setPlanFailure(null);
  assert.deepEqual(
    await get("Plan failed writes retain opaque state"),
    expected,
  );
  controller.setPlanMode("default");
  assert.deepEqual(await get("Plan native refresh clears protected state"), {
    kind: "chat-encrypted",
    chatId: chat,
    mode: "default",
    hasQuestion: false,
    state: null,
  });
  assert.deepEqual(
    await patch("Plan mode write remains usable", { mode: "plan" }),
    {
      kind: "chat-encrypted",
      chatId: chat,
      mode: "plan",
      hasQuestion: false,
      state: null,
    },
  );
  assert.deepEqual(await patch("Plan return to default", { mode: "default" }), {
    kind: "chat-encrypted",
    chatId: chat,
    mode: "default",
    hasQuestion: false,
    state: null,
  });
}

export async function runOfflineChatPlanHttpCases({ h }) {
  const url = `/api/chats/${chat}/plan`;
  assert.deepEqual(
    await h.visit("Plan offline history remains readable", "GET", url),
    {
      kind: "chat-encrypted",
      chatId: chat,
      mode: "default",
      hasQuestion: false,
      state: null,
    },
  );
  const result = await h.visit(
    "Plan offline mutation uses unavailable status",
    "PATCH",
    url,
    { json: { mode: "plan" }, status: 503 },
  );
  assert.equal(result.error, "Project worker is offline.");
}
