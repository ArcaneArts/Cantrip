import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { suspensionChat } from "./durable-suspension-browser.mjs";
import { stopPendingSuspensionInteraction } from "./pending-suspension-stop.mjs";
import {
  openMountedSuspensionChat,
  clickMountedSuspensionPause,
  clickMountedSuspensionResume,
} from "./mounted-suspension-browser.mjs";

export async function qualifySuspensionPlanRoutes(
  page,
  chatId,
  active = false,
) {
  const statuses = await page.evaluate(
    async ({ chatId, active }) => {
      const { request } = await import("/src/lib/api-client.ts");
      const missing = "00000000-0000-4000-8000-000000000000";
      const cases = active
        ? [[chatId, "PATCH", { mode: "default" }]]
        : [
            [chatId, "PATCH", { mode: "invalid" }],
            [missing, "GET", null],
            [missing, "PATCH", { mode: "plan" }],
          ];
      const statuses = [];
      for (const [id, method, body] of cases) {
        try {
          await request(`/api/chats/${id}/plan`, {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          statuses.push(200);
        } catch (error) {
          statuses.push(error.status);
        }
      }
      return statuses;
    },
    { chatId, active },
  );
  assert.deepEqual(statuses, active ? [409] : [400, 404, 404]);
  return statuses;
}

export async function readHeldSuspensionPlan(page, chatId) {
  const plan = await page.evaluate(
    async (chatId) =>
      (await import("/src/lib/api/chats.ts")).getChatPlan(chatId),
    chatId,
  );
  assert.equal(plan.mode, "plan");
  assert.equal(plan.question, null);
  return { mode: plan.mode, question: plan.question };
}

/** A real blocking native request remains answerable during pending Pause. */
export async function answerSuspensionInteraction({
  page,
  chatId,
  projectId,
  origin,
  mounted,
  inferences,
  kind = "userInput",
  stopPending = false,
}) {
  const isQuestion = kind === "userInput";
  const requests = () =>
    page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
          chatId,
          status: "pending",
        }),
      chatId,
    );
  const pending = await eventually(requests, (value) => {
    assert.equal(value.length, 1);
    assert.equal(value[0].payload.kind, kind);
  });
  const question = pending[0];
  const count = inferences();
  if (mounted) {
    await openMountedSuspensionChat(page, origin, false);
    if (isQuestion)
      await page
        .getByRole("group", { name: /DURABLE_QUESTION/ })
        .waitFor({ state: "visible" });
    else
      await page
        .getByRole("button", { name: "Allow once", exact: true })
        .waitFor({ state: "visible" });
  }
  let settled = false;
  const pause = (
    mounted
      ? clickMountedSuspensionPause(page, chatId)
      : page.evaluate(
          async (chatId) =>
            (await import("/src/lib/api/chats.ts")).setChatPaused(chatId, true),
          chatId,
        )
  ).then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  void pause.catch(() => {});
  const identity = () => suspensionChat(page, projectId, chatId);
  await eventually(identity, (value) =>
    assert.equal(value.nativeSuspension.phase, "pausing"),
  );
  await delay(250);
  assert.equal(
    settled,
    false,
    "A blocking request must not receive premature durable confirmation",
  );
  assert.equal((await requests())[0]?.id, question.id);
  if (mounted)
    await page
      .getByText(
        "Resolve the pending request to finish pausing. Stop is still available.",
        { exact: true },
      )
      .waitFor({ state: "visible" });
  if (mounted)
    assert.equal(
      await page
        .getByRole("button", { name: "Stop current operation" })
        .isEnabled(),
      true,
    );
  if (stopPending)
    return stopPendingSuspensionInteraction({
      page,
      chatId,
      identity,
      request: question,
      pause,
      inferences,
      mounted,
    });
  let resolved;
  if (mounted) {
    if (isQuestion) {
      await page.getByRole("radio", { name: /^DURABLE_ANSWER/ }).check();
      await page
        .getByRole("button", { name: "Answer Codex", exact: true })
        .click();
    } else
      await page
        .getByRole("button", { name: "Allow once", exact: true })
        .click();
    resolved = await eventually(
      () =>
        page.evaluate(
          async ({ chatId, requestId }) =>
            (
              await (
                await import("/src/lib/api/chats.ts")
              ).getAgentInteractionRequests({ chatId })
            ).find((entry) => entry.id === requestId),
          { chatId, requestId: question.id },
        ),
      (value) => assert.equal(value?.status, "resolved"),
    );
  } else
    resolved = await page.evaluate(
      async ({ question, isQuestion }) =>
        (
          await import("/src/lib/api/chats.ts")
        ).respondToAgentInteractionRequest(question.id, {
          idempotencyKey: crypto.randomUUID(),
          response: isQuestion
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
        }),
      { question, isQuestion },
    );
  assert.equal(resolved.status, "resolved");
  assert.equal((await pause).paused, true);
  const paused = await identity();
  assert.equal(paused.nativeSuspension.phase, "paused");
  assert.equal(paused.nativeSuspension.resumable, true);
  assert.equal(
    inferences(),
    count,
    "Answer acceptance and checkpoint creation start no inference",
  );
  if (mounted) await clickMountedSuspensionResume(page, chatId);
  else
    await page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).setChatPaused(chatId, false),
      chatId,
    );
  return {
    requestId: question.id,
    native: paused.nativeSuspension.active,
    kind,
    answer: isQuestion ? "DURABLE_ANSWER" : null,
    resolved: true,
  };
}
