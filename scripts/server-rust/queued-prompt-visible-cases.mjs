import assert from "node:assert/strict";
export async function runVisiblePromptCases({
  reset,
  seed,
  snapshot,
  call,
  create,
  visible,
  encrypted,
  unchanged,
  deferredAttachment,
  promptId,
  standalone,
}) {
  const foreign = "11111111-1111-4111-8111-111111111111";
  await reset();
  const legacy = await call("create-visible", "legacy queue create", {
    content: visible({
      reasoningEffort: "low",
      worktreeId: "github-alpha-main",
    }),
    model: "queue-model",
    attachments: [deferredAttachment()],
  });
  for (const value of legacy) {
    assert.match(
      value.id,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    assert.deepEqual(value.attachments, []);
    assert.equal(value.position, 0);
  }
  const rows = await snapshot("legacy mapper hides SQL attachments");
  for (const row of rows) assert.equal(row.prompts[0].attachments.length, 1);
  await unchanged("legacy replay uses SQL idempotency key", () =>
    call("create-visible", "legacy replay uses SQL idempotency key", {
      content: visible({ text: "changed", frozen: true }),
      model: "queue-model-two",
    }),
  );
  for (const values of await call("list-visible", "legacy queue list"))
    assert.equal(values.length, 1);
  for (const result of await call("key-visible", "legacy lookup by key", {
    key: "legacy-key",
  }))
    assert.equal(result.text, "Legacy fixture");
  for (const extra of [
    { owner: foreign },
    { chat: standalone },
    { chat: "missing" },
  ])
    for (const result of await unchanged(
      "legacy create scope " + JSON.stringify(extra),
      () =>
        call("create-visible", "legacy create scope " + JSON.stringify(extra), {
          content: visible(),
          model: "queue-model",
          ...extra,
        }),
    ))
      assert.equal(result, null);
  for (const worktreeId of ["missing", "other-foreign-main"]) {
    for (const result of await call(
      "create-visible",
      "legacy queue worktree scope " + worktreeId,
      {
        content: visible({ worktreeId, idempotencyKey: "worktree-key" }),
        model: "queue-model",
      },
    ))
      assert.equal(result, null);
  }
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
  );
  for (const result of await call(
    "create-visible",
    "legacy replay checks target before old key",
    {
      content: visible({ worktreeId: "github-alpha-main" }),
      model: "queue-model",
    },
  ))
    assert.equal(result, null);
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  await seed("UPDATE chats SET experience='task' WHERE id='chat'");
  for (const result of await call(
    "create-visible",
    "Task blocks legacy visible create",
    { content: visible(), model: "queue-model" },
  ))
    assert.equal(result, null);
  for (const result of await call(
    "update-visible",
    "Task blocks legacy visible edit",
    (i) => ({ prompt: legacy[i].id, content: { text: "changed" } }),
  ))
    assert.equal(result, null);
  for (const result of await call(
    "get-visible",
    "Task does not hide pre-existing visible row",
    (i) => ({ prompt: legacy[i].id }),
  ))
    assert.equal(result.text, "Legacy fixture");
  await seed("UPDATE chats SET experience='agent' WHERE id='chat'");
  for (const patch of [
    { text: "updated" },
    { mode: "goal" },
    { reasoningEffort: null },
    { frozen: true },
  ])
    await call(
      "update-visible",
      "legacy partial patch " + JSON.stringify(patch),
      (i) => ({ prompt: legacy[i].id, content: patch }),
    );
  for (const result of await call(
    "get-visible",
    "legacy patch preserved unset fields",
    (i) => ({ prompt: legacy[i].id }),
  )) {
    assert.equal(result.text, "updated");
    assert.equal(result.mode, "goal");
    assert.equal(result.reasoningEffort, null);
    assert.equal(result.frozen, true);
    assert.equal(result.modelId, "queue-model");
    assert.equal(result.worktreeId, "github-alpha-main");
  }
  for (const result of await call(
    "update-visible",
    "legacy update attachment replacement",
    (i) => ({
      prompt: legacy[i].id,
      content: { frozen: false },
      attachments: [],
    }),
  ))
    assert.deepEqual(result.attachments, []);
  await reset();
  await create("opaque row outside visible mapper");
  for (const action of ["list-visible", "get-visible", "key-visible"]) {
    await unchanged("visible mapper rejects opaque row " + action, () =>
      call(
        action,
        "visible mapper rejects opaque row " + action,
        { prompt: promptId, key: "retained-prompt" },
        { error: true },
      ),
    );
  }
  await unchanged("legacy create cannot replay opaque row", () =>
    call(
      "create-visible",
      "legacy create cannot replay opaque row",
      {
        content: visible({ idempotencyKey: "retained-prompt" }),
        model: "queue-model",
      },
      { error: true },
    ),
  );
  const before = await snapshot("before visible write onto opaque row");
  await call(
    "update-visible",
    "legacy edit commits before opaque mapper fails",
    { prompt: promptId, content: { frozen: true } },
    { error: true },
  );
  const after = await snapshot(
    "opaque mapper failure retains standalone legacy update",
  );
  for (const [i, state] of after.entries()) {
    assert.equal(state.prompts[0].frozen, true);
    assert.equal(before[i].prompts[0].frozen, false);
  }
  await reset();
  const plain = await call(
    "create-visible",
    "legacy row outside encrypted mapper",
    { content: visible(), model: "queue-model" },
  );
  await unchanged("encrypted mapper rejects visible row", () =>
    call(
      "get-encrypted",
      "encrypted mapper rejects visible row",
      (i) => ({ prompt: plain[i].id }),
      { error: true },
    ),
  );
  await unchanged(
    "encrypted replacement cannot change visible content shape",
    () =>
      call(
        "replace-encrypted",
        "encrypted replacement cannot change visible content shape",
        (i) => ({
          prompt: plain[i].id,
          content: encrypted({ id: plain[i].id }),
        }),
        { error: true, sqlstate: "23514" },
      ),
  );
}
