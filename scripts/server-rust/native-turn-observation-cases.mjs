import assert from "node:assert/strict";
import { json } from "./project-target-state.mjs";
export async function runTurnObservationCases({
  start,
  seed,
  observe,
  snapshot,
  unchanged,
  command,
  session,
}) {
  const historical = {
    kind: "terminal",
    nativeTurnId: "turn-one",
    runtimeGeneration: "runtime",
  };
  const find = (c, name, { input = false, backfill, ...options } = {}) =>
    observe(name, (i) => c.key(i, { backfill }), {
      op: input
        ? "native-command-observed-input"
        : "native-command-observed-turn",
      shape: "raw",
      ...options,
    });
  let c = await start();
  for (const value of await unchanged(
    "proposed native turn is not observation",
    () => find(c, "proposed native turn is not observation"),
  ))
    assert.equal(value, null);
  for (const evidence of [
    historical,
    { ...historical, kind: "native-terminal" },
    null,
    [],
    {},
    { kind: "deferred" },
    { ...historical, nativeTurnId: null },
    { ...historical, runtimeGeneration: "wrong" },
  ]) {
    c = await start();
    await seed(
      `UPDATE native_commands SET status='applied',execution_completed_at=now(),terminal_evidence=${json(evidence)}`,
    );
    const valid =
      evidence?.kind === "terminal" || evidence?.kind === "native-terminal";
    const expected =
      valid &&
      evidence.nativeTurnId === "turn-one" &&
      evidence.runtimeGeneration === "runtime";
    for (const value of await unchanged(
      "historical candidate without backfill " + JSON.stringify(evidence),
      () =>
        find(
          c,
          "historical candidate without backfill " + JSON.stringify(evidence),
          { backfill: false },
        ),
    ))
      assert.equal(Boolean(value), expected);
    const values = await find(
      c,
      "historical native turn backfill " + JSON.stringify(evidence),
    );
    for (const value of values) assert.equal(Boolean(value), expected);
    const states = await snapshot(
      "observed immutable ownership " + JSON.stringify(evidence),
    );
    for (const state of states)
      assert.equal(state.turns?.length ?? 0, expected ? 1 : 0);
    if (expected) {
      await seed(
        "UPDATE native_commands SET identity='{}',terminal_evidence=NULL,status='rejected'",
      );
      for (const value of await unchanged(
        "existing observation takes precedence over historical receipt",
        () =>
          find(
            c,
            "existing observation takes precedence over historical receipt",
          ),
      ))
        assert.equal(value.turnId, "turn-one");
    }
  }
  c = await start();
  await seed(
    `UPDATE native_commands SET status='applied',execution_completed_at=now(),terminal_evidence=${json(historical)}`,
  );
  await seed("UPDATE native_command_activations SET native_turn_id='turn-one'");
  const states = await snapshot("capture historical steer root activation");
  const steers = await observe(
    "admit steer of completed transport receipt",
    (i) =>
      command({
        operationId: "observed-steer",
        session,
        method: "turn/steer",
        expectedActivationGeneration: states[i].activations[0].generation,
        intent: { expectedTurnId: "turn-one" },
      }),
  );
  const steer = {
    key: (i, extra = {}) => ({
      worker: "alpha",
      operation: "observed-steer",
      generation: steers[i].receipt.operationGeneration,
      ...extra,
    }),
  };
  for (const value of await find(steer, "steer reuses observed start root", {
    input: true,
  }))
    assert.equal(value.operationId, c.operationId);
  let after = await snapshot("steer creates one owner only");
  for (const state of after) assert.equal(state.turns.length, 1);
  await seed(
    "UPDATE native_commands SET intent=jsonb_set(intent,'{expectedTurnId}','\"wrong\"') WHERE operation_id='observed-steer'",
  );
  for (const value of await unchanged(
    "steer expected turn must match observation",
    () =>
      find(steer, "steer expected turn must match observation", {
        input: true,
      }),
  ))
    assert.equal(value, null);
  await seed(
    "UPDATE native_commands SET activation_generation=NULL WHERE operation_id='observed-steer'",
  );
  for (const value of await find(
    steer,
    "steer without activation cannot invent ownership",
    { input: true },
  ))
    assert.equal(value, null);
}
