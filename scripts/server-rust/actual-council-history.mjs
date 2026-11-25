import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";

export async function actualCouncilHistory({
  fixture,
  chatId,
  model,
  tools,
  submit,
  readChat,
  readMessages,
  result,
}) {
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
  const observed = (plan) =>
    eventually(
      () => plan.entered,
      (entered) => assert.ok(entered),
      60_000,
    );
  const find = (name) => {
    const tool = tools.find(
      (tool) => tool.name === name || tool.name.endsWith(`__${name}`),
    );
    assert.ok(tool, `Expected ${name} in the actual Codex tool catalog.`);
    return tool;
  };
  const search = find("council_history_search");
  const read = find("council_history_read");
  const exact = "E_STALE_CURSOR at src/recovery/queue.rs:118";
  const decision = `We abandoned the cutover when the warm standby could not replay the write cursor. ${exact}`;
  await idle();
  const seeded = model.reply({ text: "I recorded the migration decision." });
  assert.equal((await submit(decision)).status, "queued");
  await observed(seeded);
  await idle();
  const target = (await readMessages()).find(({ content }) =>
    content.some((part) => part.type === "text" && part.text === decision),
  );
  assert.ok(target?.id);

  const call = (id, tool, args) =>
    model.reply({
      responseId: id,
      calls: [{ ...tool, arguments: args }],
    });
  const output = (plan, id) => {
    const item = plan.request.input.input.find(
      ({ type, call_id }) =>
        type === "function_call_output" && call_id === `${id}-call-0`,
    );
    assert.ok(item, `Codex received the result for ${id}`);
    return typeof item.output === "string"
      ? item.output
      : item.output.map(({ text }) => text).join("\n");
  };
  call("council-history-paraphrase", search, {
    query: "cutover warm standby",
    mode: "terms",
  });
  const literalSearch = call("council-history-literal", search, {
    query: exact,
    mode: "literal",
  });
  const nearby = call("council-history-nearby", read, { messageId: target.id });
  const done = model.reply({ text: "I linked the original decision." });
  assert.equal(
    (
      await submit(
        "Why did we give up on switching environments without downtime? Find the saved diagnostic and its original message.",
      )
    ).status,
    "queued",
  );
  await observed(done);
  assert.ok(
    output(literalSearch, "council-history-paraphrase").includes(target.id),
  );
  const foundLiteral = output(nearby, "council-history-literal");
  assert.ok(foundLiteral.includes(exact), foundLiteral);
  const range = output(done, "council-history-nearby");
  assert.ok(range.includes(target.id));
  assert.ok(range.includes("could not replay the write cursor"));
  assert.ok(range.includes("Read the durable Council queue"));
  assert.ok(range.includes("/?councilAgent="));
  await idle();

  const [revision] = await fixture.sql(
    [
      `DELETE FROM chat_messages WHERE chat_id=${literal(chatId)} AND id=${literal(target.id)}`,
    ],
    [
      `SELECT to_jsonb(revision)::text FROM council_history_state WHERE chat_id=${literal(chatId)}`,
    ],
  );
  assert.ok(revision > 0);
  call("council-history-deleted", search, { query: exact, mode: "literal" });
  const missing = call("council-history-missing", read, {
    messageId: target.id,
  });
  const verified = model.reply({
    text: "The old message is no longer available.",
  });
  assert.equal(
    (
      await submit(
        "Is the removed diagnostic still available in retained chat history?",
      )
    ).status,
    "queued",
  );
  await observed(verified);
  assert.match(
    output(missing, "council-history-deleted"),
    /"matches"\s*:\s*\[\]/u,
  );
  assert.match(
    output(verified, "council-history-missing"),
    /"availability"\s*:\s*"unavailable"/u,
  );
  assert.deepEqual(model.failures, []);
  await idle();
  result.councilHistory = {
    chatId,
    sourceId: target.id,
    revisionAfterDelete: revision,
  };
  result.steps.push(
    "Native Council recall found exact and reformulated history, opened nearby evidence, and removed deleted text from its warm index",
  );
}
