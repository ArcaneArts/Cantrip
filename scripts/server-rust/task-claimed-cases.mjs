import { runTaskResumedCases } from "./task-resumed-cases.mjs";
import assert from "node:assert/strict";
import { literal, json, stamp } from "./project-target-state.mjs";
import { taskEnvelope, taskStart, taskResult } from "./task-wire-fixtures.mjs";
export async function runTaskClaimedCases(h) {
  const { observe, seed, owner, reset, reopen, registerFixedClock } = h;
  const taskWorker = "81818181-8181-4818-8818-000000000001",
    operation = "81818181-8181-4818-8818-000000000002";
  const now = "2099-01-01T00:00:00.000Z";
  registerFixedClock(Date.parse(now));
  registerFixedClock(Date.parse(now) + 120000);
  let claims, prepared, relay;
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('claimed-provider',${literal(owner)},'Claimed provider','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('claimed-model',${literal(owner)},'Claimed model') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('claimed-route','claimed-model','claimed-provider','claimed',0) ON CONFLICT DO NOTHING",
  ]);
  const scheduler = (name, action, fields = {}) =>
    observe(
      name,
      {
        action,
        chat: "task",
        operation,
        kind: "direct",
        rowVersion: 1,
        leaseOwner: "claimed-server",
        options: { now },
        resolution: {
          eligible: true,
          modelRouteId: "claimed-route",
          providerAccountId: null,
          codexThreadId: "stream-thread",
        },
        ...fields,
      },
      { op: "native-command-task-scheduler", shape: "raw" },
    );
  async function clean(kind = "direct", extra = [], beforeClaim = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM model_behavior_observations",
      "DELETE FROM token_usage_records",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET experience='task',status='idle',automation_paused=false,model_id='claimed-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL,auto_title_pending=false WHERE id='task'",
      "UPDATE user_settings SET auto_name_tasks=false,auto_name_chats=false,default_model_id='claimed-model'",
      `INSERT INTO tasks(chat_id,plan_goal_enabled,protected_content,created_at,updated_at) VALUES('task',${kind !== "direct"},${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO task_workers(id,owner_id,name,model_id,allows_plan_goal,continuity_family,created_at,updated_at) VALUES('${taskWorker}',${literal(owner)},'Claimed worker','claimed-model',true,'claimed-family',${literal(stamp)},${literal(stamp)})`,
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('81818181-8181-4818-8818-000000000003','task','alpha','github-alpha-main','stream-thread','claimed-route','ready')",
    ]);
    await seed(beforeClaim);
    prepared = taskStart(kind, "task", 1, 1, operation);
    relay = taskResult(prepared);
    relay.assistantMessage.id = "81818181-8181-4818-8818-000000000004";
    relay.assistantMessage.idempotencyKey =
      "assistant:" + prepared.operation.userMessage.id;
    for (const v of await scheduler(
      "enqueue actual claimed " + kind,
      "enqueue",
      { kind },
    ))
      assert.equal(v.value.state, "queued");
    claims = (await scheduler("claim actual queued " + kind, "claim")).map(
      (v) => v.value,
    );
    for (const c of claims) assert.ok(c?.lease);
    await seed(extra);
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      (i) => ({
        chat: "task",
        claim: claims[i],
        preparedTask: prepared,
        attempts: [
          {
            result: {
              threadId: "stream-thread",
              turnId: "claimed-turn",
              text: "",
              status: "completed",
              structuredResult: relay,
            },
          },
        ],
        ...fields,
      }),
      { op: "native-command-task-claimed", shape: "raw" },
    );
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ordinal) FROM task_planning_rounds r),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  for (const kind of ["direct", "initial-plan"]) {
    await clean(kind);
    for (const v of await run(
      "actual claimed " + kind + " reaches durable structured completion",
    )) {
      assert.equal(v.beginError, null);
      assert.equal(
        v.commands.filter((c) => c.command.type === "task.operation.prepare")
          .length,
        1,
      );
      assert.equal(
        v.commands.filter((c) => c.command.type === "chat.turn").length,
        1,
      );
      assert.ok(v.trace.some((t) => t.kind === "tick"));
      const launchStart = v.logs.findIndex(
        (l) =>
          l.event === "task.operation.launch-stage" &&
          l.stage === "begin-turn" &&
          l.status === "started",
      );
      const bootstrapStart = v.logs.findIndex(
        (l) =>
          l.event === "task.turn-bootstrap-stage" && l.status === "started",
      );
      assert.ok(
        launchStart >= 0 && bootstrapStart > launchStart,
        "launch-stage start precedes admitted bootstrap events",
      );
      assert.equal(
        v.logs.some((l) => l.level === "error"),
        false,
      );
    }
    const rows = await snapshot(
      "completed " + kind + " Task, round, cycle and messages",
    );
    for (const r of rows) {
      assert.equal(r.cycles[0].state, "succeeded");
      assert.equal(r.rounds[0].status, "completed");
      assert.ok(r.rounds[0].execution_lane_id);
      assert.ok(r.rounds[0].assistant_message_id);
      assert.deepEqual(
        r.messages.map((m) => m.role),
        ["user", "assistant"],
      );
      assert.equal(r.tasks[0].state, kind === "direct" ? "complete" : "review");
    }
    await reopen("completed claimed " + kind + " restart");
    assert.deepEqual(
      await snapshot("complete " + kind + " rows after restart"),
      rows,
    );
    // Recreate the crash boundary after the real relay commit and before its
    // dispatch settlement. The original live fence still owns this operation.
    await seed(
      "UPDATE task_dispatch_cycles SET state='running',completed_at=NULL,lease_expires_at='2099-01-01T00:00:00Z'",
    );
    for (const v of await run(
      "saved " + kind + " relay receipt settles without replaying the worker",
    )) {
      assert.equal(v.beginError, null);
      assert.equal(v.commands.length, 0);
    }
  }
  await clean("direct", [
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state) VALUES('81818181-8181-4818-8818-000000000005','task','github-alpha-main','alpha','agent',false,'Held current Task turn','active')",
    "UPDATE chats SET status='running' WHERE id='task'",
  ]);
  for (const v of await run(
    "competing real Task turn defers capacity without failing the encrypted operation",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      0,
    );
    assert.ok(
      v.logs.some(
        (l) =>
          l.stage === "begin-turn" && l.errorClass === "ExecutionLaneBusyError",
      ),
    );
    assert.equal(
      v.logs.some(
        (l) => l.message === "Scheduled Task operation failed to start",
      ),
      false,
    );
  }
  for (const r of await snapshot(
    "capacity defer preserves real pending operation and FIFO age",
  )) {
    assert.equal(r.cycles[0].state, "queued");
    assert.equal(r.rounds[0].status, "running");
    assert.equal(r.tasks[0].automatic_retry, null);
    assert.equal(Date.parse(r.cycles[0].fifo_created_at), Date.parse(stamp));
  }
  await seed(
    "UPDATE chat_execution_lanes SET state='released',released_at=now() WHERE id='81818181-8181-4818-8818-000000000005'",
  );
  await seed("UPDATE chats SET status='idle' WHERE id='task'");
  claims = (
    await scheduler(
      "reclaim capacity-deferred operation with its new real fence",
      "claim",
    )
  ).map((v) => v.value);
  for (const c of claims) assert.ok(c?.lease.fencingToken > 1);
  for (const v of await run(
    "reclaimed saved request executes without preparing a second operation",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "task.operation.prepare")
        .length,
      0,
    );
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  for (const r of await snapshot(
    "reclaimed original operation durably succeeds",
  )) {
    assert.equal(r.rounds.length, 1);
    assert.equal(r.rounds[0].status, "completed");
    assert.equal(r.cycles[0].state, "succeeded");
  }
  await clean(
    "direct",
    ["UPDATE model_routes SET enabled=false WHERE id='claimed-child-route'"],
    [
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('claimed-child-model',${literal(owner)},'Claimed child') ON CONFLICT DO NOTHING`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('claimed-child-route','claimed-child-model','claimed-provider','child',1,true) ON CONFLICT(id) DO UPDATE SET enabled=true",
      "UPDATE task_workers SET custom_subagent_model=true,subagent_model_id='claimed-child-model'",
      `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json({ available: true, protocolVersion: 1, reason: null })}) WHERE id='alpha'`,
    ],
  );
  for (const v of await run(
    "subagent route lost after claim keeps the actual configuration failure class",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      0,
    );
    assert.ok(
      v.logs.some(
        (l) =>
          l.stage === "begin-turn" &&
          l.errorClass === "ModelConfigurationResolutionError",
      ),
    );
  }
  for (const r of await snapshot(
    "lost claimed subagent route retains its retryable configuration category",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.rounds[0].status, "failed");
    assert.equal(r.tasks[0].automatic_retry.failureKind, "runtime");
    assert.equal(r.tasks[0].automatic_retry.status, "scheduled");
  }
  await clean(
    "direct",
    [
      `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json({ available: false, protocolVersion: 1, reason: "Worker capability changed" })}) WHERE id='alpha'`,
    ],
    [
      "UPDATE model_routes SET enabled=true WHERE id='claimed-child-route'",
      "UPDATE task_workers SET custom_subagent_model=true,subagent_model_id='claimed-child-model'",
    ],
  );
  for (const v of await run(
    "worker capability lost after claim retains a nonretryable model configuration error",
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      0,
    );
    assert.ok(
      v.logs.some(
        (l) =>
          l.stage === "begin-turn" &&
          l.errorClass === "ModelConfigurationResolutionError",
      ),
    );
  }
  for (const r of await snapshot(
    "lost claimed worker capability requires manual recovery",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.rounds[0].status, "failed");
    assert.equal(r.tasks[0].automatic_retry.failureKind, "configuration");
    assert.equal(r.tasks[0].automatic_retry.status, "manual");
  }
  await clean();
  for (const v of await run(
    "actual prepare transport failure settles and records retry",
    { failCommand: "task.operation.prepare" },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(v.commands.length, 1);
    assert.ok(
      v.logs.some(
        (l) => l.message === "Scheduled Task operation failed to start",
      ),
    );
  }
  for (const r of await snapshot(
    "prepare failure preserves an actual failed fence and retry",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.rounds, null);
    assert.equal(r.tasks[0].automatic_retry.status, "scheduled");
  }
  await clean();
  for (const v of await run(
    "preflight timeout owns the late worker SQL operation until drain",
    {
      launchTimeoutMs: 100,
      prepareDelayMs: 500,
      prepareBeforeReplySQL:
        "UPDATE tasks SET priority=99 WHERE chat_id='task'",
    },
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some(
        (l) =>
          l.event === "task.operation.launch-stage" &&
          l.reasonCode === "stage-timeout" &&
          l.errorClass === "TaskLaunchStageTimeoutError",
      ),
    );
  }
  for (const r of await snapshot(
    "timed out preparation still drains its actual SQL effect",
  )) {
    assert.equal(r.tasks[0].priority, 99);
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.tasks[0].automatic_retry.failureKind, "timeout");
    assert.equal(r.rounds, null);
  }
  await clean("direct", [
    "UPDATE tasks SET protected_content='null'::jsonb WHERE chat_id='task'",
  ]);
  for (const v of await run(
    "invalid persisted Task projection preserves the Source validation error class",
  )) {
    assert.equal(v.beginError, null);
    assert.ok(
      v.logs.some(
        (l) =>
          l.stage === "load-operation" &&
          l.status === "failed" &&
          l.errorClass === "ZodError",
      ),
    );
  }
  for (const r of await snapshot(
    "projection failure finishes the actual claimed fence",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.rounds, null);
  }
  await clean();
  for (const v of await run(
    "actual structured result identity failure invokes durable failure cleanup",
    {
      attempts: [
        {
          result: {
            threadId: "stream-thread",
            turnId: "bad-result-turn",
            text: "",
            status: "completed",
            structuredResult: { ...relay, operationId: "wrong-operation" },
          },
        },
      ],
    },
  ))
    assert.equal(v.beginError, null);
  for (const r of await snapshot(
    "failed structured operation keeps its protected failure receipt",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.rounds[0].status, "failed");
    assert.equal(r.tasks[0].state, "failed");
    assert.equal(r.tasks[0].automatic_retry.status, "scheduled");
    assert.equal(r.messages.filter((m) => m.role === "assistant").length, 0);
  }
  await runTaskResumedCases({
    ...h,
    clean,
    run,
    rows: snapshot,
    getClaims: () => claims,
    setClaims: (value) => {
      claims = value;
    },
  });
}
