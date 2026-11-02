import assert from "node:assert/strict";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { label } from "./project-target-state.mjs";
export async function runAutomaticTitleCases(h) {
  const { observe, seed, reset, snapshot, standalone } = h;
  const message = retainedPrompt().pendingMessage,
    labelResult = { titleProtection: label("chat") };
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM chat_messages",
      "UPDATE chats SET model_id='bootstrap-model',auto_title_pending=true,auto_title_claim=NULL",
      "UPDATE user_settings SET auto_name_chats=true,random_agent_names=false,labeling_model_id=NULL,default_model_id='bootstrap-model'",
    ]);
  };
  const run = (name, fields = {}) =>
    observe(
      name,
      { action: "generate", chat: "chat", message, labelResult, ...fields },
      { op: "native-command-automatic-title", shape: "raw" },
    );
  await clean();
  let values = await run(
    "message title uses the actual atomic claim, route resolver and worker label contract",
  );
  for (const value of values) {
    assert.equal(value.commands.length, 1);
    assert.equal(value.commands[0].command.type, "label.generate");
    assert.equal(value.commands[0].command.labelKind, "agent");
    assert.equal(value.commands[0].timeoutMs, 30000);
    assert.equal(value.events.length, 1);
  }
  let states = await snapshot("successful title clears its real claim");
  for (const state of states) {
    const row = state.chats.find((c) => c.id === "chat");
    assert.equal(row.auto_title_pending, false);
    assert.equal(row.auto_title_claim, null);
    assert.deepEqual(row.protected_label, labelResult.titleProtection);
  }
  values = await run(
    "an already consumed automatic title is not generated twice",
  );
  for (const value of values) {
    assert.equal(value.commands.length, 0);
    assert.equal(value.events.length, 0);
  }
  await clean();
  values = await run("standalone message titles retain their chat label kind", {
    chat: standalone,
  });
  for (const value of values) {
    assert.equal(value.commands[0].command.labelKind, "chat");
    assert.equal(value.events[0].scope.kind, "current-user");
  }
  await clean();
  values = await run(
    "worker title errors release the claim without logging private error content",
    { failRequest: true },
  );
  for (const value of values) {
    assert.ok(
      value.logs.some((l) => l.message === "Automatic title unavailable"),
    );
    assert.ok(
      !JSON.stringify(value.logs).includes("private-provider-error-marker"),
    );
    assert.equal(value.events.length, 0);
  }
  states = await snapshot("failed naming retains no automatic-title claim");
  for (const state of states) {
    const row = state.chats.find((c) => c.id === "chat");
    assert.equal(row.auto_title_claim, null);
    assert.equal(row.auto_title_pending, false);
  }
  await clean();
  values = await run(
    "naming disabled while the worker is running cannot publish its result",
    { beforeReplySQL: "UPDATE user_settings SET auto_name_chats=false" },
  );
  for (const value of values) {
    assert.equal(value.commands.length, 1);
    assert.equal(value.events.length, 0);
  }
  await snapshot("disabled title reply still releases the actual claim");
  await clean();
  values = await run(
    "empty label input reopens automatic naming for a later request",
    { labelResult: { titleProtection: null, emptyInput: true } },
  );
  for (const value of values) assert.equal(value.events.length, 0);
  states = await snapshot(
    "empty label result retains pending metadata without a claim",
  );
  for (const state of states) {
    const row = state.chats.find((c) => c.id === "chat");
    assert.equal(row.auto_title_pending, true);
    assert.equal(row.auto_title_claim, null);
  }
  await clean();
  await seed("UPDATE user_settings SET random_agent_names=true");
  values = await run("random agent names suppress automatic message naming");
  for (const value of values) assert.equal(value.commands.length, 0);
  await clean();
  values = await run(
    "Task backing chat is never named from its synthesized message",
    { chat: "task" },
  );
  for (const value of values) assert.equal(value.commands.length, 0);
  await clean();
  const claims = await observe(
    "title claim is acquired by the real conditional UPDATE",
    { action: "claim", chat: "chat", messageId: message.id },
    { op: "native-command-automatic-title", shape: "raw" },
  );
  for (const value of claims) assert.equal(typeof value, "string");
  values = await observe(
    "a second title claimant cannot borrow the active claim",
    { action: "claim", chat: "chat", messageId: message.id },
    { op: "native-command-automatic-title", shape: "raw" },
  );
  for (const value of values) assert.equal(value, null);
  values = await observe(
    "wrong claim cannot finish protected title metadata",
    {
      action: "finish",
      chat: "chat",
      claim: "foreign-claim",
      title: labelResult.titleProtection,
    },
    { op: "native-command-automatic-title", shape: "raw" },
  );
  for (const value of values) assert.equal(value, null);
  values = await observe(
    "the actual title claimant may finish its own protected metadata",
    (i) => ({
      action: "finish",
      chat: "chat",
      claim: claims[i],
      title: labelResult.titleProtection,
    }),
    { op: "native-command-automatic-title", shape: "raw" },
  );
  for (const value of values) assert.equal(value.id, "chat");
  await snapshot("title claim fences and opaque result are durable");
}
