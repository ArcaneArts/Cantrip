// The real repositories must commit the terminal dispatch and retry category
// together. These cases use actual SQL faults and the existing encrypted rows.
import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
import { runTaskFailureSettlementRaces } from "./task-failure-settlement-races.mjs";

export async function runTaskFailureSettlementCases(h, cleanTask) {
  const cycle = "87878787-8787-4878-8878-000000000001";
  const fence = {
    cycleId: cycle,
    operationId: "failed-operation",
    leaseOwner: "failure-settlement-server",
    fencingToken: 7,
  };
  const now = Date.parse(stamp);
  const key = `dispatch:${cycle}:7`;
  async function clean(extra = []) {
    await cleanTask([
      "DELETE FROM task_dispatch_cycles",
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,lease_owner,lease_expires_at,fencing_token,fifo_created_at,created_at,updated_at) VALUES('${cycle}',${literal(h.owner)},'task','failed-operation','direct','running','failure-settlement-server',${literal(stamp)}::timestamptz+interval '2 minutes',7,${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const run = (name, fields = {}, options = {}) =>
    h.observe(
      name,
      {
        chat: "task",
        action: "settle",
        fence,
        now,
        kind: "usage-limit",
        ...fields,
      },
      { op: "native-command-task-retry", shape: "raw", ...options },
    );
  const rows = (name) =>
    h.observe(
      name,
      {
        sql:
          "SELECT jsonb_build_object('task',to_jsonb(t),'cycle',(SELECT to_jsonb(c) FROM task_dispatch_cycles c WHERE id=" +
          literal(cycle) +
          ")) result FROM tasks t WHERE chat_id='task'",
      },
      { op: "query-json", shape: "raw" },
    );
  const record = (kind, at = now) => ({
    status: [
      "timeout",
      "capacity",
      "rate-limit",
      "connection",
      "runtime",
    ].includes(kind)
      ? "scheduled"
      : "manual",
    failureKind: kind,
    failureKey: key,
    dueAt: [
      "timeout",
      "capacity",
      "rate-limit",
      "connection",
      "runtime",
    ].includes(kind)
      ? at + 5000
      : null,
    attempts: [],
    claim: null,
  });
  for (const kind of [
    "timeout",
    "capacity",
    "rate-limit",
    "connection",
    "runtime",
    "needs-input",
    "configuration",
    "usage-limit",
    "budget-limit",
  ]) {
    await clean();
    for (const v of await run("atomic failed dispatch category " + kind, {
      kind,
    }))
      assert.equal(v.value, true);
    for (const r of await rows(
      "committed failed dispatch and precise retry " + kind,
    )) {
      assert.equal(r.cycle.state, "failed");
      assert.equal(Date.parse(r.cycle.completed_at), now);
      assert.deepEqual(r.task.automatic_retry, record(kind));
      assert.equal(r.task.row_version, 1);
      assert.equal(r.task.scheduler_revision, 1);
      assert.equal(Date.parse(r.task.updated_at), now);
      assert.deepEqual(r.task.protected_content, taskEnvelope);
    }
    const before = await rows("before duplicate failed dispatch " + kind);
    await run(
      "duplicate settlement rejects its stale fence " + kind,
      { kind: "runtime", now: now + 1000 },
      { error: true },
    );
    assert.deepEqual(
      await rows("duplicate failure retains exact ledger " + kind),
      before,
    );
  }
  for (const [name, fields, extra] of [
    ["foreign Task", { owner: otherOwner }, []],
    ["missing Task", { chat: "missing" }, []],
    [
      "wrong cycle",
      { fence: { ...fence, cycleId: "87878787-8787-4878-8878-000000000002" } },
      [],
    ],
    [
      "wrong operation",
      { fence: { ...fence, operationId: "other-operation" } },
      [],
    ],
    [
      "wrong lease owner",
      { fence: { ...fence, leaseOwner: "other-server" } },
      [],
    ],
    ["replaced token", { fence: { ...fence, fencingToken: 8 } }, []],
    ["expired lease", { now: now + 120000 }, []],
    [
      "archived Task",
      {},
      [`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='task'`],
    ],
    [
      "foreign cycle owner",
      {},
      [
        `UPDATE task_dispatch_cycles SET owner_id=${literal(otherOwner)} WHERE id='${cycle}'`,
      ],
    ],
    [
      "different cycle Chat",
      {},
      [
        `INSERT INTO tasks(chat_id,protected_content) VALUES('chat',${json(taskEnvelope)})`,
        `UPDATE task_dispatch_cycles SET chat_id='chat' WHERE id='${cycle}'`,
      ],
    ],
    ...["queued", "succeeded", "failed", "cancelled", "expired"].map(
      (state) => [
        state + " cycle",
        {},
        [
          `UPDATE task_dispatch_cycles SET state=${literal(state)} WHERE id='${cycle}'`,
        ],
      ],
    ),
  ]) {
    await clean(extra);
    const before = await rows("before rejected atomic settlement " + name);
    await run("atomic settlement rejects " + name, fields, { error: true });
    assert.deepEqual(
      await rows("rejected atomic settlement keeps both rows " + name),
      before,
    );
  }
  const prior = record("usage-limit");
  await clean();
  for (const v of await run("fractional retry deadline retains precision", {
    now: now + 0.75,
    kind: "timeout",
  }))
    assert.equal(v.value, true);
  for (const r of await rows(
    "fractional deadline with Date-clipped dispatch time",
  )) {
    assert.deepEqual(r.task.automatic_retry, record("timeout", now + 0.75));
    assert.equal(Date.parse(r.cycle.completed_at), now);
  }
  for (const [name, state, previous, expected, changed] of [
    ["complete Task", "complete", prior, null, false],
    ["same failure key", "failed", prior, prior, false],
    [
      "latched retry",
      "failed",
      {
        ...prior,
        status: "latched",
        failureKey: "previous",
        attempts: [now - 1000],
      },
      { ...prior, status: "latched", attempts: [now - 1000] },
      true,
    ],
    [
      "recent attempt window",
      "failed",
      {
        ...prior,
        failureKey: "previous",
        attempts: [now - 60000, now - 59999],
      },
      { ...prior, attempts: [now - 59999] },
      true,
    ],
  ]) {
    await clean([
      `UPDATE tasks SET state=${literal(state)},automatic_retry=${json(previous)} WHERE chat_id='task'`,
    ]);
    for (const v of await run("atomic settlement preserves " + name))
      assert.equal(v.value, changed);
    for (const r of await rows("settled existing ledger " + name)) {
      assert.equal(r.cycle.state, "failed");
      assert.deepEqual(r.task.automatic_retry, expected);
    }
  }
  await clean();
  await h.seed([
    "CREATE FUNCTION task_retry_settlement_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM task_dispatch_cycles WHERE chat_id=NEW.chat_id AND state='failed') THEN RAISE EXCEPTION 'fenced settlement was not visible' USING ERRCODE='P7102'; END IF; RAISE EXCEPTION 'retry ledger write failed after fenced settlement' USING ERRCODE='P7101'; END $$",
    "CREATE TRIGGER task_retry_settlement_fault BEFORE UPDATE OF automatic_retry ON tasks FOR EACH ROW EXECUTE FUNCTION task_retry_settlement_fault()",
  ]);
  const before = await rows("before retry ledger SQL failure");
  // Driver diagnostics differ, but the actual SQL failure must reach each
  // caller and both rows must retain all fields from before the transaction.
  for (const [i, peer] of h.pair.entries()) {
    const result = await peer.request({
      op: "native-command-task-retry",
      owner: h.owner,
      chat: "task",
      action: "settle",
      fence,
      kind: "usage-limit",
      now,
    });
    (h.report.taskFailureSettlementFaults ??= []).push({
      peer: i === 0 ? "node" : "rust",
      result,
    });
    assert.equal(result.rejected, true);
    assert.equal(
      result.databaseCode,
      "P7101",
      "the trigger observed the terminal dispatch before failing the ledger write",
    );
  }
  assert.deepEqual(
    await rows("retry ledger SQL failure rolls back actual dispatch write"),
    before,
  );
  await h.seed([
    "DROP TRIGGER task_retry_settlement_fault ON tasks",
    "DROP FUNCTION task_retry_settlement_fault()",
  ]);
  for (const v of await run("the same fence recovers after retry ledger fault"))
    assert.equal(v.value, true);
  const persisted = await rows("recovered precise failure before restart");
  await h.reopen("atomic failure ledger restart");
  assert.deepEqual(
    await rows("atomic failure ledger persists after restart"),
    persisted,
  );
  if (h.databaseMode === "postgres")
    await runTaskFailureSettlementRaces(h, clean, fence, now);
}
