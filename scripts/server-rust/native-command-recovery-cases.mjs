import assert from "node:assert/strict";
import { otherOwner } from "./project-target-state.mjs";
export async function runRecoveryCases({
  seed,
  observe,
  snapshot,
  command,
  start,
  settle,
  session,
}) {
  const capture = (name, extra = {}) =>
    observe(
      name,
      { chat: "chat", ...extra },
      { op: "native-command-recovery-context", shape: "raw" },
    );
  const observed = {
    threadId: "thread",
    runtimeGeneration: "replacement-runtime",
    turnId: "turn-one",
    status: "completed",
  };
  const recover = (name, expected, extra = {}, options = {}) =>
    observe(
      name,
      (i) => ({
        worker: "alpha",
        expected: expected[i],
        observed: { ...observed, ...extra },
      }),
      { op: "native-command-recover", shape: "raw", ...options },
    );
  async function unchanged(name, fn) {
    const before = await snapshot("before " + name);
    const result = await fn();
    assert.deepEqual(await snapshot("recovery unchanged " + name), before);
    return result;
  }
  let c = await start();
  for (const value of await capture("recovery requires assigned native turn"))
    assert.equal(value, null);
  for (const extra of [{ chat: "missing" }, { owner: otherOwner }])
    await observe(
      "recovery context ownership " + JSON.stringify(extra),
      { chat: "chat", ...extra },
      {
        op: "native-command-recovery-context",
        shape: "raw",
        error: true,
        code: "chat-not-found",
      },
    );
  c = await start({ intent: { expectedTurnId: "turn-one" } });
  let expected = await capture("capture exact old writer before native read");
  let states = await snapshot(
    "capture does not invent observed turn ownership",
  );
  for (const state of states) assert.equal(state.turns, null);
  for (const extra of [
    { threadId: "wrong" },
    { turnId: "wrong" },
    { runtimeGeneration: "runtime" },
    { status: null },
    { status: "inProgress" },
  ])
    for (const value of await unchanged(
      "recovery observation fence " + JSON.stringify(extra),
      () =>
        recover(
          "recovery observation fence " + JSON.stringify(extra),
          expected,
          extra,
        ),
    ))
      assert.equal(value, false);
  for (const status of ["completed", "failed", "interrupted"]) {
    c = await start({ intent: { expectedTurnId: "turn-one" } });
    expected = await capture("capture before terminal recovery " + status);
    for (const value of await recover(
      "actual terminal native observation " + status,
      expected,
      { status },
    ))
      assert.equal(value, true);
    states = await snapshot("recovered lifecycle " + status);
    for (const state of states) {
      assert.equal(state.activations[0].active, false);
      assert.equal(
        state.chats.find((c) => c.id === "chat").status,
        status === "failed" ? "failed" : "idle",
      );
      assert.equal(state.turns[0].turn_id, "turn-one");
      assert.equal(state.commands[0].status, "applied");
      assert.equal(state.commands[0].result_digest, null);
    }
    for (const value of await unchanged(
      "repeated terminal recovery " + status,
      () => recover("repeat native recovery " + status, expected, { status }),
    ))
      assert.equal(value, true);
  }
  c = await start({ dispatch: false, intent: { expectedTurnId: "turn-one" } });
  expected = await capture("capture preserves Source accepted-writer behavior");
  for (const value of expected) assert.equal(value.receipt.status, "accepted");
  await unchanged("recovery cannot report accepted input as dispatched", () =>
    recover(
      "accepted writer recovery",
      expected,
      {},
      { error: true, code: "operation-not-dispatched" },
    ),
  );

  c = await start({ intent: { expectedTurnId: "turn-one" } });
  expected = await capture("capture before conflicting old receipt");
  await settle(
    "reject old writer without retiring activation",
    (i) => c.input(i, { status: "rejected" }),
    { status: "rejected" },
  );
  await unchanged("same activation receipt conflict is a real failure", () =>
    recover(
      "same activation receipt conflict",
      expected,
      {},
      { error: true, code: "receipt-conflict" },
    ),
  );
  c = await start({ intent: { expectedTurnId: "turn-one" } });
  expected = await capture("capture before terminal rejection");
  await settle(
    "terminally reject old writer",
    (i) => c.input(i, { status: "rejected", executionComplete: true }),
    { status: "rejected" },
  );
  for (const value of await unchanged(
    "retired conflicting receipt is a recovery miss",
    () => recover("retired conflicting receipt", expected),
  ))
    assert.equal(value, false);
  for (const complete of [false, true]) {
    c = await start({ intent: { expectedTurnId: "turn-one" } });
    expected = await capture("capture before successor complete=" + complete);
    if (complete)
      await settle("complete old writer before successor", (i) =>
        c.input(i, {
          executionComplete: true,
          reconciliation: {
            nativeTurnId: "turn-one",
            runtimeGeneration: "runtime",
          },
        }),
      );
    else
      await observe(
        "administratively retire old writer before successor",
        (i) => ({
          worker: "alpha",
          operation: "request",
          generation: c.admitted[i].receipt.operationGeneration,
          status: "failed",
        }),
        { op: "native-command-finish-execution", shape: "raw" },
      );
    const successor = await observe(
      "admit replacement writer",
      command({
        operationId: "successor",
        session,
        intent: { expectedTurnId: "turn-two" },
      }),
    );
    for (const value of await unchanged(
      "old native observation preserves successor complete=" + complete,
      () =>
        recover(
          "recover old writer with active successor complete=" + complete,
          expected,
        ),
    ))
      assert.equal(value, complete);
    states = await snapshot(
      "successor activation survives recovery complete=" + complete,
    );
    for (const [i, state] of states.entries()) {
      assert.equal(
        state.activations[0].generation,
        successor[i].receipt.activationGeneration,
      );
      assert.equal(state.activations[0].active, true);
      assert.equal(state.chats.find((c) => c.id === "chat").status, "running");
    }
  }
  c = await start({ intent: { expectedTurnId: "turn-one" } });
  expected = await capture("capture before operational recovery failure");
  await unchanged("recovery ownership failure propagates", () =>
    observe(
      "wrong worker recovery",
      (i) => ({ worker: "beta", expected: expected[i], observed }),
      {
        op: "native-command-recover",
        shape: "raw",
        error: true,
        code: "operation-not-found",
      },
    ),
  );
  await seed(
    "CREATE FUNCTION fail_recovery() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'recovery fixture failure'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_recovery BEFORE UPDATE ON native_commands FOR EACH ROW EXECUTE FUNCTION fail_recovery()",
  );
  await unchanged(
    "operational recovery failure propagates and rolls back",
    () =>
      recover(
        "SQL recovery failure",
        expected,
        {},
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed("DROP TRIGGER fail_recovery ON native_commands");
  await seed("DROP FUNCTION fail_recovery()");
}
