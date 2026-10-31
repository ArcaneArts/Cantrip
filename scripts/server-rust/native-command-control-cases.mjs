import assert from "node:assert/strict";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";
export async function runControlCases({
  seed,
  observe,
  snapshot,
  reset,
  command,
  standalone,
}) {
  const control = async (name, op, input = {}, options = {}) => {
    const values = await observe(name, input, {
      op: "native-command-" + op,
      shape: "raw",
      ...options,
    });
    if (op === "control-context" && !options.error)
      for (const value of values)
        assert.deepEqual(
          Object.keys(value),
          value.context
            ? ["context", "runtimeGeneration", "activationGeneration"]
            : ["context", "activationGeneration", "runtimeGeneration"],
        );
    return values;
  };
  async function unchanged(name, op, input, options = {}) {
    const before = await snapshot("before " + name);
    const result = await control(name, op, input, options);
    assert.deepEqual(await snapshot("unchanged " + name), before, name);
    return result;
  }
  async function start(dispatch = false) {
    await reset();
    const results = await observe("control fixture admission", command());
    if (dispatch)
      await observe(
        "control fixture dispatch",
        (i) => ({
          workerId: "alpha",
          operationId: "request",
          operationGeneration: results[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session: {
            ...command().session,
            threadId: "thread",
            runtimeGeneration: "runtime",
            connectionId: "connection",
          },
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
    return results;
  }
  await reset();
  for (const extra of [
    { chat: "missing" },
    { chat: "chat", owner: otherOwner },
  ]) {
    const values = await unchanged(
      "control context missing or foreign " + JSON.stringify(extra),
      "control-context",
      extra,
    );
    for (const value of values)
      assert.deepEqual(value, {
        context: null,
        activationGeneration: null,
        runtimeGeneration: null,
      });
    for (const op of ["stop-autonomy", "resume-autonomy", "cancel-preparing"])
      await unchanged(
        "control owner lock " + op + JSON.stringify(extra),
        op,
        { generation: "missing", ...extra },
        { error: true, code: "chat-not-found" },
      );
  }
  for (const chat of ["task", standalone]) {
    for (const value of await unchanged(
      "ineligible autonomy stop " + chat,
      "stop-autonomy",
      { chat, expected: null },
    ))
      assert.equal(value, false);
    for (const value of await unchanged(
      "ineligible autonomy resume " + chat,
      "resume-autonomy",
      { chat },
    ))
      assert.equal(value, null);
  }
  for (const value of await control("idle autonomy stop", "stop-autonomy", {
    chat: "chat",
    expected: null,
  }))
    assert.equal(value, true);
  let states = await snapshot("idle Stop increments revision and queue");
  for (const state of states) {
    const chat = state.chats.find((c) => c.id === "chat");
    assert.equal(chat.managed_input_revision, 1);
    assert.equal(chat.managed_autonomy_stopped, true);
    assert.equal(state.queues[0].revision, 1);
  }
  await control(
    "repeat Stop keeps Source revision semantics",
    "stop-autonomy",
    { chat: "chat", expected: null },
  );
  await control("resume idle autonomy", "resume-autonomy", { chat: "chat" });
  await control("repeat resume increments queue revision", "resume-autonomy", {
    chat: "chat",
  });
  states = await snapshot("autonomy controls preserve Source revisions");
  for (const state of states) {
    const chat = state.chats.find((c) => c.id === "chat");
    assert.equal(chat.managed_input_revision, 2);
    assert.equal(chat.managed_autonomy_stopped, false);
    assert.equal(state.queues[0].revision, 4);
  }

  let admitted = await start();
  let contexts = await control(
    "preparation control context",
    "control-context",
    { chat: "chat" },
  );
  for (const [i, value] of contexts.entries()) {
    assert.equal(
      value.activationGeneration,
      admitted[i].receipt.activationGeneration,
    );
    assert.equal(value.runtimeGeneration, null);
  }
  for (const value of await unchanged(
    "stale Stop activation",
    "stop-autonomy",
    { chat: "chat", expected: "wrong" },
  ))
    assert.equal(value, false);
  for (const value of await control(
    "Stop exact active preparation",
    "stop-autonomy",
    (i) => ({
      chat: "chat",
      expected: admitted[i].receipt.activationGeneration,
    }),
  ))
    assert.equal(value, true);
  states = await snapshot("Stop flags active logical cancellation");
  for (const state of states)
    assert.equal(state.activations[0].logical_cancelled, true);

  admitted = await start();
  for (const value of await unchanged(
    "stale preparation cancellation",
    "cancel-preparing",
    { chat: "chat", generation: "wrong" },
  ))
    assert.equal(value, null);
  const cancelled = await control(
    "cancel preparation atomically",
    "cancel-preparing",
    (i) => ({
      chat: "chat",
      generation: admitted[i].receipt.activationGeneration,
    }),
  );
  for (const [i, value] of cancelled.entries())
    assert.deepEqual(value, {
      workerId: "alpha",
      logicalRoot: {
        operationId: "request",
        operationGeneration: admitted[i].receipt.operationGeneration,
      },
    });
  states = await snapshot("cancelled preparation final state");
  for (const state of states) {
    assert.equal(state.commands[0].status, "rejected");
    assert.equal(state.commands[0].rejection_code, "cancelled-before-dispatch");
    assert.ok(state.commands[0].logical_completed_at);
    assert.equal(state.activations[0].active, false);
    assert.equal(state.lanes[0].state, "suspended");
    assert.equal(state.leases[0].state, "released");
    assert.equal(state.chats.find((c) => c.id === "chat").status, "idle");
  }
  for (const value of await unchanged(
    "cancel preparation replay",
    "cancel-preparing",
    (i) => ({
      chat: "chat",
      generation: admitted[i].receipt.activationGeneration,
    }),
  ))
    assert.equal(value, null);

  admitted = await start(true);
  contexts = await control("dispatched control context", "control-context", {
    chat: "chat",
  });
  for (const value of contexts)
    assert.equal(value.runtimeGeneration, "runtime");
  for (const value of await unchanged(
    "cannot cancel dispatched preparation",
    "cancel-preparing",
    (i) => ({
      chat: "chat",
      generation: admitted[i].receipt.activationGeneration,
    }),
  ))
    assert.equal(value, null);
  for (const status of [
    "accepted",
    "dispatched",
    "applied",
    "uncertain",
    "rejected",
  ]) {
    admitted = await start(status !== "accepted");
    await seed(`UPDATE native_commands SET status=${literal(status)}`);
    const args = (i) => ({
      worker: "alpha",
      operation: "request",
      generation: admitted[i].receipt.operationGeneration,
      status: "failed",
    });
    for (const value of await control(
      "administrative finish " + status,
      "finish-execution",
      args,
    ))
      assert.equal(value, true);
    states = await snapshot("finish lifecycle " + status);
    for (const state of states) {
      const row = state.commands[0];
      assert.equal(
        row.status,
        status === "accepted"
          ? "rejected"
          : status === "dispatched"
            ? "uncertain"
            : status,
      );
      assert.equal(
        row.rejection_code,
        status === "accepted"
          ? "not-dispatched"
          : status === "dispatched"
            ? "missing-native-receipt"
            : null,
      );
      assert.equal(row.execution_completed_at, null);
      assert.equal(state.activations[0].active, false);
      assert.equal(state.lanes[0].state, "suspended");
      assert.equal(state.chats.find((c) => c.id === "chat").status, "failed");
    }
    for (const value of await unchanged(
      "administrative finish replay " + status,
      "finish-execution",
      args,
    ))
      assert.equal(value, false);
  }
  admitted = await start();
  await seed(
    `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,state,revision,created_at,updated_at) VALUES('cancel-prompt','chat','Queue fixture','queue-model','cancel-prompt','claimed',0,${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    (i) =>
      `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,operation_id,operation_generation,created_at) VALUES('cancel-claim','chat','cancel-prompt',0,'accepted','request',${literal(admitted[i].receipt.operationGeneration)},${literal(stamp)})`,
  );
  await control(
    "cancel preparation settles associated queue claim",
    "cancel-preparing",
    (i) => ({
      chat: "chat",
      generation: admitted[i].receipt.activationGeneration,
    }),
  );
  states = await snapshot("preparation cancellation restores queued input");
  for (const state of states) {
    assert.equal(state.claims[0].status, "rejected");
    assert.equal(state.prompts[0].state, "pending");
    assert.equal(state.queues[0].revision, 2);
  }
  admitted = await start(true);
  await seed(
    "UPDATE native_command_activations SET generation='replacement-activation'",
  );
  for (const value of await unchanged(
    "retirement cannot finish replacement activation",
    "finish-execution",
    (i) => ({
      worker: "alpha",
      operation: "request",
      generation: admitted[i].receipt.operationGeneration,
      status: "failed",
    }),
  ))
    assert.equal(value, false);
  await unchanged(
    "retirement cannot access another worker operation",
    "finish-execution",
    (i) => ({
      worker: "beta",
      operation: "request",
      generation: admitted[i].receipt.operationGeneration,
      status: "failed",
    }),
    { error: true, code: "operation-not-found" },
  );
  for (const table of ["chat_execution_lanes", "native_command_activations"]) {
    admitted = await start();
    await seed(
      "CREATE FUNCTION fail_control() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'control fixture failure'; END$$",
    );
    await seed(
      `CREATE TRIGGER fail_control BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_control()`,
    );
    await unchanged(
      "cancel rolls back failure on " + table,
      "cancel-preparing",
      (i) => ({
        chat: "chat",
        generation: admitted[i].receipt.activationGeneration,
      }),
      { error: true, sqlstate: "P0001" },
    );
    await seed(`DROP TRIGGER fail_control ON ${table}`);
    await seed("DROP FUNCTION fail_control()");
  }
}
