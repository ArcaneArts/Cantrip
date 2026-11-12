// Actual canonical input transactions, opaque response identity and SQL rollback.
import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskMessage, taskEnvelope } from "./task-wire-fixtures.mjs";
import { nativeHistoryPayloadDigest } from "../../tests/reference-node-server/src/db/repository/native-history-digest.ts";
import { runTaskGoalCyclePublicationCases } from "./task-goal-cycle-publication-cases.mjs";

function goalPublicationComparison({
  finalizedMessageId,
  autonomousWake,
} = {}) {
  return (state, peer) => {
    const messages =
      state.messages?.map(({ task_output_finalized, ...message }) => {
        // Migration 0287 adds a private Rust marker for the settled native output.
        assert.equal(
          task_output_finalized,
          peer === 1 && message.id === finalizedMessageId,
          `Goal output finalization for message ${message.id} on ${peer === 1 ? "Rust" : "Node"}`,
        );
        return message;
      }) ?? state.messages;
    const wake = state.queues?.find((queue) => queue.chat_id === "task");
    if (!autonomousWake || peer === 0) {
      assert.equal(wake, undefined);
      return { ...state, messages };
    }
    // The terminal receipt and its pending projection wake commit together.
    assert.ok(wake);
    const { notification_due_at, ...stateFields } = wake;
    assert.ok(Number.isFinite(Date.parse(notification_due_at)));
    assert.deepEqual(stateFields, {
      chat_id: "task",
      revision: 1,
      notified_revision: -1,
      goal_recovery: null,
    });
    const queues = state.queues.filter((queue) => queue !== wake);
    return { ...state, messages, queues: queues.length ? queues : null };
  };
}

export async function runTaskResponsePublicationCases(h, finalized, operation) {
  const id = (n) => `92929292-9292-4929-8929-${String(n).padStart(12, "0")}`;
  const cycle = id(1),
    lane = id(2),
    user = id(3);
  const native = {
    threadId: "publication-thread",
    turnId: "publication-turn",
    scopeId: "publication-scope",
  };
  const receipt = {
    kind: "goal",
    operationId: id(4),
    chatId: "task",
    clientMessageId: user,
    workerId: "alpha",
    worktreeId: "github-alpha-main",
    executionLaneId: lane,
    executionLaneActivatedAt: stamp,
    providerId: "goal-provider",
    modelRouteId: "goal-route",
    providerAccountId: null,
    dispatch: {
      cycleId: cycle,
      operationId: operation,
      leaseOwner: "publication-owner",
      fencingToken: 7,
    },
  };
  const publication = { id: id(5), idempotencyKey: `assistant:${user}` };
  const input = {
    receipt,
    publication,
    nativeExecution: native,
    nativeOwner: { workerGeneration: id(6), runtimeGeneration: id(7) },
    accepted: true,
    dispatched: true,
    allAttemptsEnforced: true,
    firstDispatchedOperationId: receipt.operationId,
    multipleDispatched: false,
    deferred: false,
    attemptCountBefore: 0,
  };
  const response = (
    key = "agent-message:publication-turn:publication-thread:publication-turn:item",
  ) => ({
    ...taskMessage("assistant", "goal", id(8)),
    idempotencyKey: key,
  });
  const notification = (message = response()) => ({
    type: "chat.turn.outcome",
    chatId: "task",
    clientMessageId: user,
    executionLaneId: lane,
    worktreeId: receipt.worktreeId,
    contextKind: "project",
    scratchRootId: null,
    taskDispatchFence: receipt.dispatch,
    taskInferenceInputOperationId: receipt.operationId,
    outcome: {
      ok: true,
      result: {
        threadId: native.threadId,
        turnId: native.turnId,
        status: "completed",
        text: "",
        structuredResult: { message },
      },
    },
  });
  const run = (name, note, fields = {}, options = {}) =>
    h.observe(
      name,
      {
        chat: "task",
        action: "goal-input-outcome",
        worker: "alpha",
        notification: note,
        recordOnly: true,
        ...fields,
      },
      { op: "native-command-task", shape: "raw", ...options },
    );
  const rows = (name, expected) =>
    h.observe(
      name,
      {
        sql: "SELECT jsonb_build_object('task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id='task'),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q WHERE chat_id='task')) result",
      },
      {
        op: "query-json",
        shape: "raw",
        comparisonValue: goalPublicationComparison(expected),
      },
    );
  const reopen = async (name, expected) => {
    const compare = goalPublicationComparison(expected);
    await h.reopen(name, compare);
    return compare;
  };
  async function clean(historical = false) {
    await finalized();
    for (const value of await h.observe(
      "activate finalized Task for publisher checks",
      { chat: "task", action: "finalize", operation },
      { op: "native-command-task", shape: "raw" },
    ))
      assert.equal(value.value.task.state, "implementing");
    await h.seed([
      "DELETE FROM managed_queue_states WHERE chat_id='task'",
      "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main',status='running',native_suspension_state=NULL WHERE id='task'",
      `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,exclusive,purpose,state,activated_at,created_at,updated_at) VALUES('${lane}','task','alpha','github-alpha-main','agent',false,'Publisher recovery','active',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,task_protected_content,task_goal_input,idempotency_key,created_at) VALUES('${user}','task','github-alpha-main','${lane}','user','goal',${json(taskEnvelope)},${json(input)},'publication-user',${literal(stamp)})`,
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,lease_owner,fencing_token,goal_input,physical_worker_id,worktree_id,codex_thread_id,turn_id,model_route_id,lease_expires_at,started_at,fifo_created_at,created_at,updated_at) VALUES('${cycle}',${literal(h.owner)},'task',${literal(operation)},'finalize','running','publication-owner',7,${json(input)},'alpha','github-alpha-main',${literal(native.threadId)},${literal(native.turnId)},'goal-route','2099-01-01T00:00:00.000Z',${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    ]);
    if (historical) await h.seed("DELETE FROM task_dispatch_cycles");
  }
  for (const historical of [false, true]) {
    for (const key of [
      publication.idempotencyKey,
      "agent-message:root:publication-turn:item",
      response().idempotencyKey,
    ]) {
      await clean(historical);
      const message =
        key === publication.idempotencyKey
          ? { ...response(key), id: publication.id }
          : response(key);
      const finalizedMessageId =
        !historical && key !== publication.idempotencyKey
          ? message.id
          : undefined;
      const before = await rows(
        "before canonical Goal response " + historical + key,
      );
      for (const { value } of await run(
        "accept canonical Goal response " + historical + key,
        notification(message),
      )) {
        assert.equal(value.terminal.ok, true);
        assert.equal(value.message.id, message.id);
        assert.equal(
          value.terminal.outcomeDigest,
          nativeHistoryPayloadDigest(message),
        );
        assert.equal(value.historyOnly, historical);
      }
      const accepted = await rows(
        "after canonical Goal response " + historical + key,
        { finalizedMessageId },
      );
      for (const [i, row] of accepted.entries()) {
        assert.deepEqual(row.task, before[i].task);
        assert.deepEqual(row.lanes, before[i].lanes);
        assert.equal(row.messages.filter((m) => m.id === message.id).length, 1);
      }
      await run(
        "exact canonical Goal response replay " + historical + key,
        notification(message),
      );
      assert.deepEqual(
        await rows("after exact Goal response replay " + historical + key, {
          finalizedMessageId,
        }),
        accepted,
      );
      for (const changed of [
        { ...message, id: id(9) },
        {
          ...message,
          idempotencyKey: "agent-message:root:publication-turn:other-item",
          id: id(9),
        },
        {
          ...message,
          protectedContent: {
            ...message.protectedContent,
            envelope: {
              ...message.protectedContent.envelope,
              ciphertext: "AQAAAAAAAAAAAAAAAAAAAA",
            },
          },
        },
      ]) {
        for (const { value } of await run(
          "reject replacement of pinned Goal response " + historical + key,
          notification(changed),
        ))
          assert.equal(value.conflict, "stale-lease");
        assert.deepEqual(
          await rows(
            "changed Goal response rolls back exactly " + historical + key,
            { finalizedMessageId },
          ),
          accepted,
        );
      }
    }
    for (const key of [
      "agent-message:publication-turn:child:publication-turn:item",
      "agent-message:root:old:item",
      "agent-message:root:publication-turn:",
    ]) {
      await clean(historical);
      for (const { value } of await run(
        "reject child/stale/empty Goal publisher " + historical + key,
        notification(response(key)),
      )) {
        assert.equal(value.terminal.ok, false);
        assert.equal(value.message, null);
      }
      for (const row of await rows(
        "invalid Goal publisher has no answer " + historical + key,
      ))
        assert.equal(
          row.messages.some((m) => m.id === id(8)),
          false,
        );
    }
    await clean(historical);
    const before = await rows(
      "before wrong Goal publisher authority " + historical,
    );
    for (const fields of [
      { worker: "beta" },
      { notification: { ...notification(), executionLaneId: id(20) } },
      {
        notification: {
          ...notification(),
          taskDispatchFence: { ...receipt.dispatch, fencingToken: 8 },
        },
      },
    ]) {
      for (const { value } of await run(
        "reject wrong Goal publisher authority " + historical,
        notification(),
        fields,
      ))
        assert.equal(value.conflict, "stale-lease");
      assert.deepEqual(
        await rows("wrong Goal authority leaves exact state " + historical),
        before,
      );
    }
    for (const { value } of await run(
      "another owner cannot publish Goal response " + historical,
      notification(),
      { owner: otherOwner },
    ))
      assert.equal(value, null);
    assert.deepEqual(
      await rows("another owner leaves exact Goal state " + historical),
      before,
    );
    await clean(historical);
    const legacy = {
      ...input,
      terminal: {
        ok: true,
        failureKind: null,
        observedAt: stamp,
        projectedAt: null,
        threadId: native.threadId,
        turnId: native.turnId,
      },
    };
    await h.seed([
      `UPDATE chat_messages SET task_goal_input=${json(legacy)} WHERE id='${user}'`,
      `UPDATE task_dispatch_cycles SET goal_input=${json(legacy)} WHERE id='${cycle}'`,
      `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,task_protected_content,idempotency_key,created_at) VALUES('${publication.id}','task','github-alpha-main','${lane}','assistant','goal',${json(taskEnvelope)},${literal(publication.idempotencyKey)},${literal(stamp)})`,
    ]);
    const oldRows = await rows(
      "before legacy terminal publisher replay " + historical,
    );
    for (const { value } of await run(
      "legacy terminal cannot switch to native publisher " + historical,
      notification(),
    ))
      assert.equal(value.conflict, "stale-lease");
    assert.deepEqual(
      await rows(
        "legacy terminal rejected publisher preserves exact state " +
          historical,
      ),
      oldRows,
    );
    for (const { value } of await run(
      "legacy assigned publisher remains replayable " + historical,
      notification({
        ...response(publication.idempotencyKey),
        id: publication.id,
      }),
    )) {
      assert.equal(value.terminal.ok, true);
      assert.equal(value.terminal.outcomeDigest, undefined);
      assert.equal(value.message.id, publication.id);
    }
    assert.deepEqual(
      await rows("legacy assigned replay preserves exact state " + historical),
      oldRows,
    );
  }
  await clean();
  const before = await rows("before forced terminal publisher SQL failure");
  await h.seed([
    "CREATE FUNCTION fail_goal_publisher_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.goal_input->'terminal' IS NOT NULL THEN RAISE EXCEPTION 'actual Goal publisher terminal write failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fail_goal_publisher_terminal BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION fail_goal_publisher_terminal()",
  ]);
  await run(
    "actual terminal SQL failure rolls back appended Goal response",
    notification(),
    {},
    { error: true, sqlstate: "P0001" },
  );
  assert.deepEqual(
    await rows("Goal response and terminal rolled back together"),
    before,
  );
  await h.seed([
    "DROP TRIGGER fail_goal_publisher_terminal ON task_dispatch_cycles",
    "DROP FUNCTION fail_goal_publisher_terminal()",
  ]);
  await run(
    "same Goal response succeeds after actual SQL failure",
    notification(),
  );
  await reopen("canonical Goal response and digest survive restart", {
    finalizedMessageId: response().id,
  });
  return runTaskGoalCyclePublicationCases({
    h,
    clean,
    receipt,
    native,
    rows,
    reopen,
    id,
  });
}
