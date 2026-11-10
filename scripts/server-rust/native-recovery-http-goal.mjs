// Canonical Task/Goal setup with actual SQL; real dispatch/outcome HTTP authority,
// unchanged worker transport, endpoint encryption and transaction rollback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  taskInferenceInputReceiptSchema,
  taskGoalCycleDispatchSchema,
  taskGoalCycleDispatchResultSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalOutcomeCommitSchema,
} from "../../packages/protocol/dist/index.js";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import {
  task as chat,
  taskProject as project,
  taskTree as tree,
} from "./native-event-http-setup.mjs";
import { literal, json } from "./project-target-state.mjs";
import { taskTimestamp as stamp } from "./task-wire-fixtures.mjs";
import { nativeRecoveryGoalContent } from "./native-recovery-http-goal-content.mjs";
import { nativeHistoryPayloadDigest } from "../../tests/reference-node-server/src/db/repository/native-history-digest.ts";

const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;

export async function nativeRecoveryHttpGoal(h, result) {
  const content = nativeRecoveryGoalContent(h, result, chat);
  const cycleId = id(401),
    operation = id(402),
    lane = id(403),
    user = id(404);
  const threadId = "task-thread",
    turnId = "autonomous-goal-turn";
  const call = (name, phase, input, status = 200, headers = {}) =>
    h.visit(name, "POST", "/api/internal/native-commands/" + phase, {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential, ...headers },
      json: input,
      status,
    });
  const parent = taskInferenceInputReceiptSchema.parse({
    kind: "goal",
    operationId: id(405),
    chatId: chat,
    clientMessageId: user,
    workerId: worker,
    worktreeId: tree,
    executionLaneId: lane,
    executionLaneActivatedAt: stamp,
    providerId: "recovery-goal-provider",
    modelRouteId: "recovery-goal-route",
    providerAccountId: null,
    dispatch: {
      cycleId,
      operationId: operation,
      leaseOwner: "controlled-goal-owner",
      fencingToken: 7,
    },
  });
  const parentMessage = await content.message(
    user,
    "user",
    "original-goal-input",
    "original Goal input",
  );
  const task = await content.task();
  const parentState = {
    receipt: parent,
    publication: { id: id(406), idempotencyKey: "original-goal-response" },
    nativeExecution: {
      threadId,
      turnId: "original-goal-turn",
      scopeId: "original-goal-scope",
    },
    nativeOwner: {
      workerGeneration: h.worker.connectionGeneration(),
      runtimeGeneration: id(407),
    },
    accepted: true,
    dispatched: true,
    allAttemptsEnforced: true,
    firstDispatchedOperationId: parent.operationId,
    multipleDispatched: false,
    deferred: false,
    attemptCountBefore: 0,
  };
  await h.fixture.sql([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('recovery-goal-provider',${literal(h.owner)},'Controlled Goal provider','openai-compatible','http://fixture.invalid')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('recovery-goal-model',${literal(h.owner)},'Controlled Goal model')`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('recovery-goal-route','recovery-goal-model','recovery-goal-provider','controlled',0)",
    `UPDATE chats SET model_id='recovery-goal-model',status='running',automation_paused=false,managed_autonomy_stopped=false WHERE id=${literal(chat)}`,
    `UPDATE chat_runtime_sessions SET model_route_id='recovery-goal-route' WHERE chat_id=${literal(chat)}`,
    `INSERT INTO tasks(chat_id,state,planning_round,has_plan,has_final_plan,has_goal_prompt,plan_goal_enabled,protected_content,implementation_started_at) VALUES(${literal(chat)},'implementing',1,true,true,true,true,${json(task.protectedContent)},${literal(stamp)})`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,exclusive,purpose,state,activated_at,created_at,updated_at) VALUES(${literal(lane)},${literal(chat)},${literal(worker)},${literal(tree)},'agent',false,'Controlled Goal recovery','active',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,task_protected_content,task_goal_input,idempotency_key,created_at) VALUES(${literal(user)},${literal(chat)},${literal(tree)},${literal(lane)},'user','goal',${json(parentMessage.protectedContent)},${json(parentState)},'original-goal-input',${literal(stamp)})`,
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,lease_owner,fencing_token,goal_input,physical_worker_id,worktree_id,codex_thread_id,turn_id,model_route_id,lease_expires_at,started_at,fifo_created_at,created_at,updated_at) VALUES(${literal(cycleId)},${literal(h.owner)},${literal(chat)},${literal(operation)},'finalize','running','controlled-goal-owner',7,${json(parentState)},${literal(worker)},${literal(tree)},${literal(threadId)},'original-goal-turn','recovery-goal-route','2099-01-01T00:00:00.000Z',${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  ]);
  const parentAnswer = await content.message(
    parentState.publication.id,
    "assistant",
    parentState.publication.idempotencyKey,
    "original explicit Goal answer",
  );
  const parentDelivery = taskGoalOutcomeDeliverySchema.parse({
    version: 1,
    inputKind: "goal",
    deliveryId: id(410),
    serverId: h.serverId,
    ownerId: h.owner,
    workerId: worker,
    notification: {
      type: "chat.turn.outcome",
      chatId: chat,
      clientMessageId: user,
      executionLaneId: lane,
      worktreeId: tree,
      contextKind: "project",
      scratchRootId: null,
      taskDispatchFence: parent.dispatch,
      taskInferenceInputOperationId: parent.operationId,
      outcome: {
        ok: true,
        result: {
          threadId,
          turnId: parentState.nativeExecution.turnId,
          status: "completed",
          text: "",
          structuredResult: { message: parentAnswer },
        },
      },
    },
  });
  const parentCommitted = await call(
    "commit original explicit Goal input answer",
    "task-goal-outcome",
    parentDelivery,
  );
  taskGoalOutcomeCommitSchema.parse(parentCommitted);
  assert.deepEqual(parentCommitted, {
    deliveryId: parentDelivery.deliveryId,
    taskInferenceInputOperationId: parent.operationId,
    committed: true,
  });
  const legacyDelivery = { ...parentDelivery };
  delete legacyDelivery.inputKind;
  assert.deepEqual(
    await call(
      "legacy omitted Goal input kind replays original answer",
      "task-goal-outcome",
      legacyDelivery,
    ),
    parentCommitted,
  );
  const [parentTerminal] = await h.fixture.sql(
    [],
    [
      `SELECT jsonb_build_object('digest',task_goal_input->'terminal'->>'outcomeDigest','messages',(SELECT count(*) FROM chat_messages WHERE chat_id=m.chat_id))::text result FROM chat_messages m WHERE id=${literal(user)}`,
    ],
  );
  assert.equal(parentTerminal.messages, 2);
  assert.equal(parentTerminal.digest, nativeHistoryPayloadDigest(parentAnswer));
  content.identity(
    parentTerminal.digest,
    "<verified explicit Goal response digest>",
  );
  const cycle = {
    cycleId,
    goalEpoch: "original-goal-epoch",
    scopeId: "autonomous-goal-scope",
    gateAttemptId: "actual-scope-attempt",
    runnerGeneration: "controlled-native-runner",
    modelRouteId: parent.modelRouteId,
    providerAccountId: null,
    orderEpoch: 0,
  };
  const nativeOperation = `native-inference:${threadId}:${turnId}:${cycle.scopeId}:${cycle.gateAttemptId}`;
  const runtime = id(408),
    workerGeneration = h.worker.connectionGeneration();
  const sourceKey = createHash("sha256")
    .update(JSON.stringify([workerGeneration, runtime, nativeOperation]))
    .digest("hex");
  content.identity(sourceKey, "<verified original Goal source key>");
  content.identity(
    "assistant:goal-cycle:" + sourceKey,
    "<original assigned Goal publisher>",
  );
  const dispatch = taskGoalCycleDispatchSchema.parse({
    sourceKey,
    freshRuntimeGeneration: runtime,
    nativeRuntimeGeneration: runtime,
    serverId: h.serverId,
    workerId: worker,
    workerGeneration,
    chatId: chat,
    providerId: parent.providerId,
    threadId,
    turnId,
    operationId: nativeOperation,
    cycle,
  });
  const phase = "task-goal-cycle-dispatch";
  await call("Goal cycle validates before authentication", phase, {}, 400, {
    authorization: "Bearer invalid",
  });
  await call("Goal cycle requires worker credential", phase, dispatch, 401, {
    authorization: "Bearer invalid",
  });
  for (const [name, patch] of [
    ["Goal cycle rejects stale server", { serverId: "stale-server" }],
    ["Goal cycle rejects stale worker process", { workerGeneration: id(499) }],
    ["Goal cycle rejects forged source key", { sourceKey: "f".repeat(64) }],
    [
      "Goal cycle rejects changed Task epoch",
      { cycle: { ...cycle, orderEpoch: 1 } },
    ],
    ["Goal cycle rejects another provider", { providerId: "foreign-provider" }],
    [
      "Goal cycle rejects changed native runtime",
      { nativeRuntimeGeneration: id(498) },
    ],
  ])
    await call(name, phase, { ...dispatch, ...patch }, 409);
  const admitted = await call(
    "dispatch original autonomous Goal scope",
    phase,
    dispatch,
  );
  taskGoalCycleDispatchResultSchema.parse(admitted);
  assert.equal(admitted.accepted, true);
  const source = admitted.suspensionSource;
  assert.equal(source.sourceKey, sourceKey);
  assert.equal(source.operationId, nativeOperation);
  assert.deepEqual(source.parent, parent);
  assert.deepEqual(
    await call("replay original Goal scope dispatch", phase, dispatch),
    admitted,
  );
  const message = await content.message(
    source.publication.id,
    "assistant",
    source.publication.idempotencyKey,
    "original autonomous Goal answer",
  );
  const delivery = taskGoalOutcomeDeliverySchema.parse({
    version: 1,
    inputKind: "goal-cycle",
    deliveryId: id(409),
    serverId: h.serverId,
    ownerId: h.owner,
    workerId: worker,
    goalCycleSource: source,
    notification: {
      type: "chat.turn.outcome",
      chatId: chat,
      clientMessageId: parent.clientMessageId,
      executionLaneId: lane,
      worktreeId: tree,
      contextKind: "project",
      scratchRootId: null,
      outcome: {
        ok: true,
        result: {
          threadId,
          turnId,
          status: "completed",
          text: "",
          structuredResult: { message },
        },
      },
    },
  });
  const storageSql = `SELECT jsonb_build_object('task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id=${literal(chat)}),'cycles',(SELECT jsonb_agg(to_jsonb(c)) FROM task_dispatch_cycles c WHERE id=${literal(cycleId)}),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m WHERE chat_id=${literal(chat)})) result`;
  const state = async () =>
    (
      await h.fixture.sql(
        [],
        [storageSql.replace(") result", ")::text result")],
      )
    )[0];
  const outcome = "task-goal-outcome";
  await call("Goal outcome validates before authentication", outcome, {}, 400, {
    authorization: "Bearer invalid",
  });
  await call(
    "Goal outcome requires worker credential",
    outcome,
    delivery,
    401,
    { authorization: "Bearer invalid" },
  );
  for (const patch of [
    { ownerId: "foreign-owner" },
    { serverId: "stale-server" },
  ])
    await call(
      "Goal outcome rejects " + Object.keys(patch)[0],
      outcome,
      { ...delivery, ...patch },
      409,
    );
  const before = await state();
  await h.fixture.sql([
    "CREATE FUNCTION fail_http_goal_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.goal_cycle_recovery->'suspension'->'terminal' IS NOT NULL AND NEW.goal_cycle_recovery->'suspension'->'terminal'<>'null'::jsonb THEN RAISE EXCEPTION 'actual Goal terminal write failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fail_http_goal_terminal BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION fail_http_goal_terminal()",
  ]);
  await call(
    "actual SQL failure rolls back Goal message and terminal",
    outcome,
    delivery,
    500,
  );
  assert.deepEqual(await state(), before);
  await h.fixture.sql([
    "DROP TRIGGER fail_http_goal_terminal ON task_dispatch_cycles",
    "DROP FUNCTION fail_http_goal_terminal()",
  ]);
  const previous = h.worker.connectionGeneration();
  h.worker.close();
  await h.reconnectWorker();
  assert.notEqual(h.worker.connectionGeneration(), previous);
  const committed = await call(
    "deliver captured Goal result after worker replacement",
    outcome,
    delivery,
  );
  taskGoalOutcomeCommitSchema.parse(committed);
  assert.deepEqual(committed, {
    deliveryId: delivery.deliveryId,
    goalCycleSourceKey: sourceKey,
    committed: true,
  });
  const accepted = await state();
  assert.equal(accepted.messages.length, 3);
  assert.equal(
    accepted.cycles[0].goal_cycle_recovery.suspension.terminal.outcomeDigest,
    content.noteDigest(delivery.notification),
  );
  content.identity(
    content.noteDigest(delivery.notification),
    "<verified original Goal outcome digest>",
  );
  await call(
    "exact Goal delivery replay preserves original answer",
    outcome,
    delivery,
  );
  assert.deepEqual(await state(), accepted);
  const serverProcess = h.fixture.server,
    port = Number(new URL(serverProcess.origin).port);
  await h.live.close();
  h.worker.close();
  await h.fixture.close();
  result.serverExits.push(serverProcess.diagnostics());
  await h.fixture.start({ port });
  await h.reconnectWorker();
  assert.equal(
    (
      await h.visit(
        "Goal server identity after restart",
        "GET",
        "/api/bootstrap",
      )
    ).server.id,
    h.serverId,
  );
  await call(
    "captured Goal outcome replays after server restart",
    outcome,
    delivery,
  );
  assert.deepEqual(await state(), accepted);
  for (const [name, patch] of [
    [
      "changed Goal source retires delivery",
      { goalCycleSource: { ...source, sourceKey: "e".repeat(64) } },
    ],
  ]) {
    assert.deepEqual(await call(name, outcome, { ...delivery, ...patch }), {
      deliveryId: delivery.deliveryId,
      goalCycleSourceKey: patch.goalCycleSource.sourceKey,
      committed: false,
      retiredReason: "goal-cycle-replaced",
    });
    assert.deepEqual(await state(), accepted);
  }
  const replaced = {
    ...delivery,
    notification: {
      ...delivery.notification,
      outcome: {
        ok: true,
        result: {
          ...delivery.notification.outcome.result,
          structuredResult: {
            message: {
              ...message,
              idempotencyKey: "agent-message:goal:foreign-child:goal:item",
            },
          },
        },
      },
    },
  };
  await call(
    "foreign Goal publisher cannot replace committed answer",
    outcome,
    replaced,
    500,
  );
  assert.deepEqual(await state(), accepted);
  result.proofs.push(
    "Actual current worker-authorized Goal dispatch binds its original native scope; captured endpoint-encrypted Goal results survive a worker replacement and server restart, exact replay is idempotent, SQL failure rolls back message and terminal together, and stale sources/publishers cannot replace the accepted answer.",
  );
  return {
    content,
    storageSql,
    proveStored: async (value) => {
      assert.equal(value.cycles.length, 1);
      assert.equal(value.messages.length, 3);
      const answer = value.messages.find((m) => m.id === message.id);
      assert.equal(answer.role, "assistant");
      assert.equal(answer.mode, "goal");
      assert.deepEqual(answer.task_protected_content, message.protectedContent);
      assert.deepEqual(value.task.protected_content, task.protectedContent);
      assert.equal(
        value.cycles[0].goal_cycle_recovery.suspension.terminal.outcomeDigest,
        content.noteDigest(delivery.notification),
      );
      const contracts = new Map();
      for (const command of result.goalCommands) {
        assert.equal(command.type, "chat.goal.get");
        assert.equal(command.chatId, chat);
        assert.equal(command.threadId, threadId);
        assert.equal(command.cwd, "/event-task");
        assert.equal(command.model.routeId, parent.modelRouteId);
        assert.equal(command.provider.id, parent.providerId);
        assert.equal(command.observeExecution, true);
        assert.deepEqual(command.taskContext.nativeCycle, {
          cycleId,
          orderEpoch: 0,
        });
        assert.deepEqual(command.taskContext.task, task);
        assert.equal(command.taskContext.automationPaused, false);
        assert.equal(command.taskContext.message, null);
        assert.ok(
          ["running", "offline"].includes(command.taskContext.chatStatus),
        );
        // Reconnect observations can run on either side of startup's offline
        // transition. Preserve all actual reads; compare their stable scope,
        // while each read independently retains the exact protected Task.
        const { chatStatus: _status, ...taskContext } = command.taskContext;
        const contract = content.canonical(
          h.fixture.normalize({ ...command, taskContext }),
        );
        contracts.set(JSON.stringify(contract), contract);
      }
      result.goalCommandContracts = [...contracts.values()];
      result.backgroundGoalReadsVerified = result.goalCommands.length;
      await content.prove(value);
    },
  };
}
