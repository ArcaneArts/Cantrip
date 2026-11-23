import assert from "node:assert/strict";
import { runTaskRetryRaces } from "./task-retry-races.mjs";
import { runTaskRetryAdoptionRaces } from "./task-retry-adoption-races.mjs";
import { runTaskFailureSettlementCases } from "./task-failure-settlement-cases.mjs";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
export async function runTaskRetryCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const chat = "task";
  const now = 60000;
  const run = (name, action, fields = {}) =>
    observe(
      name,
      typeof fields === "function"
        ? (i) => ({ chat, action, now, ...fields(i) })
        : { chat, action, now, ...fields },
      { op: "native-command-task-retry", shape: "raw" },
    );
  async function ok(name, action, fields = {}, check = () => {}) {
    const values = await run(name, action, fields);
    for (const v of values) {
      assert.ok(Object.hasOwn(v, "value"), name);
      check(v.value);
    }
    return values.map((v) => v.value);
  }
  const rows = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('retry',t.automatic_retry,'rowVersion',t.row_version,'schedulerRevision',t.scheduler_revision,'protectedContent',t.protected_content,'updatedAt',t.updated_at) result FROM tasks t WHERE chat_id='task'",
      },
      { op: "query-json", shape: "raw" },
    );
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "UPDATE chats SET experience='task',status='idle',automation_paused=false,archived_at=NULL WHERE id='task'",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
      `INSERT INTO tasks(chat_id,state,last_error,protected_content,created_at,updated_at) VALUES('task','failed',${json({ code: "task-runtime", operationKind: "implementation", occurredAt: stamp })},${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const record = (status = "scheduled", extra = {}) => ({
    status,
    failureKind: "runtime",
    failureKey: "seed",
    dueAt: 65000,
    attempts: [],
    claim: null,
    ...extra,
  });
  const put = (value) =>
    seed(
      `UPDATE tasks SET automatic_retry=${value === null ? "NULL" : json(value)} WHERE chat_id='task'`,
    );
  await clean();
  const observed = { code: "task-runtime", occurredAt: stamp };
  const retryRows = async (name) =>
    (await rows(name)).map((value) => {
      const row = Array.isArray(value) ? value[0] : value;
      return row.result ?? row;
    });
  await ok(
    "adopt a legacy failure under the owner lock",
    "adopt",
    observed,
    (v) => assert.equal(v, true),
  );
  for (const row of await retryRows("adopted legacy retry record")) {
    assert.deepEqual(
      row.retry,
      record("scheduled", {
        failureKey: `observed:${observed.code}:${stamp}`,
      }),
    );
    assert.equal(row.rowVersion, 1);
    assert.equal(row.schedulerRevision, 1);
    assert.deepEqual(row.protectedContent, taskEnvelope);
    assert.equal(Date.parse(row.updatedAt), Date.parse(stamp));
  }
  await ok(
    "duplicate adoption retains original countdown",
    "adopt",
    {
      ...observed,
      now: 99999,
    },
    (v) => assert.equal(v, false),
  );
  for (const status of ["manual", "scheduled", "retrying", "latched", "idle"]) {
    await clean();
    const existing = record(status, {
      failureKind: "usage-limit",
      dueAt: null,
    });
    await put(existing);
    await ok(
      `adoption preserves an existing ${status} record`,
      "adopt",
      observed,
      (v) => assert.equal(v, false),
    );
    for (const row of await retryRows(`retained ${status} record`))
      assert.deepEqual(row.retry, existing);
  }
  for (const fields of [
    { code: "task-timeout" },
    { occurredAt: "2026-10-25T00:00:01.123Z" },
  ]) {
    await clean();
    await ok(
      "stale failure identity cannot be adopted",
      "adopt",
      {
        ...observed,
        ...fields,
      },
      (v) => assert.equal(v, false),
    );
    for (const row of await retryRows("stale adoption leaves ledger absent"))
      assert.equal(row.retry, null);
  }
  for (const state of [
    "draft",
    "planning",
    "implementing",
    "review",
    "complete",
    "blocked",
  ]) {
    await clean([
      `UPDATE tasks SET state=${literal(state)} WHERE chat_id='task'`,
    ]);
    await ok(`adoption cannot change a ${state} Task`, "adopt", observed, (v) =>
      assert.equal(v, false),
    );
  }
  await clean(["UPDATE tasks SET last_error=NULL WHERE chat_id='task'"]);
  await ok("cleared failure cannot be adopted", "adopt", observed, (v) =>
    assert.equal(v, false),
  );
  await clean();
  for (const chat of ["task", "missing"])
    await ok(
      "adoption requires an owned Task",
      "adopt",
      {
        ...observed,
        chat,
        owner: otherOwner,
      },
      (v) => assert.equal(v, null),
    );
  await clean();
  await ok("failed Task without ledger is a candidate", "list", {}, (v) =>
    assert.equal(v.length, 1),
  );
  for (const action of ["note", "reset", "clear", "claim", "finish"]) {
    for (const foreign of [true, false])
      await ok(
        `${action} missing or foreign Task`,
        action,
        {
          chat: foreign ? chat : "missing",
          owner: foreign ? otherOwner : owner,
          key: "key",
          kind: "runtime",
          claim: "missing",
        },
        (v) => assert.equal(v, null),
      );
  }
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
    await ok("note " + kind, "note", { key: "failure", kind }, (v) =>
      assert.equal(v, true),
    );
    await ok(
      "duplicate " + kind + " does not restart countdown",
      "note",
      { key: "failure", kind: "runtime", now: 99999 },
      (v) => assert.equal(v, false),
    );
    await ok(
      "only retryable categories are due " + kind,
      "list",
      { now: 65000 },
      (v) =>
        assert.equal(
          v.length,
          [
            "timeout",
            "capacity",
            "rate-limit",
            "connection",
            "runtime",
          ].includes(kind)
            ? 1
            : 0,
        ),
    );
    await rows("ledger and unchanged revisions " + kind);
  }
  await clean();
  await ok("schedule fractional timestamp", "note", {
    key: "fraction",
    kind: "timeout",
    now: 60000.5,
  });
  await ok(
    "fractional dueAt not yet elapsed",
    "claim",
    { now: 65000.49 },
    (v) => assert.equal(v, null),
  );
  let claims = await ok(
    "claim at exact fractional dueAt",
    "claim",
    { now: 65000.5 },
    (v) => {
      assert.equal(typeof v.id, "string");
      assert.equal(v.rowVersion, 1);
    },
  );
  await ok("active claim cannot be spent twice", "claim", { now: 65001 }, (v) =>
    assert.equal(v, null),
  );
  await reopen("active retry claim survives process restart");
  await ok("reopened claim stays exclusive", "claim", { now: 65001 }, (v) =>
    assert.equal(v, null),
  );
  await ok("wrong claim cannot finish", "finish", { claim: "wrong" }, (v) =>
    assert.equal(v, false),
  );
  await ok(
    "successful retry finishes ledger only",
    "finish",
    (i) => ({ claim: claims[i].id }),
    (v) => assert.equal(v, true),
  );
  await rows("successful retry retains encrypted revision");
  await ok("idle ledger not a candidate", "list", { now: 9999999 }, (v) =>
    assert.deepEqual(v, []),
  );
  await clean();
  await put(
    record("retrying", {
      dueAt: null,
      claim: { id: "old", expiresAt: 60000 },
      attempts: [1, 2, 3],
    }),
  );
  claims = await ok(
    "expired claim is reclaimed at boundary",
    "claim",
    {},
    (v) => assert.ok(v.id),
  );
  await ok(
    "old claim cannot finish replacement",
    "finish",
    { claim: "old" },
    (v) => assert.equal(v, false),
  );
  await ok("deferred failure refunds latest attempt", "finish", (i) => ({
    claim: claims[i].id,
    failure: { kind: "capacity", defer: true },
  }));
  await rows("deferred attempt ledger");
  await reopen("deferred retry survives restart");
  await ok("deferred retry is due", "list", { now: 65000 }, (v) =>
    assert.equal(v.length, 1),
  );
  await clean();
  for (let n = 0; n < 5; n++) {
    await ok("schedule retry " + n, "note", {
      key: "failure-" + n,
      kind: "runtime",
      now: 60000 + n * 6000,
    });
    claims = await ok(
      "claim retry " + n,
      "claim",
      { now: 65000 + n * 6000 },
      (v) => assert.ok(v),
    );
    await ok("finish failed retry " + n, "finish", (i) => ({
      claim: claims[i].id,
      failure: { kind: "timeout" },
      now: 65001 + n * 6000,
    }));
  }
  await ok(
    "five attempts latch even after time passes",
    "claim",
    { now: 9999999 },
    (v) => assert.equal(v, null),
  );
  await rows("latched record preserves encrypted Task");
  await ok("reset latch", "reset", {}, (v) => assert.equal(v, true));
  await ok(
    "new failure after explicit reset schedules",
    "note",
    { key: "after-reset", kind: "runtime" },
    (v) => assert.equal(v, true),
  );
  for (const [name, extra] of [
    [
      "chat paused",
      ["UPDATE chats SET automation_paused=true WHERE id='task'"],
    ],
    [
      "project paused",
      [
        `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(stamp)} WHERE id='github'`,
      ],
    ],
    ["running", ["UPDATE chats SET status='running' WHERE id='task'"]],
    [
      "approval",
      ["UPDATE chats SET status='waiting-for-approval' WHERE id='task'"],
    ],
    [
      "pending input",
      [
        `INSERT INTO agent_interaction_requests(id,request_key,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,created_at,updated_at) VALUES('retry-input','retry-input',${literal(owner)},'github','task','alpha','thread','approval','pending',${literal(stamp)},${literal(stamp)})`,
      ],
    ],
  ]) {
    await clean(extra);
    await put(record());
    await ok(name + " blocks list", "list", { now: 65000 }, (v) =>
      assert.deepEqual(v, []),
    );
    await ok(name + " blocks claim", "claim", { now: 65000 }, (v) =>
      assert.equal(v, null),
    );
    await rows(name + " preserves retry");
  }
  for (const state of ["complete", "blocked", "review", "failed"]) {
    for (const status of ["scheduled", "latched", "manual", "idle"]) {
      await clean([
        `UPDATE tasks SET state=${literal(state)} WHERE chat_id='task'`,
      ]);
      await put(record(status));
      await ok(`${state}/${status} clear`, "clear", {}, (v) =>
        assert.equal(v, true),
      );
      await rows(`${state}/${status} cleared ledger`);
    }
  }
  for (const state of ["complete", "blocked"]) {
    await clean([
      `UPDATE tasks SET state=${literal(state)} WHERE chat_id='task'`,
    ]);
    await put(record());
    await ok(
      state + " consumes pending claim as idle",
      "claim",
      { now: 65000 },
      (v) => assert.equal(v, null),
    );
    await rows(state + " idle record");
  }
  await clean(["UPDATE tasks SET state='complete' WHERE chat_id='task'"]);
  await put(record());
  await ok(
    "complete failure clears retry and returns false",
    "note",
    { key: "final", kind: "runtime" },
    (v) => assert.equal(v, false),
  );
  await rows("completed Task retry removed");
  await clean();
  await put(record("scheduled", { dueAt: 60000, attempts: [0, 0, 0, 0, 0] }));
  await ok("window lower boundary is excluded", "claim", {}, (v) =>
    assert.ok(v),
  );
  await rows("window boundary attempt count");
  await clean();
  await put(record("scheduled", { dueAt: 60000, attempts: [0.1, 1, 2, 3, 4] }));
  await ok("five attempts inside window latch", "claim", {}, (v) =>
    assert.equal(v, null),
  );
  await rows("exact window latch");
  await clean([
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id='task'`,
  ]);
  await ok("archived Task excluded", "list", {}, (v) =>
    assert.deepEqual(v, []),
  );
  await ok("archived Task cannot mutate", "reset", {}, (v) =>
    assert.equal(v, null),
  );
  await clean();
  await reopen("retry ledger persists independently of encrypted data");
  await rows("final persisted ledger");
  // Assert separately so broad parity cannot hide both implementations advancing
  // encrypted revisions or timestamps while changing operational accounting.
  for (const value of await rows(
    "encrypted content and revisions stay unchanged",
  )) {
    const row = Array.isArray(value) ? value[0] : value;
    // query-json unwraps its single result row in this harness.
    const v = row.result ?? row;
    assert.equal(v.rowVersion, 1);
    assert.equal(v.schedulerRevision, 1);
    assert.deepEqual(v.protectedContent, taskEnvelope);
    assert.equal(Date.parse(v.updatedAt), Date.parse(stamp));
  }
  if (h.databaseMode === "postgres") {
    await runTaskRetryRaces(h, clean);
    await runTaskRetryAdoptionRaces(h, clean);
  }
  await runTaskFailureSettlementCases(h, clean);
}
