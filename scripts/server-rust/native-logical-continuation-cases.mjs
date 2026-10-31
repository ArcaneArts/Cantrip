import assert from "node:assert/strict";
import { literal, json } from "./project-target-state.mjs";
export async function runContinuationCases({
  start,
  next,
  raw,
  unchanged,
  seed,
  snapshot,
  command,
  session,
  reopen,
}) {
  for (const failureKind of ["native-terminal", "turn/start", "thread/resume"])
    for (const status of [
      "accepted",
      "dispatched",
      "applied",
      "rejected",
      "uncertain",
    ]) {
      const c = await start({ dispatch: status !== "accepted" });
      await seed(`UPDATE native_commands SET status=${literal(status)}`);
      const terminal = failureKind === "native-terminal";
      const allowed = terminal
        ? ["dispatched", "applied", "uncertain"].includes(status)
        : failureKind === "turn/start"
          ? ["dispatched", "uncertain"].includes(status)
          : status === "accepted";
      const extra = terminal
        ? {}
        : {
            reason:
              failureKind === "thread/resume"
                ? "invalid-compaction"
                : "capacity",
            failure: {
              kind: "native-rejected",
              method: failureKind,
              code: -32000,
              runtimeGeneration: "runtime",
            },
          };
      const name = `continuation ${failureKind} after ${status}`;
      const action = () =>
        next(
          name,
          (i) => c.continuation(i, extra),
          allowed ? {} : { error: true, code: "stale-native-evidence" },
        );
      if (!allowed) {
        await unchanged(name, action);
        continue;
      }
      const results = await action();
      const states = await snapshot("atomic " + name);
      for (const [i, state] of states.entries()) {
        const previous = state.commands.find(
            (n) => n.operation_id === c.operationId,
          ),
          child = state.commands.find((n) => n.operation_id === "logical-next");
        assert.equal(previous.status, terminal ? "applied" : "rejected");
        assert.equal(
          previous.rejection_code,
          terminal ? null : "native-request-rejected",
        );
        assert.equal(previous.execution_completed_at, previous.updated_at);
        assert.equal(state.activations[0].created_at, previous.updated_at);
        assert.equal(child.logical_operation_id, c.operationId);
        assert.equal(child.logical_client_message_id, "logical-message");
        assert.equal(child.previous_operation_id, c.operationId);
        assert.equal(child.status, "accepted");
        assert.equal(child.execution_lane_id, previous.execution_lane_id);
        assert.equal(
          child.intent.continuation.reason,
          terminal ? "capacity" : extra.reason,
        );
        assert.equal(state.activations[0].operation_id, "logical-next");
        assert.equal(state.activations[0].native_turn_id, null);
        assert.equal(state.turns?.length ?? 0, terminal ? 1 : 0);
        assert.equal(results[i].replayed, undefined);
      }
      const replay = await unchanged("replay " + name, () =>
        next("replay " + name, (i) =>
          c.continuation(i, {
            ...extra,
            protectedPayload: {
              ...command().protectedPayload,
              ciphertext: Buffer.alloc(32, 3).toString("base64url"),
            },
            reason: "invalid-compaction",
          }),
        ),
      );
      for (const result of replay) {
        assert.equal(result.replayed, true);
        assert.ok(result.execution);
      }
    }
  let c = await start();
  await next("logical first child", c.continuation);
  let states = await snapshot("logical first child generations");
  const second = await next("logical second child", (i) =>
    c.continuation(i, {
      previousOperationId: "logical-next",
      previousOperationGeneration: states[i].commands.find(
        (n) => n.operation_id === "logical-next",
      ).operation_generation,
      operationId: "logical-third",
      failure: {
        kind: "native-rejected",
        method: "thread/resume",
        code: -1,
        runtimeGeneration: "runtime",
      },
      reason: "invalid-compaction",
    }),
  );
  for (const result of second)
    assert.equal(result.receipt.logicalOperationId, "logical-root");
  for (const change of [
    { payloadDigest: "c".repeat(64) },
    { rootOperationId: "missing" },
    { previousOperationId: "logical-third" },
    { session: { ...session, connectionId: "changed" } },
  ])
    await unchanged(
      "continuation replay identity " + JSON.stringify(change),
      () =>
        next(
          "continuation replay identity " + JSON.stringify(change),
          (i) => c.continuation(i, change),
          {
            error: true,
            code: change.previousOperationId
              ? "operation-not-found"
              : "operation-id-conflict",
          },
        ),
    );
  for (const [sql, code] of [
    [
      "UPDATE native_commands SET logical_operation_id=NULL",
      "invalid-continuation-lineage",
    ],
    [
      "UPDATE native_commands SET origin='terminal'",
      "invalid-continuation-lineage",
    ],
    [
      "UPDATE native_commands SET kind='control'",
      "invalid-continuation-lineage",
    ],
    [
      "UPDATE native_commands SET execution_lane_id=NULL",
      "invalid-continuation-lineage",
    ],
    [
      "UPDATE chats SET active_worktree_id='github-beta-main' WHERE id='chat'",
      "stale-session",
    ],
    [
      "UPDATE native_command_activations SET active=false",
      "stale-continuation",
    ],
    [
      "UPDATE native_command_activations SET logical_cancelled=true",
      "stale-continuation",
    ],
    [
      "UPDATE native_command_activations SET generation='old'",
      "stale-continuation",
    ],
    [
      "INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status) SELECT 'logical-other',owner_id,worker_id,chat_id,'other-generation',origin,method,kind,payload_digest,protected_payload,identity,intent,status FROM native_commands WHERE operation_id='logical-root'; UPDATE native_command_activations SET operation_id='logical-other'",
      "stale-continuation",
    ],
    [
      "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,created_at,updated_at) SELECT 'logical-other-lane',chat_id,worktree_id,worker_id,acquiring_actor,'released',created_at,updated_at FROM chat_execution_lanes WHERE state='active'; UPDATE native_command_activations SET execution_lane_id='logical-other-lane'",
      "stale-continuation",
    ],
    [
      "UPDATE chats SET automation_paused=true WHERE id='chat'",
      "stale-continuation",
    ],
    ["UPDATE chats SET status='idle' WHERE id='chat'", "stale-continuation"],
    [
      `UPDATE native_commands SET intent=${json({ permissionProfileId: ":other" })}`,
      "permission-profile-mismatch",
    ],
    [
      "UPDATE native_command_activations SET native_turn_id='other'",
      "stale-native-evidence",
    ],
  ]) {
    c = await start();
    await seed(sql.split("; "));
    await unchanged(sql, () =>
      next(sql, c.continuation, { error: true, code }),
    );
  }
  for (const extra of [
    { session: { ...session, threadId: null } },
    { session: { ...session, runtimeGeneration: null } },
    { session: { ...session, connectionId: null } },
    { session: { ...session, runtimeGeneration: "changed" } },
    { session: { ...session, connectionId: "changed" } },
    {
      failure: {
        kind: "native-terminal",
        nativeTurnId: "turn-one",
        runtimeGeneration: "other",
      },
    },
  ]) {
    c = await start();
    await unchanged("continuation prior session " + JSON.stringify(extra), () =>
      next(
        "continuation prior session " + JSON.stringify(extra),
        (i) => c.continuation(i, extra),
        { error: true, code: "stale-session" },
      ),
    );
  }
  c = await start();
  await seed(
    'UPDATE native_commands SET identity=identity || \'{"runtimeGeneration":null,"connectionId":null}\'::jsonb',
  );
  await next("nullable original runtime may bind continuation", (i) =>
    c.continuation(i, {
      failure: {
        kind: "native-rejected",
        method: "turn/start",
        code: -1,
        runtimeGeneration: "runtime",
      },
    }),
  );
  c = await start();
  await seed("UPDATE native_commands SET identity=identity-'connectionId'");
  await unchanged("missing prior runtime is not null", () =>
    next("missing prior runtime is not null", c.continuation, {
      error: true,
      code: "stale-session",
    }),
  );
  const handoff = {
    expectedThreadId: "thread",
    replacementThreadId: "replacement",
  };
  for (const extra of [
    { reason: "capacity" },
    { handoff: { ...handoff, expectedThreadId: "wrong" } },
    { handoff: { ...handoff, replacementThreadId: "thread" } },
    { session },
  ]) {
    c = await start();
    await unchanged("invalid handoff " + JSON.stringify(extra), () =>
      next(
        "invalid handoff " + JSON.stringify(extra),
        (i) =>
          c.continuation(i, {
            reason: "invalid-compaction",
            session: { ...session, threadId: "replacement" },
            handoff,
            ...extra,
          }),
        { error: true, code: "thread-identity-mismatch" },
      ),
    );
  }
  for (const sql of [
    null,
    "UPDATE chat_execution_lanes SET runtime_session_id=NULL",
    "UPDATE chat_execution_lanes SET codex_thread_id='stale'",
    "UPDATE chat_runtime_sessions SET codex_thread_id='stale'",
  ]) {
    c = await start();
    if (sql) await seed(sql.split("; "));
    const input = (i) =>
      c.continuation(i, {
        reason: "invalid-compaction",
        session: { ...session, threadId: "replacement" },
        handoff,
      });
    if (sql)
      await unchanged("atomic handoff rollback " + sql, () =>
        next("atomic handoff rollback " + sql, input, {
          error: true,
          code: sql.includes("chat_runtime_sessions")
            ? "thread-identity-mismatch"
            : "thread-handoff-failed",
        }),
      );
    else {
      await next("atomic compaction runtime and lane handoff", input);
      states = await snapshot(
        "handoff changes both thread holders and turn owner",
      );
      for (const state of states) {
        assert.equal(state.runtimes[0].codex_thread_id, "replacement");
        assert.equal(state.lanes[0].codex_thread_id, "replacement");
        assert.equal(state.turns[0].thread_id, "thread");
      }
    }
  }
  for (const table of ["chat_runtime_sessions", "chat_execution_lanes"]) {
    c = await start();
    await seed([
      `CREATE FUNCTION race_logical_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE ${table} SET codex_thread_id='stale' WHERE chat_id='chat'; RETURN NEW; END $$`,
      "CREATE TRIGGER race_logical_handoff AFTER UPDATE OF execution_completed_at ON native_commands FOR EACH ROW EXECUTE FUNCTION race_logical_handoff()",
    ]);
    await unchanged(
      "handoff CAS rollback after captured context " + table,
      () =>
        next(
          "handoff CAS rollback after captured context " + table,
          (i) =>
            c.continuation(i, {
              reason: "invalid-compaction",
              session: { ...session, threadId: "replacement" },
              handoff,
            }),
          { error: true, code: "thread-handoff-failed" },
        ),
    );
    await seed([
      "DROP TRIGGER race_logical_handoff ON native_commands",
      "DROP FUNCTION race_logical_handoff()",
    ]);
  }
  c = await start();
  await next("replay current activation fixture", c.continuation);
  await seed("UPDATE native_command_activations SET logical_cancelled=true");
  for (const result of await unchanged(
    "cancelled child replay has no execution",
    () => next("cancelled child replay has no execution", c.continuation),
  )) {
    assert.equal(result.replayed, true);
    assert.equal(result.execution, null);
  }
  // Persist a complete retry chain through actual process restarts.
  c = await start();
  await next("persist logical chain before reopen", c.continuation);
  await reopen("logical continuation chain persists");
  for (const result of await next(
    "continuation replay after process restart",
    c.continuation,
  ))
    assert.equal(result.replayed, true);
}
