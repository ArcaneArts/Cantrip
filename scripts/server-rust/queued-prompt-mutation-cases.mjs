import assert from "node:assert/strict";
export async function runPromptMutationCases({
  reset,
  seed,
  snapshot,
  call,
  create,
  encrypted,
  visible,
  unchanged,
  promptId,
  literal,
  json,
  stamp,
}) {
  const second = "12345678-1234-4234-8234-000000000005";
  await reset();
  await create("queue order first");
  await create(
    "queue order second",
    encrypted({ id: second, idempotencyKey: "second-order" }),
  );
  await seed(
    `UPDATE queued_prompts SET state='consumed' WHERE id=${literal(second)}`,
  );
  for (const ids of [
    [promptId],
    [promptId, promptId],
    [promptId, "missing"],
    [],
  ])
    for (const result of await unchanged(
      "queue reorder complete membership " + JSON.stringify(ids),
      () =>
        call(
          "reorder",
          "queue reorder complete membership " + JSON.stringify(ids),
          { content: { ids } },
        ),
    ))
      assert.equal(result, false);
  for (const value of await call(
    "reorder",
    "reorder includes terminal state rows",
    { content: { ids: [second, promptId] } },
  ))
    assert.equal(value, true);
  let states = await snapshot(
    "all queue positions reordered without changing revision state",
  );
  for (const state of states) {
    assert.equal(state.prompts.find((p) => p.id === second).position, 0);
    assert.equal(state.prompts.find((p) => p.id === promptId).position, 1);
    assert.equal(
      state.prompts.every((p) => p.revision === 0),
      true,
    );
  }
  await seed([
    "CREATE FUNCTION queue_order_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM queued_prompts WHERE position=0 AND id='456789ab-1234-4234-8234-000000000002') THEN RAISE EXCEPTION 'first position update missing' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'second position failure' USING ERRCODE='P0001'; END $$",
    `CREATE TRIGGER queue_order_fault BEFORE UPDATE ON queued_prompts FOR EACH ROW WHEN (OLD.id=${literal(second)}) EXECUTE FUNCTION queue_order_fault()`,
  ]);
  await unchanged("queue reorder rolls back all item writes", () =>
    call(
      "reorder",
      "queue reorder rolls back all item writes",
      { content: { ids: [promptId, second] } },
      { error: true, sqlstate: "P0001" },
    ),
  );
  await seed([
    "DROP TRIGGER queue_order_fault ON queued_prompts",
    "DROP FUNCTION queue_order_fault()",
  ]);
  for (const result of await call(
    "delete",
    "delete encrypted returns captured protected row",
    { prompt: promptId },
  ))
    assert.equal(result.id, promptId);
  for (const result of await unchanged("duplicate delete returns null", () =>
    call("delete", "duplicate delete returns null", { prompt: promptId }),
  ))
    assert.equal(result, null);
  await reset();
  for (const result of await call(
    "reorder",
    "empty order on missing chat follows Source",
    { chat: "missing", content: { ids: [] } },
  ))
    assert.equal(result, true);
  const plain = await call("create-visible", "delete visible fixture", {
    content: visible(),
    model: "queue-model",
  });
  for (const value of await call(
    "delete",
    "delete legacy visible row",
    (i) => ({ prompt: plain[i].id }),
  ))
    assert.equal(value.text, "Legacy fixture");
  await reset();
  await create("malformed opaque queue row fixture");
  await seed("UPDATE queued_prompts SET opaque_content='{}'::jsonb");
  await unchanged(
    "malformed queue encrypted read validates actual schema",
    () =>
      call(
        "get-encrypted",
        "malformed queue encrypted read validates actual schema",
        { prompt: promptId },
        { error: true },
      ),
  );
  await call(
    "delete",
    "delete occurs before malformed opaque row mapping fails",
    { prompt: promptId },
    { error: true },
  );
  states = await snapshot(
    "post-delete mapper failure does not restore malformed queue",
  );
  for (const state of states) assert.equal(state.prompts, null);
  await reset();
  await create("same id different key duplicate fixture");
  await unchanged("encrypted prompt duplicate primary id is SQL error", () =>
    create(
      "encrypted prompt duplicate primary id is SQL error",
      encrypted({ idempotencyKey: "different-key" }),
      {},
      { error: true, sqlstate: "23505" },
    ),
  );
  await reset();
  await seed(
    `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,created_at,updated_at) VALUES('�','chat','Unicode fixture','queue-model','unicode-key',${literal(stamp)},${literal(stamp)})`,
  );
  for (const result of await unchanged(
    "queue order compares original UTF16 identity",
    () =>
      call("reorder", "queue order compares original UTF16 identity", {
        content: { ids: ["\ud800"] },
      }),
  ))
    assert.equal(result, false);
  for (const result of await call(
    "get-visible",
    "legacy lookup encodes UTF16 only at SQL boundary",
    { prompt: "\ud800" },
  ))
    assert.equal(result.id, "�");
  for (const result of await call(
    "reorder",
    "actual replacement character matches stored order",
    { content: { ids: ["�"] } },
  ))
    assert.equal(result, true);
  await reset();
  await seed([
    "CREATE FUNCTION queue_create_shape_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.opaque_content='{}'::jsonb; RETURN NEW; END $$",
    "CREATE TRIGGER queue_create_shape_fault BEFORE INSERT ON queued_prompts FOR EACH ROW EXECUTE FUNCTION queue_create_shape_fault()",
  ]);
  await create(
    "standalone insert persists before returned row validation",
    encrypted(),
    {},
    { error: true },
  );
  states = await snapshot(
    "failed output parse preserves actual committed insert",
  );
  for (const state of states) {
    assert.equal(state.prompts.length, 1);
    assert.deepEqual(state.prompts[0].opaque_content, {});
  }
  await seed([
    "DROP TRIGGER queue_create_shape_fault ON queued_prompts",
    "DROP FUNCTION queue_create_shape_fault()",
  ]);
}
