import assert from "node:assert/strict";
import {
  literal,
  json,
  stamp,
  label,
  otherOwner,
} from "./project-target-state.mjs";
import { taskEnvelope, taskStart, taskResult } from "./task-wire-fixtures.mjs";
import { runAutomaticTitleCases } from "./automatic-title-cases.mjs";
export async function runTaskQueueCases(h) {
  const { observe, seed, owner, reset, reopen } = h,
    chat = "task";
  const fixedCycle = "75757575-7575-4757-8757-000000000001";
  const labelResult = { titleProtection: label("chat"), emptyInput: false };
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('bootstrap-provider',${literal(owner)},'Queue labels','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('bootstrap-model',${literal(owner)},'Queue labels') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('bootstrap-route','bootstrap-model','bootstrap-provider','root',0) ON CONFLICT DO NOTHING",
  ]);
  await runAutomaticTitleCases(h);
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM chat_messages",
      "UPDATE chats SET experience='task',model_id='bootstrap-model',status='idle',automation_paused=false,auto_title_pending=true,auto_title_claim=NULL WHERE id='task'",
      "UPDATE user_settings SET auto_name_tasks=true,auto_name_chats=true,random_agent_names=false,labeling_model_id=NULL,default_model_id='bootstrap-model'",
      `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const title = (name, fields = {}) =>
    observe(
      name,
      { action: "generate", chat, task: true, labelResult, ...fields },
      { op: "native-command-automatic-title", shape: "raw" },
    );
  const queue = (name, fields = {}, options = {}) =>
    observe(
      name,
      {
        chat,
        action: "queue",
        kind: "direct",
        input: { operationId: "queued-operation", rowVersion: 1 },
        labelResult,
        ...fields,
      },
      { op: "native-command-task-queue", shape: "raw", ...options },
    );
  const snapshot = (name) =>
    observe(
      name,
      {
        taskQueueSnapshot: true,
        sql: "SELECT jsonb_build_object('chat',(SELECT jsonb_build_object('protectedLabel',protected_label,'pending',auto_title_pending,'claimed',auto_title_claim IS NOT NULL,'updatedAt',updated_at) FROM chats WHERE id='task'),'task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id='task'),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  const noTitle = (values) => {
    for (const v of values) {
      assert.equal(v.commands.length, 0);
      assert.equal(v.events.length, 0);
    }
  };
  await clean();
  for (const v of await title("Task naming uses the actual protected brief")) {
    assert.equal(v.commands.length, 1);
    const c = v.commands[0];
    assert.equal(c.command.type, "label.generate");
    assert.equal(c.command.labelKind, "task");
    assert.equal(c.command.input.kind, "task");
    assert.deepEqual(c.command.input.task.protectedContent, taskEnvelope);
    assert.equal(c.timeoutMs, 30000);
    assert.equal(v.events.length, 1);
  }
  let rows = await snapshot("Task title persisted and claim released");
  for (const r of rows) {
    assert.equal(r.chat.claimed, false);
    assert.deepEqual(r.chat.protectedLabel, labelResult.titleProtection);
  }
  noTitle(await title("Task title claim consumed once"));
  await clean([
    "UPDATE user_settings SET auto_name_chats=false,random_agent_names=true",
  ]);
  for (const v of await title(
    "Task naming ignores message and random-agent settings",
  ))
    assert.equal(v.commands.length, 1);
  await clean(["UPDATE user_settings SET auto_name_tasks=false"]);
  noTitle(await title("Task-specific naming preference disabled"));
  await clean();
  noTitle(await title("Task title owner isolation", { owner: otherOwner }));
  await clean(["UPDATE chats SET auto_title_pending=false WHERE id='task'"]);
  noTitle(await title("nonpending Task is not renamed"));
  await clean([
    "UPDATE chats SET auto_title_claim='foreign-claim' WHERE id='task'",
  ]);
  noTitle(await title("active Task title claim cannot be stolen"));
  await clean();
  for (const v of await title("empty Task brief reopens naming", {
    labelResult: { titleProtection: null, emptyInput: true },
  }))
    assert.equal(v.commands.length, 1);
  rows = await snapshot("empty Task brief retains pending state");
  for (const r of rows) {
    assert.equal(r.chat.pending, true);
    assert.equal(r.chat.claimed, false);
  }
  const dispatch = `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at) VALUES('${fixedCycle}',${literal(owner)},'task','submitted-during-label','direct','queued',${literal(stamp)})`;
  await clean();
  for (const v of await title(
    "empty creation label reconciles a newer submitted Task",
    {
      labelResults: [{ titleProtection: null, emptyInput: true }, labelResult],
      labelBeforeReplySQL: [["UPDATE tasks SET row_version=2", dispatch]],
    },
  )) {
    assert.equal(v.commands.length, 2);
    assert.equal(v.commands[1].command.input.task.rowVersion, 2);
    assert.equal(v.events.length, 1);
  }
  rows = await snapshot("reconciled protected Task label durable");
  await reopen("Task title reopen");
  assert.deepEqual(
    await snapshot("Task title and dispatch rows after reopen"),
    rows,
  );
  await clean();
  for (const v of await title(
    "autosaved draft without a dispatch is not reconciled",
    {
      labelResult: { titleProtection: null, emptyInput: true },
      beforeReplySQL: "UPDATE tasks SET row_version=row_version+1",
    },
  ))
    assert.equal(v.commands.length, 1);
  await clean();
  for (const v of await title("empty Task reconciliation runs only once", {
    labelResult: { titleProtection: null, emptyInput: true },
    labelBeforeReplySQL: [
      ["UPDATE tasks SET row_version=2", dispatch],
      "UPDATE tasks SET row_version=3",
    ],
  }))
    assert.equal(v.commands.length, 2);
  await clean();
  for (const v of await title(
    "Task preference changed before reply prevents publication",
    { beforeReplySQL: "UPDATE user_settings SET auto_name_tasks=false" },
  )) {
    assert.equal(v.commands.length, 1);
    assert.equal(v.events.length, 0);
  }
  await clean();
  for (const v of await title(
    "Task title worker error keeps private content out of logs",
    { failRequest: true },
  )) {
    assert.equal(v.events.length, 0);
    assert.ok(v.logs.some((l) => l.message === "Automatic title unavailable"));
    assert.ok(
      !JSON.stringify(v.logs).includes("private-provider-error-marker"),
    );
  }
  rows = await snapshot("failed Task title releases its actual claim");
  for (const r of rows) assert.equal(r.chat.claimed, false);
  await clean();
  for (const v of await title("invalid worker label result is ignored", {
    labelResult: { titleProtection: "plaintext-must-not-log" },
  })) {
    assert.equal(v.events.length, 0);
    assert.ok(!JSON.stringify(v.logs).includes("plaintext-must-not-log"));
  }
  const retryRecord = {
    status: "scheduled",
    failureKind: "runtime",
    failureKey: "previous",
    dueAt: 60000,
    attempts: [1],
    claim: null,
  };
  await clean([`UPDATE tasks SET automatic_retry=${json(retryRecord)}`]);
  for (const v of await queue(
    "manual queue resets retry ledger, invalidates and names",
  )) {
    assert.equal(v.value.dispatch.state, "queued");
    assert.equal(v.value.automaticRetry, null);
    assert.equal(v.ticks, 1);
    assert.equal(v.commands.length, 1);
    assert.equal(v.commands[0].command.input.kind, "task");
  }
  rows = await snapshot("queued Task and protected title persisted");
  await reopen("Task queue reopen");
  assert.deepEqual(await snapshot("queued Task rows after reopen"), rows);
  for (const v of await queue(
    "replayed queued operation still publishes but does not rename",
  )) {
    assert.equal(v.ticks, 1);
    assert.equal(v.commands.length, 0);
    assert.equal(v.value.dispatch.operationId, "queued-operation");
  }
  await clean([`UPDATE tasks SET automatic_retry=${json(retryRecord)}`]);
  for (const v of await queue("automatic queue preserves retry ledger", {
    automatic: true,
  })) {
    assert.equal(v.value.automaticRetry.status, "scheduled");
    assert.equal(v.value.automaticRetry.failureKind, "runtime");
    assert.equal(v.value.automaticRetry.recentAttempts, 0);
    assert.equal(v.ticks, 1);
  }
  for (const row of await snapshot(
    "automatic admission preserves the complete retry ledger",
  ))
    assert.deepEqual(row.task.automatic_retry, retryRecord);
  await clean([`UPDATE tasks SET automatic_retry=${json(retryRecord)}`]);
  await seed(
    "ALTER TABLE tasks ADD CONSTRAINT task_queue_reset_failure CHECK (automatic_retry IS NOT NULL)",
  );
  await queue(
    "retry-ledger reset fails after the actual queue commit",
    {},
    { error: true, sqlstate: "23514" },
  );
  for (const row of await snapshot(
    "post-admission reset failure retains committed cycle and old ledger",
  )) {
    assert.equal(row.cycles.length, 1);
    assert.equal(row.cycles[0].state, "queued");
    assert.deepEqual(row.task.automatic_retry, retryRecord);
    assert.equal(row.chat.claimed, false);
  }
  await seed("ALTER TABLE tasks DROP CONSTRAINT task_queue_reset_failure");
  await clean();
  for (const v of await queue(
    "Task title failure cannot fail an admitted operation",
    { failRequest: true },
  )) {
    assert.equal(v.value.dispatch.state, "queued");
    assert.equal(v.ticks, 1);
    assert.ok(v.logs.some((l) => l.message === "Automatic title unavailable"));
  }
  for (const kind of ["initial-plan", "continue-plan", "finalize"]) {
    await clean([
      `UPDATE tasks SET plan_goal_enabled=true,state='${kind === "initial-plan" ? "draft" : "review"}',has_plan=${kind !== "initial-plan"},has_final_plan=${kind === "finalize"},has_goal_prompt=${kind === "finalize"}`,
    ]);
    for (const v of await queue("queue " + kind, { kind })) {
      assert.equal(v.value.dispatch.operationKind, kind);
      assert.equal(v.ticks, 1);
      assert.equal(v.commands.length, kind === "initial-plan" ? 1 : 0);
    }
  }
  await clean();
  await queue(
    "foreign queue cannot admit",
    { owner: otherOwner },
    { error: true },
  );
  await queue(
    "stale version cannot admit",
    { input: { operationId: "stale", rowVersion: 2 } },
    { error: true },
  );
  await snapshot("rejected queue leaves Task unchanged");
  await clean([
    `UPDATE tasks SET state='failed',stable_state_before_failure='draft',last_error=${json({ code: "task-timeout", operationKind: "direct", occurredAt: stamp })}`,
  ]);
  for (const v of await queue(
    "retry uses failure kind and requested attempt receipt",
    { action: "retry", operationId: "retry-attempt" },
  )) {
    assert.equal(v.value.dispatch.operationId, "retry-attempt");
    assert.equal(v.ticks, 1);
  }
  for (const kind of [null, "implementation"]) {
    await clean(
      kind
        ? [
            `UPDATE tasks SET state='failed',stable_state_before_failure='draft',last_error=${json({ code: "task-runtime", operationKind: kind, occurredAt: stamp })}`,
          ]
        : [],
    );
    await queue(
      "retry refuses implementation controls " + kind,
      { action: "retry", operationId: "forbidden" },
      { error: true },
    );
  }
  await clean([
    `UPDATE tasks SET state='failed'`,
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at) VALUES('${fixedCycle}',${literal(owner)},'task','old-goal','goal-continuation','failed',${literal(stamp)})`,
  ]);
  await queue(
    "retry refuses Goal continuation controls",
    { action: "retry", operationId: "forbidden" },
    { error: true },
  );
  const saved = "75757575-7575-4757-8757-000000000011";
  const start = taskStart("finalize", chat, 2, 1, saved),
    relay = taskResult(start);
  async function finalizeFailure(withSavedGoal) {
    await clean([
      "UPDATE tasks SET state='review',plan_goal_enabled=true,planning_round=1,has_plan=true,has_final_plan=false,has_goal_prompt=false",
    ]);
    const steps = [
      ["begin", { input: start }],
      ...(withSavedGoal
        ? [["complete", { operation: saved, input: relay }]]
        : []),
      [
        "fail",
        {
          operation: saved,
          ...(withSavedGoal ? { failure: relay.goal.failureTask } : {}),
        },
      ],
    ];
    for (const [action, fields] of steps) {
      for (const v of await observe(
        "persist real finalization receipt " + withSavedGoal + " " + action,
        { chat, action, ...fields },
        { op: "native-command-task", shape: "raw" },
      ))
        assert.ok(v.value);
    }
  }
  await finalizeFailure(true);
  for (const v of await queue(
    "retry reuses saved approved finalization Goal receipt",
    { action: "retry", operationId: "replacement-must-not-be-used" },
  )) {
    assert.equal(v.value.dispatch.operationId, saved);
    assert.equal(v.value.dispatch.operationKind, "finalize");
    assert.equal(v.commands.length, 0);
    assert.equal(v.ticks, 1);
  }
  await finalizeFailure(false);
  for (const v of await queue(
    "retry without saved Goal uses a fresh finalization attempt",
    { action: "retry", operationId: "new-finalizer" },
  ))
    assert.equal(v.value.dispatch.operationId, "new-finalizer");
  await clean([
    `UPDATE tasks SET state='failed',stable_state_before_failure='draft',last_error=${json({ code: "task-timeout", operationKind: "direct", occurredAt: stamp })}`,
  ]);
  for (const v of await queue("retry default attempt is a fresh UUID", {
    action: "retry",
  }))
    assert.match(v.value.dispatch.operationId, /^[a-f0-9]{8}-[a-f0-9-]{27}$/);
}
