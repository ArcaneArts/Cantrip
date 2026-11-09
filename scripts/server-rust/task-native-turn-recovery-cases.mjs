// Actual SQL authority and atomicity around the worker's native terminal read.
import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskEnvelope, taskStart } from "./task-wire-fixtures.mjs";
import { nativeHistoryPayloadDigest } from "../../cantrip_server/src/db/repository/native-history-digest.ts";
import { runTaskNativeTurnRecoveryRaces } from "./task-native-turn-recovery-races.mjs";
import { interactionOpaque } from "./agent-interaction-fixtures.mjs";

export async function runTaskNativeTurnRecoveryCases(h) {
  h.registerFixedClock(Date.parse(stamp) + 1);
  h.registerFixedClock(Date.parse(stamp) + 1000);
  const id = (n) => `91919191-9191-4919-8919-${String(n).padStart(12, "0")}`;
  const operation = id(1),
    cycle = id(2),
    lane = id(3),
    inputOperation = id(4);
  const prepared = taskStart("direct", "task", 1, 1, operation);
  const receipt = {
    operationId: inputOperation,
    chatId: "task",
    clientMessageId: prepared.operation.userMessage.id,
    workerId: "alpha",
    worktreeId: "github-alpha-main",
    executionLaneId: lane,
    executionLaneActivatedAt: stamp,
    providerId: "native-recovery-provider",
    modelRouteId: "native-recovery-route",
    providerAccountId: null,
    dispatch: {
      cycleId: cycle,
      operationId: operation,
      leaseOwner: "lost-server",
      fencingToken: 7,
    },
  };
  const native = {
    threadId: "retained-task-thread",
    turnId: "retained-task-turn",
    scopeId: "retained-task-scope",
  };
  const input = {
    receipt,
    nativeExecution: native,
    nativeOwner: { workerGeneration: id(5), runtimeGeneration: id(6) },
    accepted: true,
    dispatched: true,
    allAttemptsEnforced: true,
    firstDispatchedOperationId: inputOperation,
    multipleDispatched: false,
    deferred: false,
    attemptCountBefore: 0,
  };
  const observation = {
    threadId: native.threadId,
    turnId: native.turnId,
    runtimeGeneration: id(7),
    status: "interrupted",
  };
  const run = (name, action, fields = {}, options = {}) =>
    h.observe(
      name,
      { chat: "task", action, ...fields },
      { op: "native-command-task", shape: "raw", ...options },
    );
  const rows = (name) =>
    h.observe(
      name,
      {
        sql:
          "SELECT jsonb_build_object('chat',(SELECT to_jsonb(c) FROM chats c WHERE id='task'),'task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id='task'),'round',(SELECT to_jsonb(r) FROM task_planning_rounds r WHERE id=" +
          literal(operation) +
          "),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM chat_messages m),'interactions',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM agent_interaction_requests i)) result",
      },
      { op: "query-json", shape: "raw" },
    );

  async function clean() {
    await h.seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM task_dispatch_cycles",
      "DELETE FROM chat_messages",
    ]);
    await h.reset();
    await h.seed([
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('native-recovery-provider',${literal(h.owner)},'Native recovery','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('native-recovery-model',${literal(h.owner)},'Native recovery') ON CONFLICT DO NOTHING`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('native-recovery-route','native-recovery-model','native-recovery-provider','recovery',0,true) ON CONFLICT DO NOTHING",
      "UPDATE chats SET experience='task',active_worker_id='alpha',active_worktree_id='github-alpha-main',model_id='native-recovery-model',native_suspension_state=NULL,placement_revision=0 WHERE id='task'",
      `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
    ]);
    for (const value of await run("prepare encrypted direct Task", "begin", {
      input: prepared,
    })) {
      assert.equal(value.value.task.activeOperationId, operation);
    }
    await h.seed([
      "UPDATE chats SET status='running' WHERE id='task'",
      `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,exclusive,purpose,state,activated_at,created_at,updated_at) VALUES('${lane}','task','alpha','github-alpha-main','agent',false,'Native recovery','active',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,task_protected_content,idempotency_key,created_at) VALUES(${literal(receipt.clientMessageId)},'task','github-alpha-main','${lane}','user','default',${json(taskEnvelope)},'native-recovery-user',${literal(stamp)})`,
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fencing_token,physical_worker_id,worktree_id,codex_thread_id,turn_id,model_route_id,attempt_count,eligibility_code,fifo_created_at,created_at,updated_at) VALUES('${cycle}',${literal(h.owner)},'task','${operation}','direct','expired',8,'alpha','github-alpha-main',${literal(native.threadId)},${literal(native.turnId)},'native-recovery-route',1,'reconciliation-required',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `UPDATE task_planning_rounds SET inference_input=${json(input)},execution_lane_id='${lane}',user_message_id=${literal(receipt.clientMessageId)} WHERE id='${operation}'`,
      ...[0, 1, 2].map(
        (n) =>
          `INSERT INTO agent_interaction_requests(id,request_key,owner_id,project_id,chat_id,worker_id,execution_lane_id,thread_id,kind,status,protected_payload,created_at,updated_at) VALUES('${id(20 + n)}','native-recovery-approval-${n}',${literal(h.owner)},'github','task','alpha',${literal(n === 2 ? null : lane)},${literal(native.threadId)},'fileChange',${literal(n === 1 ? "resolved" : "pending")},${json(interactionOpaque)},${literal(stamp)},${literal(stamp)})`,
      ),
    ]);
    const snapshots = await run(
      "capture canonical input without a general Chat thread",
      "capture-native-turn",
    );
    for (const { value } of snapshots) {
      assert.ok(value);
      assert.equal(value.source.context.threadId, native.threadId);
      assert.deepEqual(value.source.receipt, receipt);
    }
    return snapshots.map(({ value }) => value);
  }
  // The harness supports per-peer request factories at its top input level.
  const settle = (
    name,
    expected,
    observed = observation,
    fields = {},
    options = {},
  ) =>
    h.observe(
      name,
      (i) => ({
        chat: "task",
        action: "fail-native-turn",
        expected: expected[i],
        observed,
        ...fields,
      }),
      { op: "native-command-task", shape: "raw", ...options },
    );

  for (const [name, changed] of [
    ["missing turn", { status: null }],
    ["live native turn", { status: "inProgress" }],
    [
      "completed native turn without an encrypted result",
      { status: "completed" },
    ],
    ["another thread", { threadId: "another-thread" }],
    ["another turn", { turnId: "another-turn" }],
    [
      "same runtime generation",
      { runtimeGeneration: input.nativeOwner.runtimeGeneration },
    ],
  ]) {
    const expected = await clean();
    const before = await rows("before rejected observation " + name);
    for (const value of await settle(
      "native recovery rejects " + name,
      expected,
      { ...observation, ...changed },
    ))
      assert.equal(value.value, false);
    assert.deepEqual(
      await rows("rejected observation changes no row " + name),
      before,
    );
  }
  for (const [name, sql, fields] of [
    ["foreign owner", [], { owner: otherOwner }],
    ["another Chat", [], { chat: "missing" }],
    [
      "changed Task revision",
      ["UPDATE tasks SET row_version=row_version+1 WHERE chat_id='task'"],
    ],
    [
      "changed Stop revision",
      [
        "UPDATE chats SET managed_input_revision=managed_input_revision+1 WHERE id='task'",
      ],
    ],
    [
      "changed placement revision",
      [
        "UPDATE chats SET placement_revision=placement_revision+1 WHERE id='task'",
      ],
    ],
    [
      "new pause intent",
      ["UPDATE chats SET automation_paused=true WHERE id='task'"],
    ],
    [
      "archived Chat",
      [`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='task'`],
    ],
    [
      "replaced dispatch fence",
      [`UPDATE task_dispatch_cycles SET fencing_token=9 WHERE id='${cycle}'`],
    ],
    [
      "released lane",
      [`UPDATE chat_execution_lanes SET state='released' WHERE id='${lane}'`],
    ],
    [
      "reactivated lane",
      [
        `UPDATE chat_execution_lanes SET activated_at=activated_at+interval '1 millisecond' WHERE id='${lane}'`,
      ],
    ],
    [
      "different worktree",
      [
        "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='task'",
      ],
    ],
    [
      "concurrent native owner",
      [
        `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{nativeOwner,runtimeGeneration}',${json(id(8))}) WHERE id='${operation}'`,
      ],
    ],
    [
      "provider transfer recorded during native observation",
      [
        `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{routeChange}',${json({ operationId: id(30), inputOperationId: inputOperation, expectedRevision: 2, targetModelRouteId: "replacement-route", targetProviderAccountId: null, source: receipt, phase: "draining", queuedFencingToken: 8, createdAt: stamp, completedAt: null })}) WHERE id='${operation}'`,
      ],
    ],
    [
      "replacement receipt",
      [
        `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{receipt,operationId}',${json(id(9))}) WHERE id='${operation}'`,
      ],
    ],
    ...["accepted", "dispatched", "allAttemptsEnforced"].map((field) => [
      "missing " + field,
      [
        `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{${field}}','false'::jsonb) WHERE id='${operation}'`,
      ],
    ]),
    ...["deferred", "failedBeforeDispatch", "multipleDispatched"].map(
      (field) => [
        field,
        [
          `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{${field}}','true'::jsonb) WHERE id='${operation}'`,
        ],
      ],
    ),
    ...["terminal", "resumption"].map((field) => [
      "concurrent " + field,
      [
        `UPDATE task_planning_rounds SET inference_input=jsonb_set(inference_input,'{${field}}','{}'::jsonb) WHERE id='${operation}'`,
      ],
    ]),
    [
      "later dispatch cycle",
      [
        `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,created_at,updated_at) VALUES('${id(10)}',${literal(h.owner)},'task','${id(11)}','direct','queued',${literal(stamp)},${literal(stamp)}::timestamptz+interval '1 second',${literal(stamp)})`,
      ],
    ],
  ]) {
    const expected = await clean();
    await h.seed(sql);
    const before = await rows("before stale native recovery " + name);
    for (const value of await settle(
      "native recovery rejects stale " + name,
      expected,
      observation,
      fields,
    ))
      assert.equal(value.value, false);
    assert.deepEqual(
      await rows("stale native recovery preserves every row " + name),
      before,
    );
  }
  for (const status of ["failed", "interrupted"]) {
    const expected = await clean();
    const observed = { ...observation, status };
    const startedAt = Date.now();
    for (const value of await settle(
      "positive exact native " + status + " settles once",
      expected,
      observed,
    ))
      assert.equal(value.value, true);
    const after = await rows("committed exact native " + status + " failure");
    for (const row of after) {
      assert.equal(row.task.state, "failed");
      assert.equal(row.task.row_version, 3);
      assert.equal(row.task.active_operation_id, null);
      assert.deepEqual(row.task.automatic_retry, {
        status: "idle",
        failureKind: "runtime",
        failureKey: `native-terminal:${cycle}:8`,
        dueAt: null,
        attempts: [],
        claim: null,
      });
      assert.deepEqual(
        row.task.protected_content,
        prepared.failure.task.protectedContent,
      );
      assert.equal(row.round.status, "failed");
      assert.equal(
        row.round.inference_input.firstDispatchedOperationId,
        inputOperation,
      );
      assert.deepEqual(row.round.inference_input.nativeExecution, native);
      assert.equal(row.round.inference_input.failedBeforeDispatch, undefined);
      assert.equal(row.round.inference_input.terminal.ok, false);
      assert.equal(
        row.round.inference_input.terminal.threadId,
        native.threadId,
      );
      assert.equal(row.round.inference_input.terminal.turnId, native.turnId);
      assert.equal(
        row.round.inference_input.terminal.outcomeDigest,
        nativeHistoryPayloadDigest({
          type: "task-native-terminal-recovery",
          ...observed,
        }),
      );
      const at = Date.parse(row.round.inference_input.terminal.projectedAt);
      assert.ok(at >= startedAt && at <= Date.now());
      assert.equal(row.cycles[0].state, "failed");
      assert.equal(row.cycles[0].attempt_count, 1);
      assert.equal(row.cycles[0].fencing_token, 8);
      assert.equal(row.lanes[0].state, "suspended");
      assert.equal(row.messages.length, 1);
      assert.deepEqual(
        row.interactions.map((value) => value.status),
        ["interrupted", "resolved", "pending"],
      );
      for (const value of row.interactions)
        assert.deepEqual(value.protected_payload, interactionOpaque);
    }
    for (const value of await settle(
      "duplicate terminal recovery is inert " + status,
      expected,
      observed,
    ))
      assert.equal(value.value, false);
    for (const value of await h.observe(
      "legacy retry adoption cannot reschedule recovered native " + status,
      {
        chat: "task",
        action: "adopt",
        code: prepared.failure.task.classification.lastError.code,
        occurredAt: prepared.failure.task.classification.lastError.occurredAt,
      },
      { op: "native-command-task-retry", shape: "raw" },
    ))
      assert.equal(value.value, false);
    assert.deepEqual(
      await rows("duplicate native terminal preserves all rows " + status),
      after,
    );
  }
  const expected = await clean();
  const before = await rows("before terminal-recovery SQL fault");
  await h.seed([
    "CREATE FUNCTION fail_native_terminal_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional terminal commit fault'; END $$",
    "CREATE TRIGGER native_terminal_fault BEFORE UPDATE ON agent_interaction_requests FOR EACH ROW EXECUTE FUNCTION fail_native_terminal_write()",
  ]);
  try {
    await settle(
      "SQL failure rolls back Task, round, lane and terminal proof",
      expected,
      observation,
      {},
      { error: true, sqlstate: "P0001" },
    );
  } finally {
    await h.seed([
      "DROP TRIGGER native_terminal_fault ON agent_interaction_requests",
      "DROP FUNCTION fail_native_terminal_write()",
    ]);
  }
  assert.deepEqual(
    await rows("actual SQL fault retains exact unresolved input"),
    before,
  );
  for (const value of await settle(
    "retry after rolled-back native settlement succeeds",
    expected,
  ))
    assert.equal(value.value, true);
  const retained = await rows("before native recovery repository reopen");
  await h.reopen("native terminal recovery survives repository restart");
  assert.deepEqual(
    await rows("native recovery state retained after restart"),
    retained,
  );
  if (h.databaseMode === "postgres") {
    await runTaskNativeTurnRecoveryRaces(h, clean);
    const sharedExpected = await clean();
    for (const value of await settle(
      "settle both comparison databases after independent shared races",
      sharedExpected,
    ))
      assert.equal(value.value, true);
  }
}
