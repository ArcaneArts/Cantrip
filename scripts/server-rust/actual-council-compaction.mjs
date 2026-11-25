import assert from "node:assert/strict";
import { actualCouncilHistoryRedaction } from "./actual-council-history-redaction.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
import { modelFunctions } from "./task-model-provider.mjs";

export async function actualCouncilCompaction({
  page,
  appOrigin,
  fixture,
  restartWorker,
  redact = false,
  chatId,
  model,
  submit,
  readChat,
  readMessages,
  source,
  previousAnswer,
  result,
}) {
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
  const observe = (plan) =>
    eventually(
      () => plan.request,
      (request) => assert.ok(request, JSON.stringify(model.failures)),
      60_000,
    );
  const compact = () =>
    page.evaluate(async (id) => {
      try {
        return {
          body: await (await import("/src/lib/api/chats.ts")).compactChat(id),
          status: 200,
        };
      } catch (error) {
        return { message: error.message, status: error.status };
      }
    }, chatId);
  const recall = () =>
    page.evaluate(
      async ({ id, text, chatId }) => {
        const history = await import("/src/lib/api/council-history.ts");
        const search = await history.searchCouncilHistory(
          chatId,
          text,
          "literal",
        );
        const nearby = await history.readCouncilHistory(chatId, id);
        return { search, nearby };
      },
      { ...source, chatId },
    );
  const assertEvidence = ({ search, nearby }) => {
    assert.equal(search.matches[0]?.messageId, source.id);
    assert.equal(nearby.available, true);
    assert.ok(
      nearby.messages.some(
        ({ id, content }) =>
          id === source.id && content.some(({ text }) => text === source.text),
      ),
    );
  };
  const content = (request) => JSON.stringify(request.input.input);
  const thread = async () =>
    (
      await fixture.sql(
        [],
        [
          `SELECT COALESCE(to_jsonb(r.codex_thread_id),'null'::jsonb)::text FROM chat_runtime_sessions r
           JOIN chats c ON c.id=r.chat_id AND c.active_worker_id=r.worker_id
             AND c.active_scratch_root_id=r.scratch_root_id WHERE c.id=${literal(chatId)}`,
        ],
      )
    )[0];
  await idle();
  const threadId = await thread();
  assert.ok(threadId, "Council has a native thread before compaction");
  await page.setViewportSize({ width: 1344, height: 900 });
  await page.goto(appOrigin);
  await page
    .getByRole("button", { name: /switch cantrip mode/iu })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
  await page
    .getByRole("navigation", { name: "Council agents" })
    .getByRole("button", { name: /Disposable Operations Agent/u })
    .click();
  const accepted = { body: { accepted: true }, status: 200 };
  const firstSummary = "First native summary: inspect the durable input queue.";
  const firstCompact = model.reply({ text: firstSummary, hold: true });
  const manual = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/chats/${chatId}/compact`,
  );
  await page.getByPlaceholder("Message Cantrip…").fill("/compact");
  await page.getByRole("option", { name: /\/compact/u }).click();
  const reply = await manual;
  assert.deepEqual(
    { body: await reply.json(), status: reply.status() },
    accepted,
  );
  try {
    assert.ok(content(await observe(firstCompact)).includes(previousAnswer));
    assert.equal((await compact()).status, 409);
    if (redact) {
      const rejected = await page.evaluate(
        async ({ chatId, messageId }) => {
          try {
            await (
              await import("/src/lib/api/council-history.ts")
            ).deleteCouncilHistoryMessage(chatId, messageId);
            return null;
          } catch (error) {
            return error.status;
          }
        },
        { chatId, messageId: source.id },
      );
      assert.equal(rejected, 409, "A live native compaction owns the thread");
    }
  } finally {
    firstCompact.release();
  }
  await idle();
  const nextAnswer =
    "The durable queue completed the check with no duplicate messages.";
  const next = model.reply({ text: nextAnswer });
  assert.equal(
    (await submit("Continue using the Council summary.")).status,
    "queued",
  );
  assert.ok(content(await observe(next)).includes(firstSummary));
  await idle();

  const secondSummary = `Second native summary: the durable queue check found no duplicates. ${source.text}`;
  const secondCompact = model.reply({ text: secondSummary });
  assert.deepEqual(await compact(), accepted);
  assert.ok(content(await observe(secondCompact)).includes(nextAnswer));
  await idle();
  assert.equal(await thread(), threadId);
  assertEvidence(await recall());

  await restartWorker();
  assertEvidence(await recall());
  const afterRestart = model.reply({ hold: true });
  const final = model.reply({
    text: "I recovered the original Council message after restart.",
  });
  assert.equal(
    (await submit("Find the original queue instruction with history search."))
      .status,
    "queued",
  );
  try {
    const request = await observe(afterRestart);
    assert.ok(
      content(request).includes(secondSummary),
      "Recovered native context includes the latest compaction",
    );
    const search = modelFunctions(request.input.tools).find(
      ({ name }) =>
        name === "council_history_search" ||
        name.endsWith("__council_history_search"),
    );
    assert.ok(search);
    afterRestart.calls = [
      {
        ...search,
        arguments: { query: source.text, mode: "literal", limit: 3 },
      },
    ];
  } finally {
    afterRestart.release();
  }
  assert.ok(content(await observe(final)).includes(source.id));
  await idle();
  assert.equal(await thread(), threadId);
  const retained = await readMessages();
  assert.ok(retained.some(({ id }) => id === source.id));
  assert.ok(
    !retained.some(({ content }) =>
      content.some(({ text }) => text === "/compact"),
    ),
  );
  assert.deepEqual(model.failures, []);

  result.councilCompaction = {
    chatId,
    threadId,
    sourceId: source.id,
    nativeCompactions: 2,
    workerRestarted: true,
  };
  result.steps.push(
    "Council retained the same native thread and source ID through repeated compaction and a cold worker restart",
  );
  if (redact) {
    const retainedMessage = retained.find(({ content }) =>
      content.some(({ text }) => text === previousAnswer),
    );
    assert.ok(retainedMessage);
    await actualCouncilHistoryRedaction({
      page,
      appOrigin,
      chatId,
      source,
      retainedId: retainedMessage.id,
      priorSummary: secondSummary,
      priorThreadId: threadId,
      model,
      submit,
      observe,
      idle,
      readMessages,
      recall,
      thread,
      result,
    });
  }
}
