import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

export async function assertPendingSuspensionStopped(identity, active) {
  const chat = await eventually(identity, (value) => {
    assert.equal(value.nativeSuspension.phase, "stopped");
    assert.equal(value.nativeSuspension.resumable, false);
    assert.equal(value.status, "idle");
  });
  if (chat.nativeSuspension.active)
    assert.deepEqual(chat.nativeSuspension.active, active);
  return chat;
}

async function lateResume(page, chatId, identity, active) {
  const result = await page.evaluate(async (id) => {
    try {
      return {
        result: await (
          await import("/src/lib/api/chats.ts")
        ).setChatPaused(id, false),
      };
    } catch (error) {
      return { status: error.status };
    }
  }, chatId);
  if (result.status) assert.equal(result.status, 409);
  await delay(300);
  await assertPendingSuspensionStopped(identity, active);
  return result;
}

export async function stopPendingSuspensionInteraction({
  page,
  chatId,
  identity,
  request,
  pause,
  inferences,
  mounted,
}) {
  const count = inferences();
  const native = {
    threadId: request.provenance.threadId,
    turnId: request.provenance.turnId,
  };
  assert.ok(native.threadId && native.turnId);
  let pauseOutcome;
  void pause.then(
    (result) => {
      pauseOutcome = { result };
    },
    (error) => {
      pauseOutcome = { status: error.status, message: error.message };
    },
  );
  if (mounted) {
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/chats/${chatId}/interrupt` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Stop current operation" }).click();
    const reply = await response;
    assert.equal(reply.status(), 200, await reply.text());
    assert.equal((await reply.json()).interrupted, true);
  } else {
    const reply = await page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).interruptChat(id),
      chatId,
    );
    assert.equal(reply.interrupted, true);
  }
  await assertPendingSuspensionStopped(identity, native);
  await eventually(
    () => pauseOutcome,
    (value) => assert.ok(value),
  );
  const interactions = await page.evaluate(
    async (chatId) =>
      (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
        chatId,
      }),
    chatId,
  );
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, request.id);
  assert.equal(interactions[0].status, "interrupted");
  assert.equal(interactions[0].response, null);
  const staleReply = await page.evaluate(
    async ({ request, chatId }) => {
      const api = await import("/src/lib/api/chats.ts");
      try {
        await api.respondToAgentInteractionRequest(request.id, {
          idempotencyKey: crypto.randomUUID(),
          response:
            request.payload.kind === "userInput"
              ? {
                  kind: "userInput",
                  answers: { choice: { answers: ["DURABLE_ANSWER"] } },
                }
              : {
                  kind: "commandExecution",
                  decision: "accept",
                  execpolicyAmendment: null,
                  networkPolicyAmendment: null,
                },
        });
        return { status: 200 };
      } catch (error) {
        return { status: error.status };
      }
    },
    { request, chatId },
  );
  assert.equal(staleReply.status, 409);
  const resume = await lateResume(page, chatId, identity, native);
  assert.equal(
    inferences(),
    count,
    "Stop and stale controls start no inference",
  );
  return {
    stopped: true,
    native,
    requestId: request.id,
    kind: request.payload.kind,
    pauseOutcome,
    staleReplyStatus: staleReply.status,
    lateResume: resume,
    requests: count,
  };
}

export async function verifyPendingSuspensionStop({
  page,
  chatId,
  identity,
  workerData,
  directory,
  interaction,
  inferences,
}) {
  await assertPendingSuspensionStopped(identity, interaction.native);
  const resume = await lateResume(page, chatId, identity, interaction.native);
  const requests = await page.evaluate(
    async (chatId) =>
      (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
        chatId,
      }),
    chatId,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, interaction.requestId);
  assert.equal(requests[0].status, "interrupted");
  assert.equal(requests[0].response, null);
  if (interaction.kind === "userInput") {
    const plan = await page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getChatPlan(chatId),
      chatId,
    );
    assert.equal(plan.mode, "plan");
    assert.equal(plan.question, null);
  }
  const files = [];
  for await (const relative of glob("**/rollout-*.jsonl", { cwd: workerData }))
    if (path.basename(relative).includes(interaction.native.threadId))
      files.push(path.join(workerData, relative));
  assert.equal(files.length, 1);
  const history = (await readFile(files[0], "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const events = history
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
  assert.equal(
    events.filter((event) => event.type === "task_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "task_complete").length,
    0,
  );
  const aborted = events.filter((event) => event.type === "turn_aborted");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].turn_id, interaction.native.turnId);
  const items = history
    .filter((row) => row.type === "response_item")
    .map((row) => row.payload);
  assert.equal(
    items.filter(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.content.some((part) => part.text === "DURABLE_ORIGINAL_PROMPT"),
    ).length,
    1,
  );
  if (interaction.kind === "commandExecution")
    await assert.rejects(
      readFile(path.join(directory, "durable-cold-marker")),
      { code: "ENOENT" },
    );
  else
    assert.equal(
      await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
      "DURABLE_TOOL_RESULT\n",
    );
  assert.equal(inferences(), interaction.requests);
  return {
    ...interaction,
    coldLateResume: resume,
    nativeTurnStarts: 1,
    nativeTurnAborts: 1,
  };
}
