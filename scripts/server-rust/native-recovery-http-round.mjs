// A captured older round may save protected history, without projecting its
// result onto the current Task or regaining dispatch/placement authority.
import assert from "node:assert/strict";
import {
  taskInferenceInputReceiptSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalOutcomeCommitSchema,
  taskOperationRelayRequestSchema,
  taskOperationRelayResultSchema,
} from "../../packages/protocol/dist/index.js";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import { task as chat, taskTree as tree } from "./native-event-http-setup.mjs";
import { literal, json } from "./project-target-state.mjs";
import {
  taskTimestamp as stamp,
  taskStart,
  taskResult,
} from "./task-wire-fixtures.mjs";
import { nativeRecoveryGoalContent } from "./native-recovery-http-goal-content.mjs";
import { nativeHistoryPayloadDigest } from "../../tests/reference-node-server/src/db/repository/native-history-digest.ts";

const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;

export async function nativeRecoveryHttpRound(h, result) {
  const content = nativeRecoveryGoalContent(h, result, chat);
  const operation = id(501),
    lane = id(502),
    user = id(503);
  const current = await content.task("draft", 2, {}, "current newer Task");
  const start = taskStart("direct", chat, 1, 1, operation);
  start.operation.task = await content.task(
    "implementing",
    1,
    { stableStateBeforeFailure: "draft", activeOperationKind: "direct" },
    "old round working Task",
  );
  const requested = await content.round(
    operation,
    start.operation.classification,
    "original round request",
  );
  start.operation.protectedInput = requested.protectedContent;
  start.operation.userMessage = await content.message(
    user,
    "user",
    "old-round-input",
    "old round input",
    undefined,
    "default",
  );
  start.failure.task = await content.task(
    "failed",
    1,
    start.failure.task.classification,
    "precomputed round failure Task",
  );
  start.failure.round = await content.round(
    operation,
    start.failure.round.classification,
    "precomputed round failure",
  );
  const relay = taskResult(start);
  relay.task = await content.task("complete", 1, {}, "old completed Task");
  relay.protectedResult = (
    await content.round(operation, relay.classification, "old completed round")
  ).protectedContent;
  relay.assistantMessage = await content.message(
    id(504),
    "assistant",
    "old-round-answer",
    "old round answer",
    undefined,
    "default",
  );
  taskOperationRelayRequestSchema.parse(start.operation);
  taskOperationRelayResultSchema.parse(relay);
  const receipt = taskInferenceInputReceiptSchema.parse({
    operationId: id(505),
    chatId: chat,
    clientMessageId: user,
    workerId: worker,
    worktreeId: tree,
    executionLaneId: lane,
    executionLaneActivatedAt: stamp,
    providerId: "retired-round-provider",
    modelRouteId: "retired-round-route",
    providerAccountId: null,
    dispatch: {
      cycleId: id(506),
      operationId: operation,
      leaseOwner: "old-round-owner",
      fencingToken: 11,
    },
  });
  const input = {
    receipt,
    nativeExecution: {
      threadId: "old-round-thread",
      turnId: "old-round-turn",
      scopeId: "old-round-scope",
    },
    nativeOwner: {
      workerGeneration: h.worker.connectionGeneration(),
      runtimeGeneration: id(507),
    },
    accepted: true,
    dispatched: true,
    allAttemptsEnforced: true,
    firstDispatchedOperationId: receipt.operationId,
    multipleDispatched: false,
    deferred: false,
    attemptCountBefore: 0,
  };
  await h.fixture.sql([
    `UPDATE chats SET status='idle',automation_paused=true WHERE id=${literal(chat)}`,
    `INSERT INTO tasks(chat_id,state,planning_round,protected_content) VALUES(${literal(chat)},'draft',2,${json(current.protectedContent)})`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,exclusive,purpose,state,activated_at,created_at,updated_at) VALUES(${literal(lane)},${literal(chat)},${literal(worker)},${literal(tree)},'agent',false,'Historical round','released',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,task_protected_content,idempotency_key,created_at) VALUES(${literal(user)},${literal(chat)},${literal(tree)},${literal(lane)},'user','default',${json(start.operation.userMessage.protectedContent)},'old-round-input',${literal(stamp)})`,
    `INSERT INTO task_planning_rounds(id,chat_id,ordinal,kind,status,protected_content,relay_request,inference_input,failure_task,failure_round,user_message_id,execution_lane_id,started_at,completed_at) VALUES(${literal(operation)},${literal(chat)},1,'direct','completed',${json(relay.protectedResult)},${json(start.operation)},${json(input)},${json(start.failure.task)},${json(start.failure.round)},${literal(user)},${literal(lane)},${literal(stamp)},${literal(stamp)})`,
  ]);
  const delivery = taskGoalOutcomeDeliverySchema.parse({
    version: 1,
    inputKind: "round",
    deliveryId: id(508),
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
      taskDispatchFence: receipt.dispatch,
      taskInferenceInputOperationId: receipt.operationId,
      outcome: {
        ok: true,
        result: {
          threadId: "old-round-thread",
          turnId: "old-round-turn",
          status: "completed",
          text: "",
          structuredResult: relay,
        },
      },
    },
  });
  const call = (name, body = delivery, status = 200, headers = {}) =>
    h.visit(name, "POST", "/api/internal/native-commands/task-goal-outcome", {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential, ...headers },
      json: body,
      status,
    });
  const storageSql = `SELECT jsonb_build_object('task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id=${literal(chat)}),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ordinal) FROM task_planning_rounds r WHERE chat_id=${literal(chat)}),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l WHERE chat_id=${literal(chat)}),'cycles',(SELECT count(*) FROM task_dispatch_cycles WHERE chat_id=${literal(chat)}),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m WHERE chat_id=${literal(chat)})) result`;
  const state = async () =>
    (
      await h.fixture.sql(
        [],
        [storageSql.replace(") result", ")::text result")],
      )
    )[0];
  await call("round delivery validates before authentication", {}, 400, {
    authorization: "Bearer invalid",
  });
  await call("round delivery requires worker credential", delivery, 401, {
    authorization: "Bearer invalid",
  });
  for (const patch of [
    { ownerId: "foreign-owner" },
    { serverId: "stale-server" },
  ])
    await call(
      "round delivery rejects " + Object.keys(patch)[0],
      { ...delivery, ...patch },
      409,
    );
  const before = await state();
  await h.fixture.sql([
    "CREATE FUNCTION fail_http_round_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.inference_input->'terminal'->>'projectedAt' IS NOT NULL THEN RAISE EXCEPTION 'actual round terminal write failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fail_http_round_terminal BEFORE UPDATE ON task_planning_rounds FOR EACH ROW EXECUTE FUNCTION fail_http_round_terminal()",
  ]);
  await call(
    "actual round SQL failure rolls back protected answer and receipt",
    delivery,
    500,
  );
  assert.deepEqual(await state(), before);
  await h.fixture.sql([
    "DROP TRIGGER fail_http_round_terminal ON task_planning_rounds",
    "DROP FUNCTION fail_http_round_terminal()",
  ]);
  const previous = h.worker.connectionGeneration();
  h.worker.close();
  await h.reconnectWorker();
  assert.notEqual(h.worker.connectionGeneration(), previous);
  const committed = await call(
    "captured historical round survives worker replacement",
  );
  taskGoalOutcomeCommitSchema.parse(committed);
  assert.deepEqual(committed, {
    deliveryId: delivery.deliveryId,
    taskInferenceInputOperationId: receipt.operationId,
    committed: true,
  });
  const accepted = await state();
  assert.deepEqual(accepted.task, before.task);
  assert.deepEqual(accepted.lanes, before.lanes);
  assert.equal(accepted.cycles, 0);
  assert.equal(accepted.messages.length, 2);
  const terminal = accepted.rounds[0].inference_input.terminal;
  assert.equal(terminal.ok, true);
  assert.equal(terminal.historyOnly, true);
  assert.equal(
    terminal.outcomeDigest,
    nativeHistoryPayloadDigest(delivery.notification.outcome),
  );
  assert.ok(Date.parse(terminal.projectedAt) <= Date.now());
  assert.ok(
    Date.parse(terminal.observedAt) <= Date.parse(terminal.projectedAt),
  );
  content.identity(
    terminal.outcomeDigest,
    "<verified original historical round outcome digest>",
  );
  assert.deepEqual(
    await call("exact historical round replay retains one original answer"),
    committed,
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
        "historical round server identity after restart",
        "GET",
        "/api/bootstrap",
      )
    ).server.id,
    h.serverId,
  );
  assert.deepEqual(
    await call("historical round replay after server restart"),
    committed,
  );
  assert.deepEqual(await state(), accepted);
  const changed = structuredClone(delivery);
  changed.notification.outcome.result.structuredResult.assistantMessage.idempotencyKey =
    "foreign-round-publisher";
  await call(
    "changed historical round output cannot replace original answer",
    changed,
    409,
  );
  assert.deepEqual(await state(), accepted);
  const replaced = structuredClone(delivery);
  replaced.notification.taskInferenceInputOperationId = id(509);
  assert.deepEqual(
    await call("replaced round input retires captured delivery", replaced),
    {
      deliveryId: delivery.deliveryId,
      taskInferenceInputOperationId: id(509),
      committed: false,
      retiredReason: "canonical-input-replaced",
    },
  );
  const deleted = structuredClone(delivery);
  deleted.notification.taskDispatchFence.operationId = id(510);
  assert.deepEqual(
    await call("deleted canonical round retires captured delivery", deleted),
    {
      deliveryId: delivery.deliveryId,
      taskInferenceInputOperationId: receipt.operationId,
      committed: false,
      retiredReason: "canonical-input-deleted",
    },
  );
  assert.deepEqual(await state(), accepted);
  result.proofs.push(
    "Captured historical round results retain one original protected answer and history-only terminal across worker replacement/server restart, without changing the newer Task, released lane or dispatch state. SQL failure rolls back message and terminal together; changed outputs conflict and replaced/deleted canonical inputs retire without writes.",
  );
  return {
    content,
    storageSql,
    proveStored: async (value) => {
      assert.deepEqual(value, accepted);
      assert.deepEqual(value.task.protected_content, current.protectedContent);
      assert.equal(value.task.state, "draft");
      assert.equal(value.task.planning_round, 2);
      const answer = value.messages.find(
        (m) => m.id === relay.assistantMessage.id,
      );
      assert.equal(answer.role, "assistant");
      assert.equal(answer.mode, "default");
      assert.deepEqual(
        answer.task_protected_content,
        relay.assistantMessage.protectedContent,
      );
      await content.prove(value);
    },
  };
}
