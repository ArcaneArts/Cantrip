import assert from "node:assert/strict";
import { runProjectTaskPauseCases } from "./project-task-pause-cases.mjs";
import { runTurnOutcomeCases } from "./turn-outcome-cases.mjs";
import {
  literal,
  json,
  label,
  stamp,
  otherOwner,
} from "./project-target-state.mjs";
import {
  taskEnvelope,
  taskStart,
  taskResult,
  taskContent,
} from "./task-wire-fixtures.mjs";
export async function runTaskBackgroundCases(h) {
  if (process.argv.includes("--turn-outcomes-only"))
    return runTurnOutcomeCases(h);
  if (process.argv.includes("--project-controls-only"))
    return runProjectTaskPauseCases(h);
  const { observe, seed, reset, owner, reopen, registerFixedClock } = h;
  for (let i = 0; i < 3; i++) registerFixedClock(Date.parse(stamp) + i * 1000);
  const id = (n) => `83838383-8383-4838-8838-${String(n).padStart(12, "0")}`;
  const chats = ["task", "background-next"],
    worker = id(1),
    cycles = chats.map((_, i) => id(10 + i));
  const encryption = {
    supported: true,
    state: "ready",
    principalId: id(2),
    grants: [{ component: "task-content", keyRevision: 1 }],
    lastSyncedAt: stamp,
    error: null,
  };
  const selectRows =
    "SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY fifo_created_at,chat_id,id) FROM task_dispatch_cycles c),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,ordinal) FROM task_planning_rounds r),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY chat_id,sequence) FROM chat_messages m)) result";
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('background-provider',${literal(owner)},'Background','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('background-model',${literal(owner)},'Background') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('background-route','background-model','background-provider','background',0,true) ON CONFLICT DO NOTHING",
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES('background-next',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
  ]);
  let preparedTasks, chatAttempts;
  async function clean({ count = 1, concurrency = 1, extra = [] } = {}) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM token_usage_records",
      "DELETE FROM model_behavior_observations",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL",
      `UPDATE workers SET encryption_status=${json(encryption)},unlinked_at=NULL WHERE id IN ('alpha','beta')`,
      "UPDATE chats SET experience='task',status='idle',automation_paused=false,auto_title_pending=false,model_id='background-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL,active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id IN ('task','background-next')",
      "UPDATE user_settings SET auto_name_tasks=false,auto_name_chats=false,default_model_id='background-model'",
      `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,max_concurrency,created_at,updated_at) VALUES('${worker}',${literal(owner)},'Background','background-model','background-family',${concurrency},${literal(stamp)},${literal(stamp)})`,
      ...chats
        .slice(0, count)
        .flatMap((chat, i) => [
          `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES(${literal(chat)},${json(taskEnvelope)},${literal(stamp)}::timestamptz+interval '${i} seconds',${literal(stamp)})`,
          `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,created_at,updated_at) VALUES('${cycles[i]}',${literal(owner)},${literal(chat)},${literal(id(70 + i))},'direct','queued',${literal(stamp)}::timestamptz+interval '${i} seconds',${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('${id(30 + i)}',${literal(chat)},'alpha','github-alpha-main',${literal("background-thread-" + i)},'background-route','ready')`,
        ]),
      ...extra,
    ]);
    preparedTasks = {};
    chatAttempts = {};
    for (const [i, chat] of chats.slice(0, count).entries()) {
      const prepared = taskStart("direct", chat, 1, 1, id(70 + i));
      prepared.operation.userMessage.id = id(50 + i);
      prepared.operation.userMessage.idempotencyKey = "background-user-" + i;
      const relay = taskResult(prepared);
      relay.assistantMessage.id = id(60 + i);
      relay.assistantMessage.idempotencyKey =
        "assistant:" + prepared.operation.userMessage.id;
      preparedTasks[chat] = prepared;
      chatAttempts[chat] = [
        {
          result: {
            threadId: "background-thread-" + i,
            turnId: "background-turn-" + i,
            text: "",
            status: "completed",
            structuredResult: relay,
          },
        },
      ];
    }
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      { chat: "task", preparedTasks, chatAttempts, ...fields },
      { op: "native-command-task-background", shape: "raw" },
    );
  const rows = (name) =>
    observe(name, { sql: selectRows }, { op: "query-json", shape: "raw" });
  await clean();
  for (const v of await run(
    "background scheduler claims and completes actual encrypted direct operation",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
    assert.equal(
      v.logs.filter((l) => l.event === "task.scheduler.claimed").length,
      1,
    );
  }
  let before = await rows(
    "background completion Task/cycle/round/message rows",
  );
  for (const r of before) {
    assert.equal(r.tasks[0].state, "complete");
    assert.equal(r.cycles[0].state, "succeeded");
    assert.deepEqual(
      r.messages.map((m) => m.role),
      ["user", "assistant"],
    );
  }
  await reopen("background encrypted completion restart");
  assert.deepEqual(
    await rows("background completion exact rows after restart"),
    before,
  );
  await clean({ count: 2 });
  for (const v of await run(
    "overlapping wakeups coalesce while active turn retains capacity",
    {
      holdTurnChats: ["task"],
      steps: [
        { kind: "ticks", count: 12 },
        { kind: "wait-commands", chat: "task", count: 1 },
        { kind: "wait" },
        {
          kind: "wait-sql",
          sql: "SELECT count(*)=1 result FROM task_planning_rounds WHERE execution_lane_id IS NOT NULL AND user_message_id IS NOT NULL",
          value: true,
        },
        { kind: "snapshot", sql: selectRows },
        { kind: "ticks", count: 8 },
        { kind: "wait" },
        { kind: "snapshot", sql: selectRows },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    for (const s of v.result.snapshots) {
      assert.deepEqual(
        s.cycles.map((c) => c.state),
        ["running", "queued"],
      );
      assert.equal(s.cycles[1].attempt_count, 0);
    }
    assert.equal(
      v.commands.filter(
        (c) => c.command.type === "chat.turn" && c.command.chatId === "task",
      ).length,
      1,
    );
    assert.equal(
      v.commands.filter(
        (c) =>
          c.command.type === "chat.turn" &&
          c.command.chatId === "background-next",
      ).length,
      1,
    );
  }
  for (const r of await rows("completion wakeup drains next queued Task"))
    assert.deepEqual(
      r.cycles.map((c) => c.state),
      ["succeeded", "succeeded"],
    );
  await clean({
    count: 2,
    concurrency: 2,
    extra: [
      "UPDATE project_worktrees SET branch='background-next' WHERE id='github-beta-main'",
      "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='background-next'",
      "UPDATE chat_runtime_sessions SET worker_id='beta',worktree_id='github-beta-main' WHERE chat_id='background-next'",
    ],
  });
  for (const v of await run(
    "slow worker turn does not hold the scheduler planning loop",
    {
      holdTurnChats: ["task", "background-next"],
      steps: [
        { kind: "tick" },
        { kind: "wait-commands", count: 2 },
        { kind: "wait" },
        {
          kind: "wait-sql",
          sql: "SELECT count(*)=2 result FROM task_planning_rounds WHERE execution_lane_id IS NOT NULL AND user_message_id IS NOT NULL",
          value: true,
        },
        { kind: "snapshot", sql: selectRows },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.deepEqual(
      v.result.snapshots[0].cycles.map((c) => c.state),
      ["running", "running"],
    );
    assert.deepEqual(
      v.logs
        .filter((l) => l.event === "task.scheduler.claimed")
        .map((l) => l.chatId),
      chats,
    );
  }
  await clean({
    extra: [
      `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(stamp)} WHERE id='github'`,
    ],
  });
  for (const v of await run(
    "periodic scheduler observes a later project unpause",
    {
      steps: [
        { kind: "start" },
        { kind: "wait" },
        { kind: "snapshot", sql: selectRows },
        {
          kind: "sql",
          sql: "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
        },
        {
          kind: "wait-sql",
          sql: "SELECT count(*)=1 result FROM task_dispatch_cycles WHERE state='succeeded'",
          value: true,
        },
        { kind: "stop" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(v.result.snapshots[0].cycles[0].state, "queued");
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  await clean({
    extra: [
      `UPDATE task_dispatch_cycles SET state='claimed',selected_task_worker_id='${worker}',physical_worker_id='alpha',worktree_id='github-alpha-main',model_route_id='background-route',model_configuration='{"modelId":"background-model","reasoningEffort":null,"customSubagentModel":false,"subagentModelId":null,"subagentReasoningEffort":null}',lease_owner='dead-server',lease_expires_at=${literal(stamp)},last_heartbeat_at=${literal(stamp)},claimed_at=${literal(stamp)},fencing_token=1,attempt_count=1`,
    ],
  });
  for (const v of await run(
    "expired unstarted claim is requeued and executed under a new fence",
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some(
        (l) => l.event === "task.scheduler.unstarted-leases-requeued",
      ),
    );
  }
  for (const r of await rows(
    "requeued unstarted claim commits a fresh fenced completion",
  )) {
    assert.equal(r.cycles[0].state, "succeeded");
    assert.equal(r.cycles[0].fencing_token, 3);
    assert.equal(r.cycles[0].attempt_count, 2);
  }
  const affinityFields = `selected_task_worker_id='${worker}',task_worker_revision=1,physical_worker_id='alpha',worktree_id='github-alpha-main',model_route_id='background-route',model_configuration='{"modelId":"background-model","reasoningEffort":null,"customSubagentModel":false,"subagentModelId":null,"subagentReasoningEffort":null}',codex_thread_id='background-thread-0',turn_id='retained-turn',lease_owner='dead-server',lease_expires_at=${literal(stamp)},last_heartbeat_at=${literal(stamp)},claimed_at=${literal(stamp)},fencing_token=1,attempt_count=1`;
  await clean({
    extra: [
      `UPDATE task_dispatch_cycles SET state='paused',${affinityFields},paused_at=${literal(stamp)}`,
      "UPDATE chats SET automation_paused=true WHERE id='task'",
    ],
  });
  for (const v of await run(
    "scheduler resumes an actual paused claim with worker affinity",
    {
      pauseReplies: [
        {
          paused: false,
          active: { threadId: "background-thread-0", turnId: "retained-turn" },
        },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.deepEqual(
      v.commands.map((c) => c.command.type),
      ["chat.pause.set"],
    );
    assert.equal(v.commands[0].command.paused, false);
  }
  for (const r of await rows(
    "resumed active dispatch remains running under its retained fence",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.equal(r.cycles[0].fencing_token, 1);
    assert.equal(r.cycles[0].attempt_count, 2);
    assert.equal(r.rounds, null);
  }
  await clean({
    extra: [
      `UPDATE task_dispatch_cycles SET state='paused',${affinityFields},paused_at=${literal(stamp)}`,
      "UPDATE chats SET automation_paused=true WHERE id='task'",
    ],
  });
  for (const v of await run(
    "scheduler owns delayed resume affinity failure after its tick exits",
    {
      holdPauseFirst: true,
      pauseReplies: [
        {
          paused: false,
          active: { threadId: "background-thread-0", turnId: "wrong-turn" },
        },
      ],
      steps: [
        { kind: "tick" },
        { kind: "wait-commands", command: "chat.pause.set", count: 1 },
        { kind: "wait" },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some(
        (l) =>
          l.message === "Paused Task resume failed" &&
          l.errorMessage === "The paused Task runtime affinity changed.",
      ),
    );
    assert.deepEqual(
      v.commands.map((c) => c.command.paused),
      [false, true],
    );
  }
  for (const r of await rows(
    "failed asynchronous resume restores paused dispatch",
  ))
    assert.equal(r.cycles[0].state, "paused");
  await clean();
  const begun = await observe(
    "persist real encrypted operation before simulated started-lease expiry",
    { chat: "task", action: "begin", input: preparedTasks.task },
    { op: "native-command-task", shape: "raw" },
  );
  for (const v of begun) assert.ok(v.value);
  await seed(
    `UPDATE task_dispatch_cycles SET state='running',${affinityFields},started_at=${literal(stamp)}`,
  );
  for (const v of await run(
    "scheduler expires started work and applies its saved protected failure",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(v.commands.length, 0);
    assert.ok(
      v.logs.some((l) => l.event === "task.scheduler.started-leases-expired"),
    );
  }
  for (const r of await rows(
    "expired started operation retains protected failure and new fence",
  )) {
    assert.equal(r.cycles[0].state, "expired");
    assert.equal(r.cycles[0].fencing_token, 2);
    assert.equal(r.tasks[0].state, "failed");
    assert.equal(r.rounds[0].status, "failed");
  }
  await clean({
    extra: [
      "UPDATE tasks SET plan_goal_enabled=true,state='implementing',planning_round=1,has_plan=true,has_final_plan=true,has_goal_prompt=true,implementation_started_at=" +
        literal(stamp) +
        " WHERE chat_id='task'",
      "UPDATE task_workers SET allows_plan_goal=true",
      `UPDATE task_dispatch_cycles SET operation_kind='finalize',state='running',${affinityFields},started_at=${literal(stamp)}`,
    ],
  });
  const goalReply = {
    goal: {
      chatId: "task",
      threadId: "<goal-thread>",
      status: "active",
      protectedObjective: taskEnvelope,
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    task: taskContent("implementing", 1, {
      hasPlan: true,
      hasFinalPlan: true,
      hasGoalPrompt: true,
    }),
    message: null,
    execution: { threadId: "<goal-thread>", status: "running" },
  };
  for (const v of await run(
    "retained Goal recovery renews its actual lease before expiry reconciliation",
    { goalReply },
  )) {
    assert.equal(v.beginError, null);
    assert.ok(v.commands.some((c) => c.command.type === "chat.goal.get"));
    assert.ok(!v.commands.some((c) => c.command.type === "chat.turn"));
    assert.ok(
      !v.logs.some((l) => l.event === "task.scheduler.started-leases-expired"),
    );
  }
  for (const r of await rows(
    "recovered Goal remains running under recovered ownership",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.equal(r.cycles[0].fencing_token, 2);
    assert.equal(r.cycles[0].lease_owner, "background-server:instance");
  }
  await clean({
    extra: [
      "DELETE FROM task_dispatch_cycles",
      `UPDATE tasks SET state='failed',stable_state_before_failure='draft',last_error=${json({ code: "task-timeout", operationKind: "direct", occurredAt: stamp })},automatic_retry=${json({ status: "scheduled", failureKind: "runtime", failureKey: "seed", dueAt: 0, attempts: [], claim: null })} WHERE chat_id='task'`,
      "DELETE FROM chat_runtime_sessions WHERE chat_id='task'",
    ],
  });
  await seed("UPDATE task_workers SET enabled=false");
  const retryPrepared = structuredClone(preparedTasks);
  retryPrepared.task.operation.operationId = "<task-operation-id>";
  const retryAttempts = structuredClone(chatAttempts);
  retryAttempts.task[0].templateResult = true;
  retryAttempts.task[0].result.structuredResult.operationId =
    "<task-operation-id>";
  for (const v of await run(
    "automatic retry queues while worker disabled then reaches encrypted completion",
    {
      preparedTasks: retryPrepared,
      chatAttempts: retryAttempts,
      templatePreparedTask: true,
      steps: [
        { kind: "tick" },
        { kind: "wait" },
        { kind: "wait" },
        { kind: "snapshot", sql: selectRows },
        { kind: "sql", sql: "UPDATE task_workers SET enabled=true" },
        { kind: "tick" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    const admitted = v.result.snapshots[0];
    assert.equal(admitted.cycles[0].state, "queued");
    assert.equal(admitted.tasks[0].automatic_retry.status, "idle");
    assert.equal(admitted.tasks[0].automatic_retry.attempts.length, 1);
    assert.equal(admitted.tasks[0].automatic_retry.claim, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "task.operation.prepare")
        .length,
      1,
    );
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  for (const r of await rows(
    "automatic retry records its actual attempt and completed dispatch",
  )) {
    assert.equal(r.cycles[0].state, "succeeded");
    assert.equal(r.tasks[0].state, "complete");
    assert.equal(r.tasks[0].automatic_retry, null);
  }

  await clean();
  await observe(
    "persist encrypted operation before failed expiry reconciliation",
    { chat: "task", action: "begin", input: preparedTasks.task },
    { op: "native-command-task", shape: "raw" },
  );
  await seed([
    `UPDATE task_dispatch_cycles SET state='running',${affinityFields},started_at=${literal(stamp)}`,
    "UPDATE tasks SET protected_content='null'::jsonb WHERE chat_id='task'",
  ]);
  for (const v of await run(
    "started-lease cleanup projection error is reported without stopping owner reconciliation",
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some(
        (l) => l.event === "task.scheduler.started-lease-reconcile-failed",
      ),
    );
    assert.ok(
      v.logs.some((l) => l.event === "task.scheduler.started-leases-expired"),
    );
    assert.ok(
      !v.logs.some((l) => l.message === "Could not schedule queued Tasks"),
    );
  }
  await clean({
    extra: ["UPDATE task_dispatch_cycles SET model_configuration='[]'::jsonb"],
  });
  for (const v of await run(
    "failed tick clears its active slot so repaired queued work can run",
    {
      steps: [
        { kind: "tick" },
        { kind: "wait" },
        { kind: "snapshot", sql: selectRows },
        {
          kind: "sql",
          sql: "UPDATE task_dispatch_cycles SET model_configuration=NULL",
        },
        { kind: "tick" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some((l) => l.message === "Could not schedule queued Tasks"),
    );
    assert.equal(v.result.snapshots[0].cycles[0].state, "queued");
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  await clean({ count: 2 });
  for (const v of await run(
    "stopping scheduler sources drains admitted work without losing queued Tasks",
    {
      holdTurnChats: ["task"],
      steps: [
        { kind: "start" },
        { kind: "wait-commands", chat: "task", count: 1 },
        { kind: "wait" },
        { kind: "stop" },
        {
          kind: "sql",
          sql: "UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=now() WHERE id='github'",
        },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  before = await rows("stopped scheduler preserves completed and queued work");
  for (const r of before)
    assert.deepEqual(
      r.cycles.map((c) => c.state),
      ["succeeded", "queued"],
    );
  await reopen("stopped scheduler restart");
  assert.deepEqual(
    await rows("stopped scheduler exact rows after restart"),
    before,
  );
  await seed(
    "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
  );
  for (const v of await run(
    "new scheduler after restart runs retained queued work",
  )) {
    assert.equal(v.beginError, null);
    assert.deepEqual(
      v.commands
        .filter((c) => c.command.type === "chat.turn")
        .map((c) => c.command.chatId),
      ["background-next"],
    );
  }
  for (const r of await rows("restarted scheduler completes retained work"))
    assert.ok(r.cycles.every((c) => c.state === "succeeded"));
  await clean();
  const foreignChat = "background-foreign";
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('background-foreign-provider',${literal(otherOwner)},'Foreign background','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('background-foreign-model',${literal(otherOwner)},'Foreign background') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('background-foreign-route','background-foreign-model','background-foreign-provider','foreign',0,true) ON CONFLICT DO NOTHING",
    `INSERT INTO user_settings(user_id,default_model_id,auto_name_tasks,auto_name_chats) VALUES(${literal(otherOwner)},'background-foreign-model',false,false) ON CONFLICT(user_id) DO UPDATE SET default_model_id='background-foreign-model',auto_name_tasks=false,auto_name_chats=false`,
    `UPDATE workers SET encryption_status=${json(encryption)} WHERE id='foreign'`,
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,model_id,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(foreignChat)},${literal(otherOwner)},'other','foreign','other-foreign-main','task','background-foreign-model',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET model_id='background-foreign-model',experience='task',active_worker_id='foreign',active_worktree_id='other-foreign-main'`,
    `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES(${literal(foreignChat)},${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,created_at,updated_at) VALUES('${id(3)}',${literal(otherOwner)},'Foreign background','background-foreign-model','foreign-family',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,created_at,updated_at) VALUES('${id(12)}',${literal(otherOwner)},${literal(foreignChat)},'${id(72)}','direct','queued',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('${id(32)}',${literal(foreignChat)},'foreign','other-foreign-main','background-foreign-thread','background-foreign-route','ready')`,
  ]);
  const foreignPrepared = taskStart("direct", foreignChat, 1, 1, id(72));
  foreignPrepared.operation.userMessage.id = id(52);
  foreignPrepared.operation.userMessage.idempotencyKey =
    "background-user-foreign";
  const foreignRelay = taskResult(foreignPrepared);
  foreignRelay.assistantMessage.id = id(62);
  foreignRelay.assistantMessage.idempotencyKey = "assistant:" + id(52);
  preparedTasks[foreignChat] = foreignPrepared;
  chatAttempts[foreignChat] = [
    {
      result: {
        threadId: "background-foreign-thread",
        turnId: "background-foreign-turn",
        text: "",
        status: "completed",
        structuredResult: foreignRelay,
      },
    },
  ];
  for (const v of await run(
    "scheduler carries real owner scope through concurrent tenant launches",
    {
      holdTurnChats: ["task", foreignChat],
      steps: [
        { kind: "tick" },
        { kind: "wait-commands", count: 2 },
        { kind: "wait" },
        { kind: "release" },
        { kind: "drain" },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.deepEqual(
      v.commands
        .filter((c) => c.command.type === "chat.turn")
        .map((c) => [c.command.chatId, c.worker])
        .sort(),
      [
        [foreignChat, "foreign"],
        ["task", "alpha"],
      ],
    );
    assert.ok(v.events.some((e) => e.ownerId === otherOwner));
    for (const e of v.events.filter((e) => e.scope?.chatId === foreignChat))
      assert.equal(e.ownerId, otherOwner);
  }
  before = await rows(
    "multi-tenant scheduler exact durable state before restart",
  );
  for (const r of before)
    assert.ok(r.cycles.every((c) => c.state === "succeeded"));
  await reopen("multi-tenant scheduler restart");
  assert.deepEqual(
    await rows("multi-tenant scheduler exact durable state after restart"),
    before,
  );
  await runProjectTaskPauseCases(h);
  await runTurnOutcomeCases(h);
}
