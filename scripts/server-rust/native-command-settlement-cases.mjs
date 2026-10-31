import assert from "node:assert/strict";
import { nativeCommandSettlementSchema } from "../../packages/protocol/dist/index.js";
import { literal, stamp } from "./project-target-state.mjs";
import { pendingId } from "./native-settlement-fixtures.mjs";
import { runDeferralCases } from "./native-command-deferral-cases.mjs";
import { runQueueSettlementCases } from "./native-command-queue-settlement-cases.mjs";
import { runRecoveryCases } from "./native-command-recovery-cases.mjs";
export async function runSettlementCases(h) {
  const { seed, observe, snapshot, reset, command } = h;
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  const settle = (name, input, expected = {}) =>
    observe(name, input, {
      op: "native-command-settle",
      shape: "receipt",
      status: "applied",
      ...expected,
    });
  async function start({
    dispatch = true,
    origin = "gui",
    operationId = "request",
    intent = {},
    method = "turn/start",
    queueClaim,
    beforeAdmission,
  } = {}) {
    await reset();
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('settlement-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
    if (beforeAdmission) await beforeAdmission();
    const admitted = await observe(
      "settlement fixture admission",
      command({
        session,
        origin,
        operationId,
        intent,
        method,
        ...(queueClaim ? { queueClaim } : {}),
      }),
      { options: { clientMessageId: pendingId } },
    );
    if (dispatch)
      await observe(
        "settlement fixture dispatch",
        (i) => ({
          workerId: "alpha",
          operationId,
          operationGeneration: admitted[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
    const input = (i, extra = {}) =>
      nativeCommandSettlementSchema.parse({
        workerId: "alpha",
        operationId,
        operationGeneration: admitted[i].receipt.operationGeneration,
        status: "applied",
        resultDigest: "d".repeat(64),
        protectedResult: command().protectedPayload,
        rejectionCode: null,
        ...extra,
      });
    return { admitted, input, session };
  }
  async function unchanged(name, input, expected = {}) {
    const before = await snapshot("before " + name);
    await settle(name, input, { error: true, ...expected });
    assert.deepEqual(
      await snapshot("settlement rollback " + name),
      before,
      name,
    );
  }
  for (const current of [
    "accepted",
    "dispatched",
    "applied",
    "rejected",
    "uncertain",
  ])
    for (const status of ["applied", "rejected", "uncertain"])
      for (const complete of [false, true]) {
        const c = await start({ dispatch: current !== "accepted" });
        await seed(`UPDATE native_commands SET status=${literal(current)}`);
        const name = `settle ${current} to ${status} complete=${complete}`;
        const code =
          (current === "rejected" && status !== "rejected") ||
          (current === "applied" && status !== "applied")
            ? "receipt-conflict"
            : current === "uncertain" && status !== "uncertain"
              ? "native-evidence-required"
              : current === "accepted" && status === "applied"
                ? "operation-not-dispatched"
                : null;
        const input = (i) =>
          c.input(i, { status, executionComplete: complete });
        if (code) await unchanged(name, input, { code });
        else {
          const results = await settle(name, input, { status });
          const states = await snapshot("committed " + name);
          for (const state of states) {
            assert.equal(state.commands[0].status, status);
            assert.equal(state.commands[0].result_digest, "d".repeat(64));
            assert.deepEqual(
              state.commands[0].protected_result,
              command().protectedPayload,
            );
            assert.equal(!!state.commands[0].execution_completed_at, complete);
            assert.equal(state.activations[0].active, !complete);
            assert.equal(
              state.lanes[0].state,
              complete ? "suspended" : "active",
            );
            assert.equal(
              state.leases[0].state,
              complete ? "released" : "active",
            );
          }
          if (complete) {
            const replay = await settle("completed replay " + name, input, {
              status,
            });
            for (const [i, value] of replay.entries())
              assert.deepEqual(value, results[i]);
            assert.deepEqual(
              await snapshot("completed replay no writes " + name),
              states,
            );
          }
        }
      }
  let c = await start();
  await unchanged(
    "terminal result requires completion",
    (i) =>
      c.input(i, {
        terminalResult: {
          resultDigest: "e".repeat(64),
          protectedResult: command().protectedPayload,
        },
      }),
    { code: "terminal-result-requires-completion" },
  );
  await settle(
    "unacknowledged result remains uncertain",
    (i) =>
      c.input(i, {
        status: "uncertain",
        resultDigest: null,
        protectedResult: null,
      }),
    { status: "uncertain" },
  );
  await unchanged("uncertainty requires native evidence", (i) => c.input(i), {
    code: "native-evidence-required",
  });
  const reconciled = await settle(
    "native reconciliation completes exact activation",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
        },
      }),
  );
  let state = await snapshot(
    "native reconciliation stores observed turn and retires activation",
  );
  for (const value of state) {
    assert.equal(value.commands[0].terminal_evidence.kind, "terminal");
    assert.equal(value.activations[0].native_turn_id, "turn-one");
    assert.equal(value.activations[0].active, false);
  }
  for (const changes of [
    { resultDigest: "e".repeat(64) },
    {
      reconciliation: {
        nativeTurnId: "other-turn",
        runtimeGeneration: "runtime",
      },
    },
    { status: "rejected" },
  ])
    await unchanged(
      "completed receipt conflict " + JSON.stringify(changes),
      (i) => c.input(i, { executionComplete: true, ...changes }),
      { code: "receipt-conflict" },
    );
  const minimal = await settle(
    "completed receipt accepts omitted evidence",
    (i) =>
      c.input(i, {
        executionComplete: true,
        resultDigest: null,
        protectedResult: null,
      }),
  );
  for (const [i, value] of minimal.entries())
    assert.deepEqual(value, reconciled[i]);
  assert.deepEqual(
    await snapshot("minimal completion replay has no writes"),
    state,
  );
  const successor = await observe(
    "admit successor sharing native thread",
    command({ operationId: "successor", session }),
  );
  await observe(
    "dispatch successor sharing native thread",
    (i) => ({
      workerId: "alpha",
      operationId: "successor",
      operationGeneration: successor[i].receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      session,
    }),
    { op: "native-command-dispatch", status: "dispatched" },
  );
  await unchanged(
    "observed native turn has one durable root owner",
    (i) => ({
      ...c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
        },
      }),
      operationId: "successor",
      operationGeneration: successor[i].receipt.operationGeneration,
    }),
    { sqlstate: "23505" },
  );

  c = await start();
  await settle("record original prefix", (i) => c.input(i));
  const other = {
    ...command().protectedPayload,
    ciphertext: Buffer.alloc(32, 9).toString("base64url"),
  };
  await settle("complete with immutable prefix and terminal result", (i) =>
    c.input(i, {
      executionComplete: true,
      protectedResult: other,
      terminalResult: { resultDigest: "e".repeat(64), protectedResult: other },
    }),
  );
  state = await snapshot(
    "prefix and terminal ciphertext retained independently",
  );
  for (const value of state) {
    assert.deepEqual(
      value.commands[0].protected_result,
      command().protectedPayload,
    );
    assert.deepEqual(value.commands[0].protected_terminal_result, other);
  }
  await settle("same terminal digest cannot replace captured ciphertext", (i) =>
    c.input(i, {
      executionComplete: true,
      terminalResult: {
        resultDigest: "e".repeat(64),
        protectedResult: command().protectedPayload,
      },
    }),
  );
  assert.deepEqual(
    await snapshot("terminal ciphertext immutable replay"),
    state,
  );
  await unchanged(
    "terminal digest conflict",
    (i) =>
      c.input(i, {
        executionComplete: true,
        terminalResult: {
          resultDigest: "f".repeat(64),
          protectedResult: other,
        },
      }),
    { code: "receipt-conflict" },
  );
  for (const changes of [
    { operationGeneration: "wrong" },
    { workerId: "beta" },
    { operationId: "missing" },
  ])
    await unchanged(
      "settlement ownership fence " + JSON.stringify(changes),
      (i) => c.input(i, changes),
      { code: "operation-not-found" },
    );

  c = await start();
  for (const changes of [
    { runtimeGeneration: "old" },
    { nativeTurnId: "wrong", runtimeGeneration: "old" },
  ])
    await unchanged(
      "native reconciliation runtime fence " + JSON.stringify(changes),
      (i) =>
        c.input(i, {
          executionComplete: true,
          reconciliation: { nativeTurnId: "turn-one", ...changes },
        }),
      { code: "stale-native-evidence" },
    );
  await seed(
    "UPDATE native_command_activations SET native_turn_id='already-observed'",
  );
  await unchanged(
    "reconciliation turn fence",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "different",
          runtimeGeneration: "runtime",
        },
      }),
    { code: "stale-native-evidence" },
  );
  c = await start({
    origin: "autonomous",
    operationId: "native:runner:attempt",
    intent: { expectedTurnId: "turn-one" },
  });
  await settle(
    "declined autonomous attempt",
    (i) =>
      c.input(i, {
        status: "rejected",
        executionComplete: true,
        decline: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
          runnerGeneration: "runner",
          attemptId: "attempt",
        },
      }),
    { status: "rejected" },
  );
  state = await snapshot("decline is exact terminal evidence");
  for (const value of state)
    assert.equal(value.commands[0].terminal_evidence.kind, "declined");
  c = await start({
    origin: "autonomous",
    operationId: "native:runner:attempt",
    intent: { expectedTurnId: "turn-one" },
  });
  for (const changes of [
    { attemptId: "other" },
    { runnerGeneration: "other" },
    { nativeTurnId: "other" },
    { runtimeGeneration: "old" },
  ])
    await unchanged(
      "autonomous decline fence " + JSON.stringify(changes),
      (i) =>
        c.input(i, {
          status: "rejected",
          executionComplete: true,
          decline: {
            nativeTurnId: "turn-one",
            runtimeGeneration: "runtime",
            runnerGeneration: "runner",
            attemptId: "attempt",
            ...changes,
          },
        }),
      { code: "stale-native-evidence" },
    );
  c = await start();
  await seed(
    "UPDATE native_command_activations SET runtime_generation='claim-runtime'",
  );
  await unchanged(
    "observed turn must match stored session runtime",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "claim-runtime",
        },
      }),
    { code: "native-turn-association-mismatch" },
  );
  c = await start();
  await settle(
    "remember observed turn before conflicting evidence",
    (i) =>
      c.input(i, {
        status: "uncertain",
        resultDigest: null,
        protectedResult: null,
        reconciliation: {
          nativeTurnId: "original-turn",
          runtimeGeneration: "runtime",
        },
      }),
    { status: "uncertain" },
  );
  await seed("UPDATE native_command_activations SET native_turn_id=NULL");
  await unchanged(
    "stored turn association cannot be replaced",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "other-turn",
          runtimeGeneration: "runtime",
        },
      }),
    { code: "native-turn-association-conflict" },
  );
  c = await start();
  await seed(
    "CREATE FUNCTION suppress_settlement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$",
  );
  await seed(
    "CREATE TRIGGER suppress_settlement BEFORE UPDATE ON native_commands FOR EACH ROW EXECUTE FUNCTION suppress_settlement()",
  );
  await unchanged(
    "suppressed receipt update rolls back turn and activation",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
        },
      }),
  );
  await seed("DROP TRIGGER suppress_settlement ON native_commands");
  await seed("DROP FUNCTION suppress_settlement()");
  for (const [table, event, condition] of [
    ["native_command_turns", "INSERT", ""],
    ["native_commands", "UPDATE", ""],
    ["chat_execution_lanes", "UPDATE", ""],
    ["native_command_activations", "UPDATE", "WHEN (NEW.active=false)"],
  ]) {
    c = await start();
    await seed(
      "CREATE FUNCTION fail_settlement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'settlement fixture failure'; END$$",
    );
    await seed(
      `CREATE TRIGGER fail_settlement BEFORE ${event} ON ${table} FOR EACH ROW ${condition} EXECUTE FUNCTION fail_settlement()`,
    );
    await unchanged(
      "settlement rollback after failure on " + table,
      (i) =>
        c.input(i, {
          executionComplete: true,
          reconciliation: {
            nativeTurnId: "turn-one",
            runtimeGeneration: "runtime",
          },
        }),
      { sqlstate: "P0001" },
    );
    await seed(`DROP TRIGGER fail_settlement ON ${table}`);
    await seed("DROP FUNCTION fail_settlement()");
  }
  await runDeferralCases({ ...h, start, settle, unchanged, session });
  await runQueueSettlementCases({ ...h, start, settle, unchanged, session });
  await runRecoveryCases({ ...h, start, settle, unchanged, session });
  c = await start({
    method: "thread/settings/update",
    intent: {
      nativeSettingsOperationId: "native-settings",
      settingKeys: ["model"],
    },
  });
  await settle(
    "settings RPC acknowledgment lost",
    (i) =>
      c.input(i, {
        status: "uncertain",
        resultDigest: null,
        protectedResult: null,
      }),
    { status: "uncertain" },
  );
  let settingsState = await snapshot("uncertain settings transport");
  for (const value of settingsState)
    assert.equal(value.settings[0].state.desiredStatus, "uncertain");
  await observe(
    "native settings application arrives after lost acknowledgment",
    (i) => ({
      input: {
        workerId: "alpha",
        operationId: "request",
        operationGeneration: c.admitted[i].receipt.operationGeneration,
        eventId: "56789abc-1234-4234-8234-000000000001",
        threadId: "thread",
        runtimeGeneration: "runtime",
        nativeOperationId: "native-settings",
        submissionId: "submission",
        kind: "applied",
        resultDigest: "e".repeat(64),
        protectedResult: command().protectedPayload,
      },
    }),
    { op: "native-command-evidence", shape: "raw" },
  );
  const retainedApplication = await settle(
    "later lost acknowledgment retains native applied evidence",
    (i) =>
      c.input(i, {
        status: "uncertain",
        resultDigest: null,
        protectedResult: null,
      }),
    { status: "uncertain" },
  );
  for (const value of retainedApplication)
    assert.equal(value.settingsApplication.status, "applied");
  settingsState = await snapshot(
    "native application survives transport uncertainty",
  );
  for (const value of settingsState) {
    assert.equal(value.commands[0].status, "uncertain");
    assert.equal(value.settings[0].state.desiredStatus, "applied");
    assert.equal(value.settings[0].state.pending.length, 0);
  }
  await unchanged(
    "settings facts do not invent a transport acknowledgment",
    (i) => c.input(i),
    { code: "native-evidence-required" },
  );
  const durable = await observe(
    "admit durable turn before storage reopen",
    command({
      operationId: "durable-root",
      session,
      intent: { expectedTurnId: "durable-turn" },
    }),
  );
  await observe(
    "dispatch durable turn before storage reopen",
    (i) => ({
      workerId: "alpha",
      operationId: "durable-root",
      operationGeneration: durable[i].receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      session,
    }),
    { op: "native-command-dispatch", status: "dispatched" },
  );
  await settle("settle durable turn before storage reopen", (i) => ({
    ...c.input(i, {
      executionComplete: true,
      reconciliation: {
        nativeTurnId: "durable-turn",
        runtimeGeneration: "runtime",
      },
    }),
    operationId: "durable-root",
    operationGeneration: durable[i].receipt.operationGeneration,
  }));
  const durableState = await snapshot(
    "completed turns and immutable native facts coexist",
  );
  for (const value of durableState) {
    assert.equal(value.turns.length, 1);
    assert.equal(value.turns[0].turn_id, "durable-turn");
    assert.equal(value.evidence.length, 1);
  }
  await h.reopen("actual receipt turn queue and settings storage reopen");
  return { start, settle, unchanged, session };
}
