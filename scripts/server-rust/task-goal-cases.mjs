import assert from "node:assert/strict";
import { literal, json, stamp } from "./project-target-state.mjs";
import {
  taskContent,
  taskEnvelope,
  taskMessage,
  taskStart,
  taskResult,
} from "./task-wire-fixtures.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export async function runTaskGoalCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const chat = "task";
  const content = () =>
    taskContent("implementing", 1, {
      hasPlan: true,
      hasFinalPlan: true,
      hasGoalPrompt: true,
    });
  const goal = () => ({
    chatId: chat,
    threadId: "goal-thread",
    status: "active",
    protectedObjective: structuredClone(taskEnvelope),
    tokenBudget: null,
    tokensUsed: 1,
    timeUsedSeconds: 2,
    createdAt: 1,
    updatedAt: 2,
  });
  const reply = () => ({ goal: goal(), task: content(), message: null });
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('goal-provider',${literal(owner)},'Goal provider','openai-compatible','http://localhost:8080') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('goal-model',${literal(owner)},'Goal model') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('goal-route','goal-model','goal-provider','goal-model',0,true) ON CONFLICT DO NOTHING",
  ]);
  async function clean(bound = true, extra = []) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "DELETE FROM chat_messages",
      "DELETE FROM agent_interaction_requests",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET experience='task',status='idle',automation_paused=false,model_id='goal-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id='task'",
      `INSERT INTO tasks(chat_id,state,planning_round,has_plan,has_final_plan,has_goal_prompt,protected_content,created_at,updated_at) VALUES('task','implementing',1,true,true,true,${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      ...(bound
        ? [
            "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('77777777-7777-4777-8777-000000000301','task','alpha','github-alpha-main','goal-thread','goal-route',NULL,'ready')",
          ]
        : []),
      ...extra,
    ]);
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      { chat, action: "read", goalReply: reply(), ...fields },
      { op: "native-command-task-goal", shape: "raw" },
    );
  async function ok(name, fields = {}, check = () => {}) {
    const values = await run(name, fields);
    for (const value of values) {
      assert.equal(value.error, undefined, name + JSON.stringify(value.error));
      check(value);
    }
    return values;
  }
  async function bad(name, fields, message) {
    const values = await run(name, fields);
    for (const value of values) {
      assert.ok(value.error, name);
      if (message) assert.equal(value.error.message, message, name);
    }
    return values;
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        goalSnapshot: true,
        sql: "SELECT jsonb_build_object('task',to_jsonb(t),'cycles',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM task_dispatch_cycles d),'sessions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM chat_runtime_sessions r)) result FROM tasks t WHERE chat_id='task'",
      },
      { op: "query-json", shape: "raw" },
    );
  await clean(false);
  await ok("unbound Task has no inferred Goal", {}, (v) => {
    assert.equal(v.result.goal, null);
    assert.deepEqual(v.commands, []);
    assert.equal(v.result.task.rowVersion, 1);
  });
  await clean();
  await ok(
    "worker observes encrypted Task Goal and persists classification",
    {},
    (v) => {
      assert.equal(v.commands[0].command.type, "chat.goal.get");
      assert.equal(
        v.commands[0].command.taskContext.task.protectedContent.envelope
          .ciphertext,
        taskEnvelope.envelope.ciphertext,
      );
      assert.equal(v.result.task.rowVersion, 2);
      assert.equal(v.events[0].resource, "task");
    },
  );
  await snapshot("observed Goal state is durable");
  await reopen("observed Goal survives process reopen");
  await ok("observation after reopen uses saved Task revision", {}, (v) =>
    assert.equal(v.result.task.rowVersion, 3),
  );
  for (const fields of [
    { goalReply: { ...reply(), goal: null, task: taskContent("complete", 1) } },
    {
      goalReply: { ...reply(), task: taskContent("complete", 1) },
      observationOnly: true,
    },
  ]) {
    await clean();
    await ok(
      "missing or observation-only Goal does not infer completion",
      fields,
      (v) => {
        assert.equal(v.result.task.state, "implementing");
        assert.equal(v.result.task.rowVersion, 1);
        assert.deepEqual(v.events, []);
      },
    );
  }
  await clean();
  await ok(
    "explicit runtime failure may update absent Goal",
    {
      goalReply: {
        goal: null,
        task: taskContent("failed", 1, {
          hasPlan: true,
          hasFinalPlan: true,
          hasGoalPrompt: true,
          lastError: {
            code: "task-runtime",
            operationKind: "implementation",
            occurredAt: stamp,
          },
        }),
        message: null,
      },
      runtimeFailure: { kind: "runtime", occurredAt: stamp },
    },
    (v) => assert.equal(v.result.task.state, "failed"),
  );
  for (const [name, change] of [
    ["foreign Goal Chat", (r) => (r.goal.chatId = "other")],
    ["foreign Goal thread", (r) => (r.goal.threadId = "other")],
    [
      "foreign execution thread",
      (r) => (r.execution = { threadId: "other", status: "running" }),
    ],
  ]) {
    await clean();
    const value = reply();
    change(value);
    const before = await snapshot("before " + name);
    await bad(
      name,
      { goalReply: value },
      "Encrypted Goal metadata is invalid.",
    );
    assert.deepEqual(await snapshot("unchanged " + name), before);
  }
  const message = {
    id: "77777777-7777-4777-8777-000000000302",
    idempotencyKey: "control-key",
    kind: "resume",
  };
  for (const mismatch of ["id", "idempotencyKey"]) {
    await clean();
    const value = reply();
    value.message = taskMessage("user", "goal", message.id);
    value.message.idempotencyKey = message.idempotencyKey;
    value.message[mismatch] =
      mismatch === "id" ? "77777777-7777-4777-8777-000000000399" : "other";
    await bad(
      "Goal control " + mismatch + " must correlate",
      { message, goalReply: value },
      "Encrypted Goal metadata is invalid.",
    );
  }
  for (const [role, mode] of [
    ["system", "goal"],
    ["assistant", "goal"],
    ["user", "plan"],
  ]) {
    await clean();
    const value = reply();
    value.message = taskMessage(role, "goal", message.id);
    value.message.classification.mode = mode;
    await bad(`invalid control ${role}/${mode} preserves schema error`, {
      goalReply: value,
    });
  }
  await clean();
  await ok(
    "passive stale observation rereads latest Task",
    {
      goalBeforeReplySQL:
        "UPDATE tasks SET row_version=row_version+1 WHERE chat_id='task'",
    },
    (v) => assert.equal(v.result.task.rowVersion, 2),
  );
  for (const activate of [false, true]) {
    await clean();
    const value = reply();
    value.message = taskMessage("user", "goal", message.id);
    value.message.idempotencyKey = message.idempotencyKey;
    await bad("active controls cannot swallow stale revision " + activate, {
      message,
      activate,
      goalReply: value,
      goalBeforeReplySQL:
        "UPDATE tasks SET row_version=row_version+1 WHERE chat_id='task'",
    });
  }
  await clean();
  await ok(
    "activate sends native active Goal update",
    { activate: true },
    (v) => {
      assert.equal(v.commands[0].command.type, "chat.goal.update");
      assert.equal(v.commands[0].command.status, "active");
    },
  );
  await clean();
  await ok(
    "execution observation requests status without reconciling lease",
    { observeExecution: true },
    (v) => assert.equal(v.commands[0].command.observeExecution, true),
  );
  await clean();
  await ok(
    "empty Goal resume falls through to queued input only for ordinary Chat",
    {
      action: "resume",
      goalReply: { goal: null, task: content(), message: null },
    },
    (v) => {
      assert.deepEqual(
        v.trace.map((t) => t.kind),
        ["pending"],
      );
    },
  );
  for (const extra of [
    "UPDATE chats SET automation_paused=true WHERE id='task'",
    "UPDATE chats SET status='running' WHERE id='task'",
    "UPDATE chats SET status='waiting-for-approval' WHERE id='task'",
  ]) {
    await clean(true, [extra]);
    await ok(
      "resume is deferred by persisted state " + extra,
      { action: "resume" },
      (v) => {
        assert.deepEqual(v.trace, []);
        assert.deepEqual(v.commands, []);
      },
    );
  }
  await clean();
  await ok(
    "offline resume does not consume queued work",
    { action: "resume", connected: false },
    (v) => {
      assert.deepEqual(v.trace, []);
      assert.deepEqual(v.commands, []);
    },
  );
  await clean();
  await ok(
    "pending worktree transition owns resume",
    { action: "resume", pending: true },
    (v) => {
      assert.deepEqual(
        v.trace.map((t) => t.kind),
        ["pending"],
      );
      assert.deepEqual(v.commands, []);
    },
  );
  await clean();
  await ok(
    "resume rereads pause after pending transition",
    {
      action: "resume",
      pendingSql: "UPDATE chats SET automation_paused=true WHERE id='task'",
    },
    (v) => assert.deepEqual(v.commands, []),
  );
  await clean();
  let resumed = reply();
  resumed.message = taskMessage("user", "goal", "<goal-message-id>");
  resumed.message.idempotencyKey = "<goal-message-key>";
  await ok(
    "encrypted Task resume uses protected control and canonical worker prompt",
    { action: "resume", goalReply: resumed },
    (v) => {
      assert.equal(v.trace.at(-1).kind, "begin");
      assert.equal(
        v.trace.at(-1).input.text,
        "Resume the active encrypted Task Goal.",
      );
      assert.equal(
        v.trace.at(-1).options.encryptedTaskMessages.userMessage.classification
          .role,
        "user",
      );
    },
  );
  await clean(false);
  await ok("unbound resume dispatches queue", { action: "resume" }, (v) =>
    assert.deepEqual(
      v.trace.map((t) => t.kind),
      ["pending", "queue"],
    ),
  );
  for (const text of ["", undefined]) {
    await clean();
    await bad(
      "Goal start requires an objective " + String(text),
      { action: "start", turn: { text, idempotencyKey: "start-key" } },
      "Goal mode needs a text objective.",
    );
  }
  await clean(false);
  await ok(
    "ordinary Goal starts worker before actual turn boundary",
    {
      action: "start",
      turn: {
        text: "Objective \ud800",
        attachmentIds: [],
        idempotencyKey: "start-key",
      },
      goalReply: {
        goal: {
          threadId: "new-goal-thread",
          objective: "Objective \ud800",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    },
    (v) => {
      assert.equal(v.commands[0].command.objective, "Objective \ud800");
      assert.equal(v.trace[0].context.threadId, "new-goal-thread");
      assert.equal(v.trace[0].input.mode, "goal");
    },
  );
  await clean();
  await ok(
    "unfinished Task without implementation date is not a continuation",
    {
      action: "continue",
      turn: { text: "continue", idempotencyKey: "continue-key" },
    },
    (v) => assert.equal(v.result, false),
  );
  await clean(true, [
    `UPDATE tasks SET implementation_started_at=${literal(stamp)},plan_goal_enabled=true,state='complete' WHERE chat_id='task'`,
  ]);
  await ok(
    "complete Task continuation is already satisfied",
    {
      action: "continue",
      turn: { text: "continue", idempotencyKey: "continue-key" },
    },
    (v) => {
      assert.equal(v.result, true);
      assert.deepEqual(v.commands, []);
    },
  );
  await clean(true, [
    `UPDATE tasks SET implementation_started_at=${literal(stamp)},plan_goal_enabled=true WHERE chat_id='task'`,
    "UPDATE chats SET automation_paused=true WHERE id='task'",
  ]);
  await bad(
    "paused Task continuation stays paused",
    {
      action: "continue",
      turn: { text: "continue", idempotencyKey: "continue-key" },
    },
    "The Task is paused.",
  );
  await clean(true, [
    `UPDATE tasks SET implementation_started_at=${literal(stamp)},plan_goal_enabled=true WHERE chat_id='task'`,
  ]);
  await bad(
    "continuation requires saved dispatch",
    {
      action: "continue",
      turn: { text: "continue", idempotencyKey: "continue-key" },
    },
    "The Task implementation dispatch is unavailable.",
  );
  const ordinaryGoal = {
    threadId: "recovery-thread",
    objective: "Managed Goal objective",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  await clean(false, ["UPDATE chats SET experience='agent' WHERE id='task'"]);
  const protectedMessage = retainedPrompt().pendingMessage;
  await ok(
    "managed Agent Goal uses real console and encrypted input writer",
    {
      action: "start",
      turn: {
        text: "Managed Goal objective",
        attachmentIds: [],
        idempotencyKey: "managed-goal-key",
      },
      goalReply: { goal: ordinaryGoal },
      protectedMessage,
    },
    (v) => {
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        ["chat.thread.ensure", "chat.message.protect", "chat.goal.create"],
      );
      assert.deepEqual(v.trace, []);
      assert.equal(v.result.message.mode, "goal");
      assert.deepEqual(v.result.message.content, []);
    },
  );
  for (const resumed of [true, false, "invalid"]) {
    await clean(true, ["UPDATE chats SET experience='agent' WHERE id='task'"]);
    const fields = { action: "resume", goalReply: { resumed } };
    if (typeof resumed !== "boolean")
      await bad(
        "managed resume rejects malformed receipt",
        fields,
        "The native automation resume receipt is invalid.",
      );
    else
      await ok("managed native resume receipt " + resumed, fields, (v) => {
        assert.deepEqual(
          v.commands.map((c) => c.command.type),
          ["chat.automation.resume"],
        );
        assert.deepEqual(
          v.trace.map((t) => t.kind),
          resumed ? ["pending"] : ["pending", "queue"],
        );
      });
  }
  const operation = "77777777-7777-4777-8777-000000000311";
  async function finalized() {
    await clean(false, [
      "UPDATE tasks SET state='review',plan_goal_enabled=true WHERE chat_id='task'",
    ]);
    const start = taskStart("finalize", chat, 2, 1, operation),
      result = taskResult(start);
    for (const [action, fields] of [
      ["begin", { input: start }],
      ["complete", { input: result, operation, turn: "finalizer-turn" }],
    ]) {
      const values = await observe(
        "prepare actual encrypted finalized operation " + action,
        { chat, action, ...fields },
        { op: "native-command-task", shape: "raw" },
      );
      for (const value of values) assert.ok(value.value);
    }
    return result;
  }
  let relay = await finalized();
  await ok(
    "prepared encrypted Goal completes finalization before beginning its turn",
    {
      action: "launch",
      operation,
      goalReply: { ...reply(), task: relay.task },
    },
    (v) => {
      assert.equal(v.result.state, "implementing");
      assert.equal(v.result.rowVersion, 3);
      assert.equal(
        v.trace[0].input.text,
        "Begin the active encrypted Task Goal.",
      );
      assert.equal(v.trace[0].input.idempotencyKey, `task-goal:${operation}`);
      assert.deepEqual(v.commands[0].command.objective, relay.goal);
      assert.deepEqual(
        v.trace[0].options.encryptedTaskMessages.userMessage,
        relay.goal.startMessage,
      );
    },
  );
  await snapshot("launched encrypted Goal keeps saved finalizer result");
  await reopen("launched Goal implementation persists after restart");
  relay = await finalized();
  const startMessage = {
    ...relay.goal.startMessage,
    idempotencyKey: `task-goal:${operation}`,
  };
  await observe(
    "persist actual Goal start message before launch recovery",
    { chat, action: "write", kind: "task", message: startMessage },
    { op: "native-command-turn-live", shape: "raw" },
  );
  await ok(
    "saved Goal start message prevents a duplicate worker Goal and turn",
    {
      action: "launch",
      operation,
      goalReply: { ...reply(), task: relay.task },
    },
    (v) => {
      assert.deepEqual(v.commands, []);
      assert.deepEqual(v.trace, []);
      assert.equal(v.result.state, "implementing");
    },
  );
  relay = await finalized();
  await bad(
    "native encrypted startup failure preserves typed failure classification",
    {
      action: "launch",
      operation,
      goalReply: { goal: null, task: relay.goal.failureTask, message: null },
    },
    "task-goal-start-failed",
  );
  await snapshot("failed worker startup retains finalized operation for retry");
  relay = await finalized();
  await bad(
    "worker cannot attach encrypted Goal to another Task",
    {
      action: "launch",
      operation,
      goalReply: {
        ...reply(),
        task: relay.task,
        goal: { ...goal(), chatId: "another-task" },
      },
    },
    "The encrypted Goal belongs to another Task.",
  );
  await clean();
  await bad(
    "launch requires actual finalized encrypted objective",
    { action: "launch", operation },
    "The finalized Task objective is not available.",
  );
  await clean(false, [
    `UPDATE chats SET experience='agent',model_id='goal-model' WHERE id=${literal(h.standalone)}`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('77777777-7777-4777-8777-000000000319',${literal(h.standalone)},'alpha',${literal(h.scratch)},'standalone-goal-thread','goal-route',NULL,'ready')`,
  ]);
  await ok(
    "ordinary resumed Goal preserves numeric timestamp and UTF16 objective",
    {
      chat: h.standalone,
      action: "resume",
      goalReply: {
        goal: {
          ...ordinaryGoal,
          threadId: "standalone-goal-thread",
          objective: "Objective \ud800",
        },
      },
    },
    (v) => {
      const begin = v.trace.at(-1);
      assert.equal(begin.kind, "begin");
      assert.equal(begin.input.text, "Resume goal: Objective \ud800");
      assert.ok(begin.input.idempotencyKey.startsWith("chat-resume:2:"));
    },
  );
  const cycle = "77777777-7777-4777-8777-000000000321";
  async function leased(state = "running", kind = "finalize") {
    await clean(true, [
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,lease_owner,lease_expires_at,fencing_token,started_at,created_at,updated_at) VALUES('${cycle}',${literal(owner)},'task','${operation}',${literal(kind)},${literal(state)},${literal(stamp)},'goal-owner','2099-01-01T00:00:00.000Z',1,${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    ]);
  }
  const cycleState = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('state',state,'owner',lease_owner,'fence',fencing_token,'hasHeartbeat',last_heartbeat_at IS NOT NULL,'hasCompletion',completed_at IS NOT NULL,'renewed',lease_expires_at>now()) result FROM task_dispatch_cycles WHERE chat_id='task'",
      },
      { op: "query-json", shape: "raw" },
    );
  for (const state of [
    "implementing",
    "paused",
    "blocked",
    "complete",
    "failed",
    "review",
  ]) {
    await leased();
    await ok(
      "Goal lease reconciliation " + state,
      { action: "reconcile", state },
      (v) =>
        assert.deepEqual(
          v.trace.map((t) => t.kind),
          ["blocked", "complete", "failed"].includes(state) ? ["tick"] : [],
        ),
    );
    for (const row of await cycleState("durable Goal lease " + state)) {
      assert.equal(
        row.state,
        state === "failed"
          ? "failed"
          : ["blocked", "complete"].includes(state)
            ? "succeeded"
            : "running",
      );
      assert.equal(row.hasHeartbeat, state !== "review");
      assert.equal(
        row.hasCompletion,
        ["blocked", "complete", "failed"].includes(state),
      );
      assert.equal(row.fence, 1);
    }
  }
  for (const kind of ["direct", "initial-plan"]) {
    await leased("running", kind);
    await ok("ordinary dispatch does not retain Goal lease " + kind, {
      action: "reconcile",
      state: "complete",
    });
    for (const row of await cycleState("ordinary dispatch untouched " + kind)) {
      assert.equal(row.state, "running");
      assert.equal(row.hasHeartbeat, false);
    }
  }
  await leased("expired");
  await ok(
    "stale Goal no longer owns active dispatch",
    { action: "reconcile", state: "complete" },
    (v) => assert.deepEqual(v.trace, []),
  );
  await leased();
  await ok("same retained Goal fence is accepted twice", {
    action: "retain",
    lease: {
      cycleId: cycle,
      operationId: operation,
      leaseOwner: "goal-owner",
      leaseExpiresAt: stamp,
      fencingToken: 1,
    },
  });
  for (const row of await cycleState("retained Goal actually renewed")) {
    assert.equal(row.state, "running");
    assert.equal(row.hasHeartbeat, true);
    assert.equal(row.renewed, true);
  }
  await leased();
  await bad(
    "retaining an obsolete fence reports actual stale lease",
    {
      action: "retain",
      lease: {
        cycleId: cycle,
        operationId: operation,
        leaseOwner: "goal-owner",
        leaseExpiresAt: stamp,
        fencingToken: 2,
      },
    },
    "The Task dispatch lease is stale or no longer active.",
  );
  relay = await finalized();
  await ok(
    "null optional Goal launch settings retain Source defaults",
    {
      action: "launch",
      operation,
      goalReply: { ...reply(), task: relay.task },
      options: {
        modelConfiguration: null,
        userMessage: null,
        workerPrompt: null,
        purpose: null,
      },
    },
    (v) => {
      assert.deepEqual(
        v.trace[0].options.encryptedTaskMessages.userMessage,
        relay.goal.startMessage,
      );
      assert.equal(v.trace[0].options.purpose, "Task implementation Goal");
      assert.equal(
        v.trace[0].options.workerPrompt,
        "Begin the active Task Goal and follow its encrypted objective.",
      );
    },
  );
}
