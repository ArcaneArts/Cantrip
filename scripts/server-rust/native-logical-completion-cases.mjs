import assert from "node:assert/strict";
import { literal, otherOwner, stamp } from "./project-target-state.mjs";
export async function runLogicalCompletionCases({
  start,
  next,
  raw,
  unchanged,
  seed,
  snapshot,
  reopen,
}) {
  const finish = (c, name, extra = {}, options = {}) =>
    raw("finish", name, (i) => c.key(i, { status: "idle", ...extra }), options);
  const pending = (name, limit, options = {}) =>
    raw("pending", name, limit === undefined ? {} : { limit }, options);
  for (const status of [
    "accepted",
    "dispatched",
    "applied",
    "rejected",
    "uncertain",
  ])
    for (const active of [true, false]) {
      const c = await start({ dispatch: status !== "accepted" });
      await seed([
        `UPDATE native_commands SET status=${literal(status)}`,
        `UPDATE native_command_activations SET active=${active}`,
      ]);
      const before = await snapshot(
        `before logical finish ${status} active=${active}`,
      );
      for (const value of await finish(
        c,
        `logical finish ${status} active=${active}`,
        { status: "failed" },
      ))
        assert.equal(value, active);
      const states = await snapshot(
        `atomic logical finish ${status} active=${active}`,
      );
      for (const [i, state] of states.entries()) {
        const head = state.commands[0];
        assert.equal(
          head.status,
          status === "accepted"
            ? "rejected"
            : status === "dispatched"
              ? "uncertain"
              : status,
        );
        assert.equal(
          head.rejection_code,
          status === "accepted"
            ? "not-dispatched"
            : status === "dispatched"
              ? "missing-native-receipt"
              : null,
        );
        assert.equal(
          head.updated_at,
          before[i].commands[0].updated_at,
          "finish preserves receipt updatedAt",
        );
        assert.ok(head.logical_completed_at);
        assert.ok(head.execution_completed_at);
        assert.equal(state.activations[0].active, false);
        assert.equal(state.completions.length, 1);
        assert.equal(state.completions[0].attempts, 0);
        assert.equal(state.completions[0].root_operation_id, c.operationId);
      }
      for (const value of await unchanged(
        "repeat logical completion " + status + active,
        () => finish(c, "repeat logical completion " + status + active),
      ))
        assert.equal(value, false);
    }
  let c = await start();
  await next("logical head closure fixture", c.continuation);
  await finish(c, "close complete logical chain");
  let states = await snapshot(
    "closure finishes current head and root separately",
  );
  for (const state of states) {
    assert.ok(
      state.commands.find((n) => n.operation_id === c.operationId)
        .logical_completed_at,
    );
    const head = state.commands.find((n) => n.operation_id === "logical-next");
    assert.equal(head.status, "rejected");
    assert.equal(head.rejection_code, "not-dispatched");
    assert.equal(head.logical_completed_at, null);
    assert.equal(state.completions[0].root_operation_id, c.operationId);
  }
  for (const [sql, expected] of [
    ["DELETE FROM native_command_activations", false],
    [
      "INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status) SELECT 'logical-other',owner_id,worker_id,chat_id,'other-generation',origin,method,kind,payload_digest,protected_payload,identity,intent,status FROM native_commands WHERE operation_id='logical-root'; UPDATE native_command_activations SET operation_id='logical-other'",
      false,
    ],
    [
      "UPDATE native_commands SET logical_operation_id=NULL",
      "invalid-continuation-lineage",
    ],
    [
      "UPDATE native_commands SET origin='terminal'",
      "invalid-continuation-lineage",
    ],
    ["UPDATE native_commands SET execution_lane_id=NULL", false],
  ]) {
    c = await start();
    await seed(sql.split("; "));
    const result = await unchanged("logical finish ownership " + sql, () =>
      finish(
        c,
        "logical finish ownership " + sql,
        {},
        typeof expected === "string" ? { error: true, code: expected } : {},
      ),
    );
    if (typeof expected !== "string")
      for (const value of result) assert.equal(value, expected);
  }
  c = await start();
  await seed("UPDATE native_commands SET kind='control'");
  for (const value of await finish(
    c,
    "logical finish does not add root kind fence",
  ))
    assert.equal(value, true);
  c = await start();
  for (const extra of [
    { generation: "wrong" },
    { worker: "beta" },
    { operation: "missing" },
    { owner: otherOwner },
  ])
    await unchanged("logical root scope " + JSON.stringify(extra), () =>
      finish(c, "logical root scope " + JSON.stringify(extra), extra, {
        error: true,
        code: "operation-not-found",
      }),
    );
  await seed([
    "CREATE FUNCTION fail_logical_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'logical completion failure'; END $$",
    "CREATE TRIGGER fail_logical_completion BEFORE INSERT ON native_logical_completions FOR EACH ROW EXECUTE FUNCTION fail_logical_completion()",
  ]);
  await unchanged(
    "completion enqueue failure rolls back lane and receipt",
    () =>
      finish(
        c,
        "completion enqueue failure rolls back lane and receipt",
        {},
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed([
    "DROP TRIGGER fail_logical_completion ON native_logical_completions",
    "DROP FUNCTION fail_logical_completion()",
  ]);
  await finish(c, "delivery fixture completed root");
  const key = (i, extra = {}) => c.key(i, extra);
  for (const value of await pending("completion zero limit", 0))
    assert.deepEqual(value, []);
  for (const limit of [undefined, 1, -1, -0.5])
    for (const list of await pending(
      "completion pending limit " + limit,
      limit,
    )) {
      assert.equal(list.length, 1);
      assert.deepEqual(Object.keys(list[0]), [
        "attempts",
        "rootOperationId",
        "rootOperationGeneration",
        "ownerId",
        "workerId",
        "chatId",
        "createdAt",
      ]);
      assert.equal(list[0].attempts, 0);
    }
  await unchanged("fractional delivery limit uses actual SQL error", () =>
    pending("fractional delivery limit uses actual SQL error", 0.5, {
      error: true,
      sqlstate: "22P02",
    }),
  );
  for (const extra of [
    { owner: otherOwner },
    { worker: "beta" },
    { chat: "missing" },
    { operation: "missing" },
    { generation: "wrong" },
  ]) {
    for (const action of ["get", "ack", "defer"]) {
      const values = await unchanged(
        "completion scope " + action + JSON.stringify(extra),
        () =>
          raw(
            action,
            "completion scope " + action + JSON.stringify(extra),
            (i) =>
              key(i, { nextAttemptAt: "2099-01-01T00:00:00.000Z", ...extra }),
          ),
      );
      for (const value of values)
        assert.equal(value, action === "get" ? null : false);
    }
  }
  for (const value of await raw("get", "exact owner can read completion", key))
    assert.equal(value.attempts, 0);
  for (const value of await raw("defer", "defer completion into future", (i) =>
    key(i, { nextAttemptAt: "2099-01-01T00:00:00.123Z" }),
  ))
    assert.equal(value, true);
  for (const list of await pending("future completion not pending"))
    assert.deepEqual(list, []);
  states = await snapshot("deferred delivery durable due and attempts");
  for (const state of states) {
    assert.equal(state.completions[0].attempts, 1);
    assert.equal(
      Date.parse(state.completions[0].next_attempt_at),
      Date.parse("2099-01-01T00:00:00.123Z"),
    );
  }
  for (const value of await unchanged(
    "repeated finish preserves delivery attempts",
    () => finish(c, "repeated finish preserves delivery attempts"),
  ))
    assert.equal(value, false);
  for (const value of await raw("defer", "retry old completion", (i) =>
    key(i, { nextAttemptAt: stamp }),
  ))
    assert.equal(value, true);
  for (const list of await pending("overdue completion pending again"))
    assert.equal(list[0].attempts, 2);
  await reopen(
    "logical completion and delivery attempts survive process restart",
  );
  for (const value of await raw(
    "get",
    "read persisted completion after restart",
    key,
  ))
    assert.equal(value.attempts, 2);
  await seed("UPDATE native_logical_completions SET attempts=2147483647");
  await unchanged("completion attempt overflow remains actual SQL error", () =>
    raw(
      "defer",
      "completion attempt overflow remains actual SQL error",
      (i) => key(i, { nextAttemptAt: stamp }),
      { error: true, sqlstate: "22003" },
    ),
  );
  await seed("UPDATE native_logical_completions SET attempts=2");
  for (const value of await raw("ack", "ack exact completion", key))
    assert.equal(value, true);
  for (const value of await unchanged("duplicate completion ack", () =>
    raw("ack", "duplicate completion ack", key),
  ))
    assert.equal(value, false);
  for (const value of await raw("get", "acked completion absent", key))
    assert.equal(value, null);
  for (const value of await finish(
    c,
    "owning closure can reenqueue lost completion acknowledgment",
  ))
    assert.equal(value, false);
  for (const list of await pending("reenqueued completion fresh delivery")) {
    assert.equal(list.length, 1);
    assert.equal(list[0].attempts, 0);
  }
  for (const nextAttemptAt of ["0001-01-01T00:00:00.000Z"]) {
    await raw(
      "defer",
      "completion scheduled extended year " + nextAttemptAt,
      (i) => key(i, { nextAttemptAt }),
    );
    await snapshot("scheduled date retained " + nextAttemptAt);
  }
  for (const nextAttemptAt of ["+010000-01-01T00:00:00.123Z", "invalid-date"]) {
    await unchanged("actual source schedule error " + nextAttemptAt, () =>
      raw(
        "defer",
        "actual source schedule error " + nextAttemptAt,
        (i) => key(i, { nextAttemptAt }),
        {
          error: true,
          ...(nextAttemptAt.startsWith("+") ? { sqlstate: "22009" } : {}),
        },
      ),
    );
  }
  await seed("DELETE FROM native_commands WHERE operation_id='logical-root'");
  for (const list of await pending(
    "root deletion cascades completion delivery",
  ))
    assert.deepEqual(list, []);
  c = await start();
  for (const value of await raw(
    "deferred",
    "no unconsumed logical input",
    c.key,
  ))
    assert.equal(value, false);
  for (const [sql, expected] of [
    [
      "UPDATE native_commands SET status='rejected',rejection_code='native-settings-pending',terminal_evidence='{\"kind\":\"deferred\"}',execution_completed_at=now()",
      true,
    ],
    ["UPDATE native_commands SET execution_completed_at=NULL", false],
    [
      'UPDATE native_commands SET execution_completed_at=now(),terminal_evidence=\'{"kind":"terminal"}\'',
      false,
    ],
    [
      "UPDATE native_commands SET terminal_evidence='{\"kind\":\"deferred\"}',rejection_code='other'",
      false,
    ],
    [
      "UPDATE native_commands SET rejection_code='native-settings-pending',status='uncertain'",
      false,
    ],
  ]) {
    await seed(sql.split("; "));
    for (const value of await unchanged("deferred lookup " + sql, () =>
      raw("deferred", "deferred lookup " + sql, c.key),
    ))
      assert.equal(value, expected);
  }
  // Historical pending delivery rows exercise the global scheduler's ordering
  // and default batch size without inventing native execution observations.
  await start();
  await seed([
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) SELECT 'delivery-'||lpad(i::text,3,'0'),${literal(otherOwner)},worker_id,chat_id,'delivery-generation-'||i,'gui',method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at FROM native_commands CROSS JOIN generate_series(0,104) i WHERE operation_id='logical-root'`,
    `INSERT INTO native_logical_completions(owner_id,worker_id,chat_id,root_operation_id,root_operation_generation,next_attempt_at,created_at) SELECT owner_id,worker_id,chat_id,operation_id,operation_generation,${literal(stamp)},${literal(stamp)} FROM native_commands WHERE operation_id LIKE 'delivery-%'`,
  ]);
  for (const [limit, count] of [
    [undefined, 100],
    [1, 1],
    [104, 104],
    [-1, 105],
  ]) {
    for (const list of await pending("global delivery batch " + limit, limit)) {
      assert.equal(list.length, count);
      assert.equal(list[0].ownerId, otherOwner);
      assert.deepEqual(
        list.map((r) => r.rootOperationId),
        Array.from(
          { length: count },
          (_, i) => "delivery-" + String(i).padStart(3, "0"),
        ),
      );
    }
  }
}
