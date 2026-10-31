import assert from "node:assert/strict";
export async function runManagedGuiFinishCases({
  start,
  raw,
  snapshot,
  seed,
  unchanged,
}) {
  const finish = (c, name, extra = {}, options = {}) =>
    raw(
      "managed-finish",
      name,
      (i) => ({
        ...c.key(i),
        receipt: c.admitted[i].receipt,
        status: "idle",
        ...extra,
      }),
      options,
    );
  const checkTrace = (results, finished, error = false) => {
    for (const r of results) {
      assert.equal(r.finished, finished);
      assert.equal(r.trace[0].kind, "request");
      assert.equal(
        r.trace[0].committed,
        true,
        "logical closure is durable before worker release",
      );
      assert.equal(r.trace[0].command.type, "chat.native-logical.complete");
      assert.equal(
        r.trace.filter((t) => t.kind === "ack-error").length,
        error ? 1 : 0,
      );
    }
  };
  let c = await start();
  checkTrace(
    await finish(c, "managed GUI finish commits then acknowledges exact root"),
    true,
  );
  for (const s of await snapshot(
    "managed GUI closure and worker acknowledgment committed",
  )) {
    assert.equal(s.completions, null);
    assert.ok(s.commands[0].logical_completed_at);
    assert.ok(s.commands[0].execution_completed_at);
  }
  checkTrace(
    await finish(c, "replayed managed GUI finish acknowledges requeued root"),
    false,
  );
  c = await start();
  checkTrace(
    await finish(c, "managed GUI worker rejection retains closure", {
      responseError: true,
    }),
    true,
    true,
  );
  for (const s of await snapshot(
    "managed GUI rejection leaves durable outbox",
  )) {
    assert.equal(s.completions.length, 1);
    assert.equal(s.completions[0].attempts, 0);
    assert.ok(s.commands[0].logical_completed_at);
  }
  checkTrace(
    await finish(c, "managed GUI retry releases original generation"),
    false,
  );
  c = await start();
  await seed([
    "CREATE FUNCTION fail_gui_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ack persistence failure'; END $$",
    "CREATE TRIGGER fail_gui_ack BEFORE DELETE ON native_logical_completions FOR EACH ROW EXECUTE FUNCTION fail_gui_ack()",
  ]);
  checkTrace(
    await finish(c, "managed GUI acknowledgment SQL failure retains outbox"),
    true,
    true,
  );
  for (const s of await snapshot("managed GUI SQL failure preserves closure")) {
    assert.equal(s.completions.length, 1);
    assert.equal(s.completions[0].attempts, 0);
    assert.ok(s.commands[0].logical_completed_at);
  }
  await seed([
    "DROP TRIGGER fail_gui_ack ON native_logical_completions",
    "DROP FUNCTION fail_gui_ack()",
  ]);
  checkTrace(await finish(c, "managed GUI acknowledgment SQL recovery"), false);
  c = await start();
  await seed("DELETE FROM native_command_activations");
  for (const r of await unchanged(
    "managed GUI missing activation sends no completion",
    () => finish(c, "managed GUI missing activation sends no completion"),
  ))
    assert.deepEqual(r, { finished: false, trace: [] });
  c = await start();
  await unchanged(
    "managed GUI wrong generation propagates finish failure",
    () =>
      finish(
        c,
        "managed GUI wrong generation propagates finish failure",
        { receipt: { ...c.admitted[0].receipt, operationGeneration: "wrong" } },
        { error: true, code: "operation-not-found" },
      ),
  );
  await seed([
    "CREATE FUNCTION fail_gui_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'closure persistence failure'; END $$",
    "CREATE TRIGGER fail_gui_finish BEFORE INSERT ON native_logical_completions FOR EACH ROW EXECUTE FUNCTION fail_gui_finish()",
  ]);
  await unchanged(
    "managed GUI closure SQL failure is not an acknowledgment error",
    () =>
      finish(
        c,
        "managed GUI closure SQL failure is not an acknowledgment error",
        {},
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed([
    "DROP TRIGGER fail_gui_finish ON native_logical_completions",
    "DROP FUNCTION fail_gui_finish()",
  ]);
}
