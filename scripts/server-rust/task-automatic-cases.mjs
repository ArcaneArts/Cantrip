import assert from "node:assert/strict";
import {
  literal,
  json,
  stamp,
  label,
  otherOwner,
} from "./project-target-state.mjs";
import { taskEnvelope, taskContent } from "./task-wire-fixtures.mjs";
const ledger = {
  status: "scheduled",
  failureKind: "runtime",
  failureKey: "seed",
  dueAt: 60000,
  attempts: [],
  claim: null,
};
const error = {
  code: "task-timeout",
  operationKind: "direct",
  occurredAt: stamp,
};
const sqlSnapshot =
  "SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY chat_id,fifo_created_at,id) FROM task_dispatch_cycles c),'chats',(SELECT jsonb_agg(jsonb_build_object('id',id,'owner',owner_id,'paused',automation_paused,'status',status,'updatedAt',updated_at) ORDER BY id) FROM chats WHERE experience='task')) result";
export async function runTaskAutomaticCases(h) {
  const { observe, seed, owner, reset, reopen, registerFixedClock } = h;
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('automatic-provider',${literal(owner)},'Automatic retry','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('automatic-model',${literal(owner)},'Automatic retry') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('automatic-route','automatic-model','automatic-provider','automatic',0) ON CONFLICT DO NOTHING",
  ]);
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM chat_messages",
      "DELETE FROM chats WHERE id LIKE 'auto-%'",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL",
      "UPDATE chats SET experience='task',status='failed',automation_paused=false,model_id='automatic-model' WHERE id='task'",
      "UPDATE user_settings SET auto_name_tasks=false",
      `INSERT INTO tasks(chat_id,state,stable_state_before_failure,last_error,protected_content,automatic_retry,created_at,updated_at) VALUES('task','failed','draft',${json(error)},${json(taskEnvelope)},${json(ledger)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const bound =
    "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('78787878-7878-4787-8787-000000000001','task','alpha','github-alpha-main','observed-thread','automatic-route','ready')";
  const reply = (status = "idle") => ({
    goal: null,
    task: taskContent("failed", 0, {
      stableStateBeforeFailure: "draft",
      lastError: error,
    }),
    message: null,
    execution: { threadId: "<goal-thread>", status },
  });
  const snapshot = async (name) =>
    observe(
      name,
      { sql: sqlSnapshot, automaticSnapshot: true },
      { op: "query-json", shape: "raw" },
    );
  const run = async (name, fields = {}) => {
    const values = await observe(
      name,
      {
        chat: "task",
        action: "automatic",
        retryClock: 60000,
        goalReply: reply(),
        ...fields,
        steps: [
          ...(fields.steps ?? [{ kind: "tick" }, { kind: "drain" }]),
          { kind: "snapshot", sql: sqlSnapshot },
        ],
      },
      { op: "native-command-task-automatic", shape: "raw" },
    );
    for (const v of values)
      assert.equal(v.error, undefined, name + JSON.stringify(v.error));
    return values;
  };
  const final = (v) => v.result.snapshots.at(-1);
  const queued = (v, count = 1) => {
    assert.equal(final(v).cycles?.length, count);
    for (const c of final(v).cycles) assert.equal(c.state, "queued");
  };
  await clean();
  for (const v of await run(
    "unbound automatic retry durably admits with its actual claim",
  )) {
    queued(v);
    assert.equal(v.commands.length, 0);
    assert.equal(v.logs.length, 0);
    assert.equal(v.trace.filter((t) => t.kind === "tick").length, 1);
    const row = final(v).tasks[0];
    assert.equal(row.automatic_retry.status, "idle");
    assert.deepEqual(row.automatic_retry.attempts, [60000]);
    assert.equal(row.automatic_retry.claim, null);
    assert.equal(v.events.length, 6);
    assert.equal(final(v).cycles[0].operation_kind, "direct");
  }
  let before = await snapshot("automatic admission rows before restart");
  await reopen("automatic retry admitted state reopen");
  assert.deepEqual(
    await snapshot("automatic admission rows after restart"),
    before,
  );
  for (const status of ["idle", "failed"]) {
    await clean([bound]);
    for (const v of await run(
      "bound automatic retry observes previous " + status + " execution",
      { goalReply: reply(status) },
    )) {
      queued(v);
      assert.equal(v.commands.length, 1);
      assert.equal(v.commands[0].command.type, "chat.goal.get");
      assert.equal(v.commands[0].command.observeExecution, true);
      assert.equal(v.commands[0].command.threadId, "observed-thread");
      assert.equal(
        final(v).tasks[0].row_version,
        1,
        "observation cannot rewrite encrypted Task metadata",
      );
    }
  }
  await clean([bound]);
  for (const v of await run(
    "running previous native turn defers without spending an attempt",
    { goalReply: reply("running") },
  )) {
    assert.equal(final(v).cycles, null);
    const r = final(v).tasks[0].automatic_retry;
    assert.equal(r.status, "scheduled");
    assert.deepEqual(r.attempts, []);
    assert.equal(r.dueAt, 65000);
    assert.equal(
      v.logs.at(-1).errorMessage,
      "Waiting for the previous native Task turn to stop before retrying.",
    );
  }
  before = await snapshot("deferred retry exact rows before restart");
  await reopen("deferred automatic retry reopen");
  assert.deepEqual(
    await snapshot("deferred retry exact rows after restart"),
    before,
  );
  await clean([bound]);
  for (const v of await run(
    "wrong observed thread is rejected by actual encrypted Goal validation",
    {
      goalReply: {
        ...reply(),
        execution: { threadId: "wrong-thread", status: "idle" },
      },
    },
  )) {
    assert.equal(final(v).cycles, null);
    assert.equal(v.logs.length, 2);
    assert.equal(v.logs[0].message, "Provider routes resolved");
    assert.equal(
      v.logs.at(-1).errorMessage,
      "Encrypted Goal metadata is invalid.",
    );
    assert.deepEqual(final(v).tasks[0].automatic_retry.attempts, [60000]);
  }
  await clean([bound]);
  for (const v of await run(
    "worker observation failure finishes and schedules the claim",
    { failCommand: "chat.goal.get" },
  )) {
    assert.equal(final(v).cycles, null);
    assert.equal(final(v).tasks[0].automatic_retry.status, "scheduled");
    assert.deepEqual(final(v).tasks[0].automatic_retry.attempts, [60000]);
    assert.equal(
      v.logs.at(-1).errorMessage,
      "Controlled recovery worker failure",
    );
  }
  await clean(["UPDATE tasks SET automatic_retry=NULL"]);
  for (const v of await run(
    "pre-upgrade failure adopted once before its due time",
    {
      steps: [
        { kind: "tick" },
        { kind: "drain" },
        { kind: "tick" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(final(v).cycles, null);
    assert.equal(v.events.length, 2);
    assert.equal(final(v).tasks[0].automatic_retry.dueAt, 65000);
    assert.deepEqual(final(v).tasks[0].automatic_retry.attempts, []);
  }
  for (const v of await run("adopted legacy failure retries when due", {
    retryClock: 65000,
  })) {
    queued(v);
    assert.deepEqual(final(v).tasks[0].automatic_retry.attempts, [65000]);
  }
  await clean([
    `UPDATE tasks SET automatic_retry=NULL,last_error=${json({ ...error, code: "task-needs-input" })}`,
  ]);
  for (const v of await run("human failure requires input without queueing")) {
    assert.equal(final(v).cycles, null);
    assert.equal(final(v).tasks[0].automatic_retry.status, "manual");
  }
  for (const [name, sql] of [
    ["paused chat", "UPDATE chats SET automation_paused=true WHERE id='task'"],
    [
      "paused project",
      `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(stamp)} WHERE id='github'`,
    ],
    ["running chat", "UPDATE chats SET status='running' WHERE id='task'"],
    [
      "waiting chat",
      "UPDATE chats SET status='waiting-for-approval' WHERE id='task'",
    ],
    [
      "pending approval",
      `INSERT INTO agent_interaction_requests(id,request_key,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,created_at,updated_at) VALUES('automatic-input','automatic-input',${literal(owner)},'github','task','alpha','thread','approval','pending',${literal(stamp)},${literal(stamp)})`,
    ],
  ]) {
    await clean([sql]);
    for (const v of await run(name + " is filtered by actual candidate SQL")) {
      assert.equal(final(v).cycles, null);
      assert.equal(v.events.length, 0);
      assert.deepEqual(final(v).tasks[0].automatic_retry, ledger);
    }
  }
  // A real PostgreSQL trigger corrupts only the post-claim projection. The actor
  // must still finish the persisted claim through the Source inner catch.
  await clean();
  await seed([
    "CREATE FUNCTION automatic_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.automatic_retry->>'status'='retrying' AND OLD.automatic_retry->>'status'='scheduled' THEN NEW.protected_content='null'::jsonb; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER automatic_projection_fault BEFORE UPDATE OF automatic_retry ON tasks FOR EACH ROW EXECUTE FUNCTION automatic_projection_fault()",
  ]);
  try {
    for (const v of await run(
      "projection failure after claim still releases durable retry ownership",
    )) {
      assert.equal(final(v).cycles, null);
      assert.equal(v.logs.length, 1);
      assert.equal(final(v).tasks[0].automatic_retry.status, "scheduled");
      assert.equal(final(v).tasks[0].automatic_retry.claim, null);
      assert.deepEqual(final(v).tasks[0].automatic_retry.attempts, [60000]);
    }
  } finally {
    await seed([
      "DROP TRIGGER automatic_projection_fault ON tasks",
      "DROP FUNCTION automatic_projection_fault()",
    ]);
  }
  await clean();
  await seed([
    "CREATE FUNCTION automatic_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.automatic_retry->>'status'='retrying' AND OLD.automatic_retry->>'status'='scheduled' THEN NEW.row_version=OLD.row_version+1; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER automatic_revision_change BEFORE UPDATE OF automatic_retry ON tasks FOR EACH ROW EXECUTE FUNCTION automatic_revision_change()",
  ]);
  try {
    for (const v of await run(
      "revision changed by a real post-claim write finishes without a final publication",
    )) {
      assert.equal(final(v).cycles, null);
      assert.equal(v.commands.length, 0);
      assert.equal(v.logs.length, 0);
      assert.equal(final(v).tasks[0].row_version, 2);
      assert.equal(final(v).tasks[0].automatic_retry.status, "idle");
      assert.equal(v.events.length, 2);
    }
  } finally {
    await seed([
      "DROP TRIGGER automatic_revision_change ON tasks",
      "DROP FUNCTION automatic_revision_change()",
    ]);
  }
  await clean([
    `INSERT INTO user_settings(user_id,auto_name_tasks) VALUES(${literal(otherOwner)},false) ON CONFLICT(user_id) DO UPDATE SET auto_name_tasks=false`,
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,status,protected_label,created_at,updated_at,last_used_at) VALUES('auto-foreign',${literal(otherOwner)},'other','foreign','other-foreign-main','task','failed',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO tasks(chat_id,state,stable_state_before_failure,last_error,protected_content,automatic_retry,created_at,updated_at) VALUES('auto-foreign','failed','draft',${json(error)},${json(taskEnvelope)},${json(ledger)},${literal(stamp)},${literal(stamp)})`,
  ]);
  for (const v of await run(
    "candidate owner scope is retained across concurrent tenant admission",
  )) {
    queued(v, 2);
    assert.equal(v.logs.length, 0);
    assert.equal(v.events.length, 12);
    for (const c of final(v).cycles)
      assert.equal(c.owner_id, c.chat_id === "task" ? owner : otherOwner);
    for (const e of v.events)
      assert.equal(
        e.ownerId,
        (
          e.scope.kind === "chat"
            ? e.scope.chatId === "task"
            : e.scope.projectId === "github"
        )
          ? owner
          : otherOwner,
      );
  }
  const implementationError = {
    code: "task-runtime",
    operationKind: "implementation",
    occurredAt: stamp,
  };
  const implementationContent = taskContent("failed", 1, {
    hasPlan: true,
    hasFinalPlan: true,
    hasGoalPrompt: true,
    lastError: implementationError,
  });
  await clean([
    bound,
    `UPDATE tasks SET plan_goal_enabled=true,planning_round=1,has_plan=true,has_final_plan=true,has_goal_prompt=true,stable_state_before_failure=NULL,implementation_started_at=${literal(stamp)},last_error=${json(implementationError)}`,
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,physical_worker_id,worktree_id,codex_thread_id,lease_owner,lease_expires_at,fencing_token) VALUES('79797979-7979-4797-8797-000000000001',${literal(owner)},'task','implementation-receipt','finalize','expired',${literal(stamp)},'alpha','github-alpha-main','observed-thread','old-server',${literal(stamp)},1)`,
  ]);
  for (const v of await run(
    "actual automatic implementation recovery preserves a user-paused Goal",
    {
      recoveryClock: 60000,
      goalReply: {
        goal: {
          chatId: "task",
          threadId: "<goal-thread>",
          status: "paused",
          protectedObjective: taskEnvelope,
          tokenBudget: null,
          tokensUsed: 1,
          timeUsedSeconds: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        task: implementationContent,
        message: null,
        execution: { threadId: "<goal-thread>", status: "idle" },
      },
    },
  )) {
    assert.equal(v.logs.length, 1);
    assert.equal(v.logs[0].message, "Provider routes resolved");
    assert.equal(v.commands.length, 1);
    assert.equal(v.commands[0].command.type, "chat.goal.get");
    assert.equal(
      v.trace.some(
        (t) => t.kind === "unpause" || t.kind === "begin" || t.kind === "tick",
      ),
      false,
    );
    assert.equal(final(v).cycles.length, 1);
    assert.equal(final(v).cycles[0].operation_id, "implementation-receipt");
    assert.equal(final(v).cycles[0].state, "expired");
    assert.equal(final(v).tasks[0].automatic_retry.status, "idle");
  }
  async function five() {
    await clean([bound]);
    const statements = [];
    for (let n = 1; n <= 4; n++) {
      const at = new Date(Date.parse(stamp) + n).toISOString();
      registerFixedClock(Date.parse(at));
      statements.push(
        `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,status,protected_label,created_at,updated_at,last_used_at) VALUES('auto-${n}',${literal(owner)},'github','alpha','github-alpha-main','task','failed',${json(label("chat"))},${literal(at)},${literal(at)},${literal(at)})`,
        `INSERT INTO tasks(chat_id,state,stable_state_before_failure,last_error,protected_content,automatic_retry,created_at,updated_at) VALUES('auto-${n}','failed','draft',${json(error)},${json(taskEnvelope)},${json(ledger)},${literal(at)},${literal(at)})`,
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,status) VALUES('78787878-7878-4787-8787-00000000000${n + 1}','auto-${n}','alpha','github-alpha-main','observed-${n}','ready')`,
      );
    }
    statements.push(
      "UPDATE chats SET model_id='automatic-model' WHERE id LIKE 'auto-%'",
    );
    await seed(statements);
  }
  await five();
  for (const v of await run(
    "overlapping ticks bound four chats and stop drains admitted work",
    {
      holdGoal: true,
      steps: [
        { kind: "tick" },
        { kind: "wait-commands", count: 4 },
        { kind: "ticks", count: 3 },
        { kind: "snapshot", sql: sqlSnapshot },
        { kind: "stop" },
        { kind: "release" },
        { kind: "drain" },
        { kind: "tick" },
      ],
    },
  )) {
    assert.equal(v.commands.length, 4);
    assert.equal(new Set(v.commands.map((c) => c.command.chatId)).size, 4);
    const held = v.result.snapshots[0].tasks;
    assert.equal(
      held.filter((t) => t.automatic_retry.status === "retrying").length,
      4,
    );
    assert.equal(
      held.filter((t) => t.automatic_retry.status === "scheduled").length,
      1,
    );
    queued(v, 4);
  }
  await five();
  for (const v of await run(
    "slow first worker observation cannot stall other retry candidates",
    {
      holdGoalChats: ["task"],
      steps: [
        { kind: "tick" },
        { kind: "wait-commands", count: 4 },
        {
          kind: "wait-sql",
          sql: "SELECT count(*)::int result FROM tasks WHERE automatic_retry->>'status'='idle'",
          value: 3,
        },
        { kind: "tick" },
        { kind: "wait-commands", count: 5 },
        { kind: "stop" },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.commands.length, 5);
    assert.equal(new Set(v.commands.map((c) => c.command.chatId)).size, 5);
    queued(v, 5);
  }
  before = await snapshot(
    "concurrent automatic retries exact rows before restart",
  );
  await reopen("concurrent automatic retry reopen");
  assert.deepEqual(
    await snapshot("concurrent automatic retries exact rows after restart"),
    before,
  );
  await clean();
  for (const v of await run("stopped actor cannot adopt or admit", {
    steps: [{ kind: "stop" }, { kind: "ticks", count: 2 }, { kind: "drain" }],
  })) {
    assert.equal(v.events.length, 0);
    assert.equal(final(v).cycles, null);
    assert.deepEqual(final(v).tasks[0].automatic_retry, ledger);
  }
}
