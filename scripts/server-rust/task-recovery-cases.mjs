import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import {
  taskContent,
  taskEnvelope,
  taskMessage,
  taskStart,
  taskResult,
} from "./task-wire-fixtures.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export async function runTaskRecoveryCases(h) {
  const { observe, seed, owner, reset, reopen } = h,
    chat = "task";
  const cycle = "77777777-7777-4777-8777-000000000401",
    operation = "77777777-7777-4777-8777-000000000402",
    worker = "77777777-7777-4777-8777-000000000403";
  const content = (state = "implementing") =>
    taskContent(state, 1, {
      hasPlan: true,
      hasFinalPlan: true,
      hasGoalPrompt: true,
      ...(state === "failed"
        ? {
            lastError: {
              code: "task-runtime",
              operationKind: "implementation",
              occurredAt: stamp,
            },
          }
        : {}),
    });
  const goal = (status = "active") => ({
    chatId: chat,
    threadId: "<goal-thread>",
    status,
    protectedObjective: taskEnvelope,
    tokenBudget: null,
    tokensUsed: 1,
    timeUsedSeconds: 2,
    createdAt: 1,
    updatedAt: 2,
  });
  const reply = (
    status = "running",
    goalStatus = "active",
    state = "implementing",
  ) => ({
    goal: goal(goalStatus),
    task: content(state),
    message: null,
    execution: { threadId: "<goal-thread>", status },
  });
  const control = () => ({
    ...reply("idle"),
    message: {
      ...taskMessage("user", "goal", "<goal-message-id>"),
      idempotencyKey: "<goal-message-key>",
    },
  });
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('goal-provider',${literal(owner)},'Goal provider','openai-compatible','http://localhost:8080') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('goal-model',${literal(owner)},'Goal model') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('goal-route','goal-model','goal-provider','goal-model',0,true) ON CONFLICT DO NOTHING",
  ]);
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "INSERT INTO managed_queue_states(chat_id,revision) VALUES('task',0) ON CONFLICT(chat_id) DO UPDATE SET revision=0",
      "UPDATE project_sources SET removed_at=NULL",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
      "UPDATE chats SET experience='task',status='failed',automation_paused=false,has_unread_completion=false,active_worker_id='alpha',active_worktree_id='github-alpha-main',model_id='goal-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id='task'",
      `INSERT INTO tasks(chat_id,state,plan_goal_enabled,planning_round,has_plan,has_final_plan,has_goal_prompt,implementation_started_at,last_error,protected_content,created_at,updated_at) VALUES('task','failed',true,1,true,true,true,${literal(stamp)},${json(content("failed").classification.lastError)},${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO task_workers(id,owner_id,name,model_id,allows_plan_goal,continuity_family,max_concurrency,created_at,updated_at) VALUES('${worker}',${literal(owner)},'Recovery Task worker','goal-model',true,'goal-family',1,${literal(stamp)},${literal(stamp)})`,
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('77777777-7777-4777-8777-000000000404','task','alpha','github-alpha-main','goal-thread','goal-route',NULL,'ready')",
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,selected_task_worker_id,task_worker_revision,model_configuration,model_route_id,physical_worker_id,worktree_id,codex_thread_id,lease_owner,lease_expires_at,fencing_token,started_at,created_at,updated_at) VALUES('${cycle}',${literal(owner)},'task','${operation}','finalize','expired',${literal(stamp)},'${worker}',1,${json({ modelId: "goal-model", reasoningEffort: null, customSubagentModel: false, subagentModelId: null, subagentReasoningEffort: null })},'goal-route','alpha','github-alpha-main','goal-thread','old-server',${literal(stamp)},1,${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        chat,
        action: "recover",
        goalReply: reply(),
        goalControlReply: control(),
        recoveryClock: 60000,
        ...fields,
      },
      { op: "native-command-task-goal", shape: "raw" },
    );
  async function ok(name, fields = {}, check = () => {}) {
    const values = await run(name, fields);
    for (const v of values) {
      assert.equal(v.error, undefined, name + JSON.stringify(v.error));
      check(v);
    }
    return values;
  }
  async function bad(name, fields, message) {
    for (const v of await run(name, fields)) {
      assert.ok(v.error, name);
      if (message) assert.equal(v.error.message, message, name);
    }
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        recoverySnapshot: true,
        sql: "SELECT jsonb_build_object('task',to_jsonb(t),'chat',(SELECT jsonb_build_object('worker',active_worker_id,'worktree',active_worktree_id,'paused',automation_paused,'status',status,'unread',has_unread_completion) FROM chats WHERE id='task'),'dispatch',(SELECT jsonb_build_object('state',state,'owner',lease_owner,'fence',fencing_token,'thread',codex_thread_id,'tree',worktree_id,'turn',turn_id,'live',lease_expires_at>now()) FROM task_dispatch_cycles WHERE id='77777777-7777-4777-8777-000000000401'),'lanes',(SELECT jsonb_agg(to_jsonb(l)-'id'-'created_at'-'updated_at' ORDER BY purpose,state) FROM chat_execution_lanes l WHERE chat_id='task'),'queue',(SELECT revision FROM managed_queue_states WHERE chat_id='task')) result FROM tasks t WHERE chat_id='task'",
      },
      { op: "query-json", shape: "raw" },
    );
  await clean();
  for (const fields of [
    { chat: "missing" },
    { owner: otherOwner },
    { chat: h.standalone },
  ])
    await ok(
      "non-owned or non-project Task is not recoverable " +
        JSON.stringify(fields),
      fields,
      (v) => {
        assert.equal(v.result, false);
        assert.deepEqual(v.commands, []);
      },
    );
  for (const change of [
    "UPDATE chats SET experience='agent' WHERE id='task'",
    "UPDATE tasks SET plan_goal_enabled=false WHERE chat_id='task'",
    "UPDATE tasks SET implementation_started_at=NULL WHERE chat_id='task'",
  ]) {
    await clean([change]);
    await ok("recovery requires actual started Plan+Goal " + change, {}, (v) =>
      assert.equal(v.result, false),
    );
  }
  await clean(["UPDATE tasks SET state='complete' WHERE chat_id='task'"]);
  await ok(
    "completed Task succeeds even when worker is offline",
    { connected: false },
    (v) => {
      assert.equal(v.result, true);
      assert.deepEqual(v.commands, []);
    },
  );
  await clean();
  await bad(
    "offline worker does not create replacement execution",
    { connected: false },
    "The project worker is offline. Reconnect it, then retry recovery.",
  );
  for (const [resume, automatic] of [
    [false, false],
    [true, true],
    [false, true],
  ]) {
    await clean(["UPDATE chats SET automation_paused=true WHERE id='task'"]);
    await ok(
      `paused Task is preserved resume=${resume} automatic=${automatic}`,
      { resume, automatic },
      (v) => {
        assert.equal(v.result, true);
        assert.deepEqual(v.commands, []);
        assert.deepEqual(v.trace, []);
      },
    );
  }
  for (const change of [
    "DELETE FROM task_dispatch_cycles",
    "UPDATE task_dispatch_cycles SET operation_kind='direct'",
    "UPDATE task_dispatch_cycles SET codex_thread_id=NULL",
    "UPDATE task_dispatch_cycles SET worktree_id=NULL",
    ...["queued", "claimed", "paused", "succeeded"].map(
      (s) => `UPDATE task_dispatch_cycles SET state='${s}'`,
    ),
  ]) {
    await clean([change]);
    await ok(
      "recovery requires retained started dispatch " + change,
      {},
      (v) => {
        assert.equal(v.result, false);
        assert.deepEqual(v.commands, []);
      },
    );
  }
  await clean([
    "UPDATE chats SET status='idle' WHERE id='task'",
    "UPDATE task_dispatch_cycles SET state='running',lease_owner='recovery-server',lease_expires_at='2099-01-01'",
  ]);
  await ok(
    "healthy local dispatch remains with ordinary continuation",
    {},
    (v) => {
      assert.equal(v.result, false);
      assert.deepEqual(v.commands, []);
    },
  );
  await clean([
    "UPDATE task_dispatch_cycles SET worktree_id='github-beta-main'",
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-beta'`,
  ]);
  await bad(
    "unavailable retained worktree has the original actionable error",
    {},
    "The retained Task worktree is unavailable. Send a follow-up in the current checkout to continue after cleanup.",
  );
  for (const change of [
    "UPDATE task_dispatch_cycles SET worktree_id='github-beta-main'",
    "UPDATE task_dispatch_cycles SET physical_worker_id='beta'",
  ]) {
    await clean([change]);
    await bad(
      "different retained worker is never adopted " + change,
      {},
      "The retained Task session belongs to a different worker.",
    );
  }
  await clean();
  await bad(
    "missing native execution observation never implies a fresh agent",
    { goalReply: { ...reply(), execution: undefined } },
    "The worker could not observe the retained Task session. No new agent was started.",
  );
  await clean();
  await bad(
    "absent native Goal is not silently recreated during observation",
    { goalReply: { ...reply(), goal: null } },
    "The worker could not observe the retained Task session. No new agent was started.",
  );
  await clean();
  await bad(
    "native runtime failure requires explicit Resume",
    { goalReply: reply("failed", "active", "failed") },
    "The native Task session reports a runtime error. Its history was preserved.",
  );
  for (const [status, state] of [
    ["active", "blocked"],
    ["paused", "failed"],
    ["usageLimited", "failed"],
    ["budgetLimited", "failed"],
  ]) {
    await clean();
    await ok(
      `automatic recovery preserves ${status}/${state}`,
      {
        resume: true,
        automatic: true,
        goalReply: reply("idle", status, state),
      },
      (v) => {
        assert.equal(v.result, true);
        assert.deepEqual(v.trace, []);
        assert.equal(v.commands.length, 1);
      },
    );
    for (const row of await snapshot(
      "automatic blocker remains unclaimed " + status,
    ))
      assert.equal(row.dispatch.fence, 1);
  }
  for (const mutation of [
    "UPDATE chats SET automation_paused=true WHERE id='task'",
    "UPDATE chat_runtime_sessions SET codex_thread_id='user-replaced-thread' WHERE chat_id='task'",
  ]) {
    await clean();
    await bad(
      "concurrent user state wins over observed recovery " + mutation,
      { goalBeforeReplySQL: mutation },
      "The Task changed during recovery. Please retry.",
    );
  }
  for (const status of ["running", "waiting-for-approval", "failed"]) {
    await clean([`UPDATE chats SET status='${status}' WHERE id='task'`]);
    await ok(
      "native completion updates unread semantics from " + status,
      { goalReply: reply("idle", "complete", "complete") },
      (v) => assert.equal(v.result, true),
    );
    for (const row of await snapshot(
      "completed state and unread from " + status,
    )) {
      assert.equal(row.chat.status, "idle");
      assert.equal(row.chat.unread, status !== "failed");
      assert.equal(row.task.state, "complete");
    }
  }
  await clean();
  await ok(
    "running retained native session is reattached without starting another turn",
    {},
    (v) => {
      assert.equal(v.result, true);
      assert.equal(v.commands.length, 1);
      assert.equal(v.trace.filter((t) => t.kind === "begin").length, 0);
    },
  );
  for (const row of await snapshot("running native Task owns recovered lane")) {
    assert.equal(row.chat.status, "running");
    assert.equal(row.dispatch.fence, 2);
    assert.equal(row.dispatch.owner, "recovery-server");
    assert.equal(row.lanes.length, 1);
    assert.equal(row.lanes[0].purpose, "Recovered native Task Goal");
  }
  await reopen("recovered native lane and fence survive restart");
  await clean();
  await ok(
    "idle active native Goal resumes through the existing encrypted control path",
    { goalReply: reply("idle") },
    (v) => {
      assert.equal(v.result, true);
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        ["chat.goal.get", "chat.goal.get"],
      );
      assert.equal(v.trace.at(-1).kind, "begin");
      assert.equal(v.trace.at(-1).options.taskDispatchLease.fencingToken, 2);
    },
  );
  await snapshot("resumed native Task retains original objective and capacity");
  await clean(["UPDATE chats SET automation_paused=true WHERE id='task'"]);
  await ok(
    "explicit manual Resume owns the unpause and active update",
    { resume: true, goalReply: reply("idle") },
    (v) => {
      assert.equal(v.result, true);
      assert.equal(v.trace[0].kind, "unpause");
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        ["chat.goal.get", "chat.goal.update"],
      );
    },
  );
  for (const row of await snapshot("manual Resume queue revision is atomic")) {
    assert.equal(row.chat.paused, false);
    assert.equal(row.queue, 1);
  }
  await clean(["UPDATE chats SET automation_paused=true WHERE id='task'"]);
  await bad(
    "failed manual unpause cannot resume native work",
    { resume: true, leavePaused: true, goalReply: reply("idle") },
    "The Task changed during recovery. Please retry.",
  );

  // Explicit contexts are obtained from SQL. A different resident session is a
  // separate native observation and cannot be overwritten by old dispatch affinity.
  await clean([
    "UPDATE chat_runtime_sessions SET codex_thread_id='new-user-thread' WHERE chat_id='task'",
  ]);
  await bad(
    "different current session preserves original recovery error",
    {},
    "The Task already has a different session. Recovery did not replace it.",
  );
  await clean(["UPDATE chats SET status='running' WHERE id='task'"]);
  await ok(
    "healthy chat execution is not replayed from an idle observation",
    { goalReply: reply("idle") },
    (v) => {
      assert.equal(v.result, true);
      assert.ok(!v.trace.some((t) => t.kind === "begin"));
    },
  );
  await clean();
  await ok(
    "concurrent passive observations share one actual worker observation",
    { action: "recover-batch", recoveries: [{}, {}, {}] },
    (v) => {
      assert.deepEqual(v.result, [
        { value: true },
        { value: true },
        { value: true },
      ]);
      assert.equal(v.commands.length, 1);
      assert.equal(
        v.trace.filter((t) => t.kind === "recovery-publish").length,
        1,
      );
    },
  );
  for (const prior of [{ resume: false }, { resume: true, automatic: true }]) {
    await clean(["UPDATE chats SET automation_paused=true WHERE id='task'"]);
    await ok(
      "manual Resume escalates coalesced passive/automatic intent " +
        JSON.stringify(prior),
      {
        action: "recover-batch",
        recoveries: [prior, { resume: true }],
        goalReply: reply("idle"),
      },
      (v) => {
        assert.deepEqual(v.result, [{ value: true }, { value: true }]);
        assert.equal(v.trace.filter((t) => t.kind === "unpause").length, 1);
        assert.ok(v.trace.some((t) => t.kind === "begin"));
      },
    );
  }
  await clean();
  await ok(
    "joined failures preserve their original error",
    { action: "recover-batch", recoveries: [{}, {}], connected: false },
    (v) => {
      assert.equal(v.result.length, 2);
      for (const r of v.result)
        assert.equal(
          r.error,
          "The project worker is offline. Reconnect it, then retry recovery.",
        );
    },
  );
  await clean();
  await ok(
    "failed background observation is throttled on its completion clock",
    { action: "recover-reconcile", count: 2, connected: false },
    (v) => {
      assert.equal(
        v.trace.filter((t) => t.kind === "recovery-error").length,
        1,
      );
    },
  );
  await clean(["UPDATE task_dispatch_cycles SET state='succeeded'"]);
  await ok("settled dispatch is not passively reopened", {}, (v) =>
    assert.equal(v.result, false),
  );
  await ok(
    "manual Resume of settled Goal reacquires real capacity",
    { resume: true, goalReply: reply("idle", "blocked", "blocked") },
    (v) => {
      assert.equal(v.result, true);
      assert.ok(v.trace.some((t) => t.kind === "begin"));
    },
  );
  await clean([
    "UPDATE task_dispatch_cycles SET state='failed'",
    `UPDATE task_workers SET enabled=false WHERE id='${worker}'`,
  ]);
  await bad(
    "automatic recovery enforces actual selected-worker eligibility",
    { resume: true, automatic: true, goalReply: reply("idle") },
    "The selected Task Worker is disabled or no longer allows Plan + Goal. Enable it before resuming.",
  );
  await clean(["UPDATE task_dispatch_cycles SET state='failed'"]);
  await ok(
    "automatic recovery reacquires a released capacity slot",
    { resume: true, automatic: true, goalReply: reply("idle") },
    (v) => assert.equal(v.result, true),
  );
  await reopen("automatic recovery remains durable after process restart");
  await clean();
  await ok(
    "background observation retries at the exact 30 second boundary",
    {
      action: "recover-reconcile",
      connected: false,
      reconcileClocks: [60000, 89999, 90000],
    },
    (v) =>
      assert.equal(
        v.trace.filter((t) => t.kind === "recovery-error").length,
        2,
      ),
  );
  await clean();
  await ok(
    "recovery survives a detached caller and drains its actual SQL work",
    { action: "recover-detached" },
    (v) => {
      assert.equal(v.result, null);
      assert.equal(
        v.trace.filter((t) => t.kind === "recovery-publish").length,
        1,
      );
    },
  );
  for (const row of await snapshot(
    "detached recovery durably owns the recovered native lane",
  )) {
    assert.equal(row.chat.status, "running");
    assert.equal(row.dispatch.fence, 2);
  }
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,branch,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('recovery-placeholder','github-alpha','alpha','placeholder','recovery-placeholder','/fixture/recovery-placeholder','/fixture/recovery-placeholder',false,'cantrip','ready') ON CONFLICT(id) DO NOTHING",
  );
  await clean([
    "UPDATE chats SET active_worktree_id='recovery-placeholder' WHERE id='task'",
  ]);
  await ok(
    "native recovery restores the dispatch's retained worktree and session",
    {},
    (v) => {
      assert.equal(v.result, true);
      assert.equal(v.commands[0].command.cwd, "/fixture/github-alpha");
      assert.equal(v.commands[0].command.threadId, "goal-thread");
    },
  );
  for (const row of await snapshot(
    "retained original placement is restored atomically",
  )) {
    assert.equal(row.chat.worktree, "github-alpha-main");
    assert.equal(row.chat.status, "running");
    assert.equal(row.dispatch.thread, "goal-thread");
  }
  await clean([
    "UPDATE chats SET active_worktree_id='recovery-placeholder' WHERE id='task'",
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,transition_kind) VALUES('77777777-7777-4777-8777-000000000409','task','recovery-placeholder','alpha','agent',true,'Obsolete interrupted handoff','delivering','switch')",
  ]);
  await ok(
    "recovery cancels obsolete handoff before reattaching the retained native session",
    {},
    (v) => assert.equal(v.result, true),
  );
  for (const row of await snapshot(
    "obsolete handoff remains suspended and cannot replay",
  )) {
    const old = row.lanes.find(
      (l) => l.purpose === "Obsolete interrupted handoff",
    );
    assert.equal(old.state, "suspended");
    assert.equal(old.transition_kind, null);
    assert.equal(row.chat.worktree, "github-alpha-main");
  }
  async function canonical() {
    await clean([
      "UPDATE tasks SET state='review',planning_round=1,implementation_started_at=NULL,has_final_plan=false,has_goal_prompt=false,last_error=NULL WHERE chat_id='task'",
    ]);
    const start = taskStart("finalize", chat, 2, 1, operation),
      relay = taskResult(start);
    for (const [action, fields] of [
      ["begin", { input: start }],
      ["complete", { operation, input: relay, turn: "finalizer-turn" }],
      ["finalize", { operation }],
    ]) {
      const values = await observe(
        "prepare canonical saved encrypted objective " + action,
        { chat, action, ...fields },
        { op: "native-command-task", shape: "raw" },
      );
      for (const value of values) assert.ok(value.value);
    }
    await seed(
      `UPDATE tasks SET state='failed',last_error=${json({ code: "task-runtime", operationKind: "implementation", occurredAt: stamp })} WHERE chat_id='task'`,
    );
    return relay;
  }
  const repairFields = (relay) => ({
    resume: true,
    goalReply: {
      goal: null,
      task: relay.task,
      message: null,
      execution: { threadId: "<goal-thread>", status: "idle" },
    },
    goalReplies: {
      "chat.goal.create": { goal: goal(), task: relay.task, message: null },
    },
    protectedMessage: retainedPrompt().pendingMessage,
    taskMessage: taskMessage(
      "system",
      "goal",
      "77777777-7777-4777-8777-000000000405",
    ),
  });
  let relay = await canonical();
  await ok(
    "missing native Goal resumes only the canonical encrypted approved objective",
    repairFields(relay),
    (v) => {
      assert.equal(v.result, true);
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        [
          "chat.goal.get",
          "chat.message.protect",
          "task.message.protect",
          "chat.goal.create",
        ],
      );
      const begin = v.trace.at(-1);
      assert.equal(begin.kind, "begin");
      assert.equal(begin.options.messageRole, "system");
      assert.equal(begin.input.idempotencyKey, "task-goal-repair:task:60000");
      assert.deepEqual(v.commands.at(-1).command.objective, relay.goal);
      assert.equal(
        begin.options.encryptedTaskMessages.userMessage.classification.role,
        "system",
      );
      assert.deepEqual(begin.hooks, { completed: true, failed: true });
    },
  );
  await snapshot(
    "canonical repair retains saved objective and resumed dispatch",
  );
  relay = await canonical();
  await seed("UPDATE chats SET automation_paused=true WHERE id='task'");
  await ok(
    "manual canonical repair unpauses after native idle is verified",
    repairFields(relay),
    (v) => {
      assert.equal(v.trace[0].kind, "unpause");
      assert.equal(v.result, true);
    },
  );
  relay = await canonical();
  let fields = repairFields(relay);
  fields.goalReplies["chat.goal.create"] = {
    goal: null,
    task: {
      ...relay.goal.failureTask,
      classification: {
        ...relay.goal.failureTask.classification,
        stableStateBeforeFailure: null,
      },
    },
    message: null,
  };
  await bad(
    "canonical repair startup failure stores its opaque failure and settles ownership",
    fields,
    "task-goal-start-failed",
  );
  for (const row of await snapshot(
    "failed canonical repair preserves approved Goal for retry",
  )) {
    assert.equal(row.task.last_error.code, "task-goal-start-failed");
    assert.equal(row.task.row_version, 4);
    assert.equal(row.dispatch.state, "failed");
  }
  relay = await canonical();
  fields = repairFields(relay);
  fields.goalReplies["chat.goal.create"] = {
    goal: null,
    task: relay.goal.failureTask,
    message: null,
  };
  await bad(
    "finalization-phase worker failure cannot replace implementation metadata",
    fields,
    "The encrypted Goal update changes protected planning metadata.",
  );
  for (const row of await snapshot(
    "rejected finalization failure preserves current encrypted Task and live fence",
  )) {
    assert.equal(row.task.row_version, 3);
    assert.equal(row.task.last_error.code, "task-runtime");
    assert.equal(row.dispatch.state, "running");
    assert.equal(row.dispatch.live, true);
  }
  relay = await canonical();
  fields = repairFields(relay);
  const completed = {
    ...taskEnvelope,
    envelope: { ...taskEnvelope.envelope, nonce: "BBBBBBBBBBBBBBBB" },
  };
  fields.goalBeforeReplyByType = {
    "chat.goal.create": `UPDATE tasks SET state='complete',last_error=NULL,completed_at=${literal(stamp)},row_version=row_version+1,protected_content=${json(completed)} WHERE chat_id='task'`,
  };
  await bad(
    "concurrent completion wins before canonical Goal turn admission",
    fields,
    "The Task changed during Goal continuation. Please retry.",
  );
  for (const row of await snapshot(
    "concurrent protected completion survives failed recovery admission",
  )) {
    assert.equal(row.task.state, "complete");
    assert.deepEqual(row.task.protected_content, completed);
    assert.equal(row.dispatch.state, "failed");
  }
  await reopen("canonical Goal result and recovery failures survive restart");
}
