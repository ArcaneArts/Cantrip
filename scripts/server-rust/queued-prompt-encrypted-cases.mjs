import assert from "node:assert/strict";
export async function runEncryptedPromptCases({
  reset,
  seed,
  snapshot,
  call,
  create,
  encrypted,
  unchanged,
  promptId,
  deferredAttachment,
  standalone,
  otherOwner: unused,
}) {
  const foreign = "11111111-1111-4111-8111-111111111111";
  await reset();
  const attachments = [deferredAttachment()];
  const first = await create(
    "encrypted queue create exact opaque payload",
    encrypted(),
    { attachments },
  );
  for (const result of first) {
    assert.equal(result.id, promptId);
    assert.equal(result.position, 0);
    assert.equal(result.revision, 0);
    assert.equal(result.state, "pending");
    assert.deepEqual(result.attachments, attachments);
    assert.deepEqual(result.protectedContent, encrypted().protectedContent);
  }
  await unchanged("encrypted create replays by idempotency key only", () =>
    create(
      "encrypted create replays by idempotency key only",
      encrypted({
        id: "12345678-1234-4234-8234-000000000003",
        frozen: true,
        modelId: "queue-model-two",
      }),
    ),
  );
  let rows = await snapshot("encrypted replay leaves original SQL metadata");
  for (const row of rows) {
    assert.equal(row.prompts.length, 1);
    assert.equal(row.prompts[0].id, promptId);
    assert.equal(row.prompts[0].frozen, false);
    assert.equal(row.prompts[0].model_id, "queue-model");
  }
  for (const request of [{ chat: "missing" }, { owner: foreign }])
    for (const value of await unchanged(
      "encrypted create owner " + JSON.stringify(request),
      () =>
        create(
          "encrypted create owner " + JSON.stringify(request),
          encrypted({ idempotencyKey: "other-key" }),
          request,
        ),
    ))
      assert.equal(value, null);
  const secondId = "12345678-1234-4234-8234-000000000004";
  await create(
    "second encrypted queue position",
    encrypted({ id: secondId, idempotencyKey: "second-key" }),
  );
  for (const list of await call("list-encrypted", "encrypted queue order"))
    assert.deepEqual(
      list.map((p) => p.id),
      [promptId, secondId],
    );
  for (const value of await call(
    "get-encrypted",
    "encrypted lookup owner scope",
    { owner: foreign, prompt: promptId },
  ))
    assert.equal(value, null);
  for (const state of ["pending", "claimed", "consumed", "removed"]) {
    await seed(
      `UPDATE queued_prompts SET state='${state}' WHERE id='${promptId}'`,
    );
    for (const value of await call(
      "get-encrypted",
      "get historical encrypted prompt " + state,
      { prompt: promptId },
    ))
      assert.equal(value.state, state);
    for (const list of await call(
      "list-encrypted",
      "visible encrypted queue state " + state,
    ))
      assert.equal(
        list.some((p) => p.id === promptId),
        state === "pending" || state === "claimed",
      );
  }
  await reset();
  await seed("UPDATE chats SET experience='task' WHERE id='chat'");
  for (const result of await create(
    "Task composer retains opaque Chat-domain queue",
  ))
    assert.equal(result.chatId, "chat");
  await seed("UPDATE chats SET experience='agent' WHERE id='chat'");
  await reset();
  await create("standalone encrypted queue default", encrypted(), {
    chat: standalone,
  });
  for (const invalid of [
    { classification: { mode: "goal", attachmentIds: [] } },
    { worktreeId: "github-alpha-main" },
    { customSubagentModel: true, subagentModelId: "queue-model-two" },
    { subagentModelId: "queue-model-two" },
    { subagentReasoningEffort: "high" },
  ]) {
    await unchanged(
      "standalone queue restriction " + JSON.stringify(invalid),
      () =>
        create(
          "standalone queue restriction " + JSON.stringify(invalid),
          encrypted({ ...invalid, idempotencyKey: "invalid" }),
          { chat: standalone },
          { error: true },
        ),
    );
  }
  for (const result of await call(
    "list-encrypted",
    "standalone encrypted queue list",
    { chat: standalone },
  ))
    assert.equal(result.length, 1);
  for (const result of await call(
    "list-visible",
    "legacy project list omits standalone",
    { chat: standalone },
  ))
    assert.deepEqual(result, []);
  await reset();
  await create("encrypted replacement fixture");
  const replaced = encrypted({
    modelId: "queue-model-two",
    idempotencyKey: "changed-opaque-key",
    reasoningEffort: "high",
    frozen: true,
    worktreeId: "github-alpha-main",
  });
  for (const result of await call(
    "replace-encrypted",
    "replace exact encrypted fields",
    { prompt: promptId, content: replaced, attachments },
  )) {
    assert.equal(result.modelId, "queue-model-two");
    assert.equal(result.reasoningEffort, "high");
    assert.equal(result.frozen, true);
  }
  rows = await snapshot(
    "encrypted replacement preserves SQL model id and key revision state position",
  );
  for (const row of rows) {
    const p = row.prompts[0];
    assert.equal(p.model_id, "queue-model");
    assert.equal(p.idempotency_key, "retained-prompt");
    assert.equal(p.revision, 0);
    assert.equal(p.state, "pending");
    assert.equal(p.position, 0);
    assert.equal(p.opaque_content.modelId, "queue-model-two");
    assert.equal(p.opaque_content.idempotencyKey, "changed-opaque-key");
  }
  for (const result of await unchanged(
    "replace target id must match protected input",
    () =>
      call(
        "replace-encrypted",
        "replace target id must match protected input",
        { prompt: "different", content: replaced },
      ),
  ))
    assert.equal(result, null);
  for (const result of await unchanged("replace encrypted owner scope", () =>
    call("replace-encrypted", "replace encrypted owner scope", {
      owner: foreign,
      prompt: promptId,
      content: replaced,
    }),
  ))
    assert.equal(result, null);
  await seed("UPDATE queued_prompts SET state='consumed'");
  for (const result of await call(
    "replace-encrypted",
    "replacement retains terminal queue state",
    { prompt: promptId, content: encrypted() },
  ))
    assert.equal(result.state, "consumed");
  await reset();
  await create("integer position overflow seed");
  await seed("UPDATE queued_prompts SET position=2147483647");
  await unchanged("position overflow is actual SQL error", () =>
    create(
      "position overflow is actual SQL error",
      encrypted({ id: secondId, idempotencyKey: "overflow" }),
      {},
      { error: true, sqlstate: "22003" },
    ),
  );
  await reset();
  await unchanged("nonexistent encrypted SQL model failure", () =>
    create(
      "nonexistent encrypted SQL model failure",
      encrypted({ modelId: "missing-model" }),
      {},
      { error: true, sqlstate: "23503" },
    ),
  );
}
