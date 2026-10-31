import assert from "node:assert/strict";
import { command } from "./native-command-admission-cases.mjs";
import {
  eventMessage,
  eventPlan,
  taskEventMessage,
} from "./native-event-fixtures.mjs";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import {
  protectedInteraction,
  protectedInteractionResponse,
} from "./agent-interaction-fixtures.mjs";
export async function runNativeEventContextCases(h) {
  const { observe, reset, seed, snapshot } = h;
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  let receipt;
  async function setup(dispatch = true) {
    await reset();
    await seed([
      "DELETE FROM chat_messages",
      "UPDATE chats SET experience='agent',protected_plan=NULL,has_pending_plan_question=false WHERE id='chat'",
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('native-event-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    ]);
    receipt = await observe(
      "event operation admission",
      command({ operationId: "event-operation", session }),
    );
    if (dispatch)
      await observe(
        "event operation dispatch",
        (i) => ({
          workerId: "alpha",
          operationId: "event-operation",
          operationGeneration: receipt[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
  }
  const call = async (name, changes = {}, options = {}) => {
    const result = await observe(
      name,
      (i) => ({
        worker: "alpha",
        operation: "event-operation",
        generation: receipt[i].receipt.operationGeneration,
        action: "context",
        ...(typeof changes === "function" ? changes(i) : changes),
      }),
      { op: "native-command-event-context", shape: "raw", ...options },
    );
    await snapshot("event persisted " + name);
    return result;
  };
  async function unchanged(name, run) {
    const before = await snapshot("before " + name);
    const result = await run();
    assert.deepEqual(await snapshot("unchanged " + name), before, name);
    return result;
  }
  await setup(false);
  await unchanged("accepted operation cannot publish", () =>
    call(
      "accepted operation cannot publish",
      {},
      { error: true, code: "stale-operation-event" },
    ),
  );
  await setup();
  const context = await call("dispatched writer event context");
  for (const c of context) {
    assert.equal(c.chatId, "chat");
    assert.equal(c.workerId, "alpha");
    assert.ok(c.executionLaneId);
  }
  await unchanged("cross-tenant event", () =>
    call(
      "cross-tenant event",
      {},
      { requestOwner: otherOwner, error: true, code: "operation-not-found" },
    ),
  );
  await unchanged("wrong event worker", () =>
    call(
      "wrong event worker",
      { worker: "beta" },
      { error: true, code: "operation-not-found" },
    ),
  );
  for (const status of ["applied", "uncertain"]) {
    await seed(
      `UPDATE native_commands SET status=${literal(status)} WHERE operation_id='event-operation'`,
    );
    await call("event permits " + status);
  }
  for (const [name, sql] of [
    [
      "terminal rejection",
      "UPDATE native_commands SET status='rejected' WHERE operation_id='event-operation'",
    ],
    [
      "non-start command",
      "UPDATE native_commands SET kind='query' WHERE operation_id='event-operation'",
    ],
    [
      "inactive activation",
      "UPDATE native_command_activations SET active=false WHERE chat_id='chat'",
    ],
    [
      "superseded activation",
      "UPDATE native_command_activations SET generation='different' WHERE chat_id='chat'",
    ],
    ...[
      "placementId",
      "projectId",
      "contextKind",
      "modelRouteId",
      "providerAccountId",
    ].map((key) => [
      "mismatched " + key,
      `UPDATE native_commands SET identity=jsonb_set(identity,ARRAY[${literal(key)}],${json("different")}) WHERE operation_id='event-operation'`,
    ]),
  ]) {
    await setup();
    await seed(sql);
    await unchanged(name, () =>
      call(name, {}, { error: true, code: "stale-operation-event" }),
    );
  }
  await setup();
  await seed(
    'UPDATE native_commands SET identity=identity||\'{"threadId":"old-thread","runtimeGeneration":"old-runtime","connectionId":"old-connection"}\'::jsonb WHERE operation_id=\'event-operation\'',
  );
  await call("event guard preserves source placement and route scope");
  await setup();
  const saved = await call("encrypted message and plan commit together", {
    action: "write",
    message: eventMessage,
    plan: eventPlan,
  });
  for (const r of saved) {
    assert.equal(r.saved.id, eventMessage.id);
    assert.equal(r.saved.executionLaneId, r.context.executionLaneId);
  }
  const committed = await snapshot("actual event message and plan state");
  for (const s of committed) {
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].content, null);
    assert.equal(
      s.chats.find((c) => c.id === "chat").protected_plan.classification
        .hasQuestion,
      true,
    );
  }
  const nested = await call(
    "caught nested SQL write failure preserves outer transaction",
    {
      action: "nested-error",
      message: { ...eventMessage, idempotencyKey: "duplicate-id" },
      plan: { ...eventPlan, classification: { hasQuestion: false } },
    },
  );
  for (const r of nested) assert.equal(r.nestedRejected, true);
  await unchanged("outer callback rejection rolls back message and plan", () =>
    call(
      "outer callback rejection rolls back message and plan",
      {
        action: "rollback",
        message: {
          ...eventMessage,
          id: "456789ab-1234-4234-8234-000000000099",
          idempotencyKey: "rollback-message",
        },
        plan: eventPlan,
      },
      { error: true, code: "fixture-native-event-rollback" },
    ),
  );
  await call("encrypted event update retains its original row", {
    action: "write",
    message: {
      ...eventMessage,
      classification: { ...eventMessage.classification, role: "assistant" },
    },
  });
  await h.reopen("native event message and plan transaction survives restart");
  await call("read event context after actual restart");
  await setup();
  await seed("UPDATE chats SET experience='task' WHERE id='chat'");
  const task = await call("legacy Task event uses transaction-bound writer", {
    action: "task",
    message: taskEventMessage,
  });
  for (const r of task) assert.equal(r.saved.id, taskEventMessage.id);
  await setup();
  await seed("DELETE FROM agent_interaction_requests");
  const interaction = (i, key) =>
    protectedInteraction(key, {
      provenance: {
        ...protectedInteraction().provenance,
        executionLaneId: receipt[i].receipt.executionLaneId,
      },
    });
  const request = await call(
    "event transaction records encrypted interaction and plan",
    (i) => ({
      action: "interaction",
      interaction: interaction(i, "event-interaction"),
      plan: eventPlan,
    }),
  );
  for (const row of request) assert.equal(row.saved.status, "pending");
  await unchanged("event rollback discards interaction and plan change", () =>
    call(
      "event rollback discards interaction and plan change",
      (i) => ({
        action: "interaction-rollback",
        interaction: interaction(i, "event-discarded"),
        plan: { ...eventPlan, classification: { hasQuestion: false } },
      }),
      { error: true, code: "fixture-native-event-rollback" },
    ),
  );
  const terminal = await call(
    "event transaction resolves encrypted interaction",
    {
      action: "interaction-terminal",
      key: "event-interaction",
      status: "interrupted",
      resolution: protectedInteractionResponse,
    },
  );
  for (const row of terminal) assert.equal(row.saved.status, "resolved");
  await h.reopen("native event interaction transaction survives restart");
  await seed("DELETE FROM agent_interaction_requests");
}
