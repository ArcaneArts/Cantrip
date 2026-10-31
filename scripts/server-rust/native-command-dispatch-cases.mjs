import assert from "node:assert/strict";
import { nativeCommandDispatchSchema } from "../../packages/protocol/dist/index.js";
import { literal, stamp } from "./project-target-state.mjs";

export async function runDispatchCases({
  seed,
  observe,
  snapshot,
  reset,
  command,
  owner,
}) {
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  async function setup(bound = false) {
    await reset();
    if (bound)
      await seed(
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('runtime-session','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
      );
    return observe("admit before dispatch", command(bound ? { session } : {}));
  }
  const input = (admitted, i, extra = {}) =>
    nativeCommandDispatchSchema.parse({
      workerId: "alpha",
      operationId: admitted[i].receipt.operationId,
      operationGeneration: admitted[i].receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      ...extra,
      session: { ...session, ...extra.session },
    });
  const dispatch = (name, request, expected = {}) =>
    observe(name, request, {
      op: "native-command-dispatch",
      status: "dispatched",
      ...expected,
    });
  async function rejected(name, request, expected) {
    const before = await snapshot("before dispatch " + name);
    await dispatch(name, request, { error: true, ...expected });
    assert.deepEqual(await snapshot("dispatch rollback " + name), before, name);
  }
  let admitted = await setup();
  const sent = await dispatch("bind and dispatch fresh GUI start", (i) =>
    input(admitted, i),
  );
  const boundState = await snapshot(
    "dispatch binds receipt activation lane and runtime",
  );
  for (const [i, value] of boundState.entries()) {
    assert.equal(value.commands[0].identity.threadId, "thread");
    assert.equal(value.activations[0].runtime_generation, "runtime");
    assert.equal(value.lanes[0].codex_thread_id, "thread");
    assert.equal(value.runtimes[0].codex_thread_id, "thread");
    assert.equal(sent[i].receipt.threadId, "thread");
    assert.equal(sent[i].execution.threadId, "thread");
  }
  await rejected("dispatch is single use", (i) => input(admitted, i), {
    code: "operation-already-dispatched",
  });
  for (const [name, changes, sql, code, bound] of [
    [
      "missing operation",
      { operationId: "missing" },
      null,
      "operation-not-found",
    ],
    [
      "operation generation",
      { operationGeneration: "wrong" },
      null,
      "operation-not-found",
    ],
    ["operation worker", { workerId: "beta" }, null, "operation-not-found"],
    [
      "payload digest",
      { payloadDigest: "b".repeat(64) },
      null,
      "operation-id-conflict",
    ],
    [
      "missing Chat",
      { session: { chatId: "missing" } },
      null,
      "chat-not-found",
    ],
    ["placement", { session: { placementId: "wrong" } }, null, "stale-session"],
    [
      "bound prior thread",
      { session: { threadId: "new-thread" } },
      null,
      "stale-session",
      true,
    ],
    [
      "bound prior runtime",
      { session: { runtimeGeneration: "new-runtime" } },
      null,
      "stale-session",
      true,
    ],
    [
      "bound prior connection",
      { session: { connectionId: "new-connection" } },
      null,
      "stale-session",
      true,
    ],
    [
      "missing native runtime",
      { session: { runtimeGeneration: null } },
      null,
      "stale-session",
    ],
    [
      "missing connection",
      { session: { connectionId: null } },
      null,
      "stale-session",
    ],
    [
      "route",
      { session: { modelRouteId: "wrong" } },
      null,
      "runtime-route-mismatch",
    ],
    [
      "context native thread",
      {},
      "UPDATE chat_runtime_sessions SET codex_thread_id='replacement'",
      "thread-identity-mismatch",
    ],
    [
      "inactive activation",
      {},
      "UPDATE native_command_activations SET active=false",
      "stale-activation",
    ],
    [
      "activation generation",
      {},
      "UPDATE native_command_activations SET generation='new-generation'",
      "stale-activation",
    ],
    [
      "inactive Chat",
      {},
      "UPDATE chats SET status='idle' WHERE id='chat'",
      "stale-activation",
    ],
    [
      "activation runtime",
      {},
      "UPDATE native_command_activations SET runtime_generation='new-runtime'",
      "stale-activation",
    ],
    [
      "stored rejection",
      {},
      "UPDATE native_commands SET status='rejected',rejection_code='durable custom rejection 😃'",
      "durable custom rejection 😃",
    ],
    [
      "stored rejection fallback",
      {},
      "UPDATE native_commands SET status='rejected'",
      "operation-rejected",
    ],
    [
      "already uncertain",
      {},
      "UPDATE native_commands SET status='uncertain'",
      "operation-already-dispatched",
    ],
    [
      "already applied",
      {},
      "UPDATE native_commands SET status='applied'",
      "operation-already-dispatched",
    ],
  ]) {
    admitted = await setup(bound);
    if (sql) await seed(sql);
    await rejected(name, (i) => input(admitted, i, changes), { code });
  }
  for (const table of [
    "native_command_activations",
    "chat_runtime_sessions",
    "native_commands",
  ]) {
    admitted = await setup();
    await seed(
      "CREATE FUNCTION fail_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'dispatch fixture failure'; END$$",
    );
    await seed(
      `CREATE TRIGGER fail_dispatch BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_dispatch()`,
    );
    await rejected("SQL failure on " + table, (i) => input(admitted, i), {
      sqlstate: "P0001",
    });
    await seed(`DROP TRIGGER fail_dispatch ON ${table}`);
    await seed("DROP FUNCTION fail_dispatch()");
  }
  admitted = await setup();
  await seed(
    "CREATE FUNCTION suppress_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$",
  );
  await seed(
    "CREATE TRIGGER suppress_dispatch BEFORE UPDATE ON native_commands FOR EACH ROW EXECUTE FUNCTION suppress_dispatch()",
  );
  await rejected("suppressed command update", (i) => input(admitted, i), {});
  await seed("DROP TRIGGER suppress_dispatch ON native_commands");
  await seed("DROP FUNCTION suppress_dispatch()");
  admitted = await setup(true);
  await seed(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id,created_at,updated_at) VALUES('handoff',${literal(owner)},'chat','alpha','preparing','{}','unused',${literal(stamp)},${literal(stamp)})`,
  );
  await rejected(
    "handoff guard precedes digest",
    (i) => input(admitted, i, { payloadDigest: "b".repeat(64) }),
    { code: "native-runtime-handoff-pending" },
  );
  for (const paused of [true, false]) {
    admitted = await setup(true);
    await seed(
      `UPDATE chats SET managed_autonomy_stopped=true,automation_paused=${!paused} WHERE id='chat'`,
    );
    const pause = await observe("admit pause " + paused, (i) =>
      command({
        operationId: "pause",
        session,
        method: "turn/pause",
        expectedActivationGeneration: admitted[i].receipt.activationGeneration,
        intent: { paused, resumeAutonomy: !paused },
      }),
    );
    const result = await dispatch("dispatch pause " + paused, (i) =>
      input(pause, i),
    );
    const state = await snapshot("pause lifecycle " + paused);
    for (const [i, value] of state.entries()) {
      const chat = value.chats.find((c) => c.id === "chat");
      assert.equal(chat.automation_paused, paused);
      assert.equal(chat.managed_autonomy_stopped, paused);
      assert.equal(chat.managed_input_revision, 0);
      assert.equal(value.queues[0].revision, 1);
      assert.equal(result[i].execution.automationPaused, paused);
    }
  }
  admitted = await setup(true);
  await seed(
    `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,state,mode,revision,created_at,updated_at) VALUES('stop-prompt','chat','Queue fixture','queue-model','stop-prompt','claimed','goal',0,${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,created_at) VALUES('stop-claim','chat','stop-prompt',0,${literal(stamp)})`,
  );
  await observe("admit Goal awaiting handoff before Stop", (i) =>
    command({
      operationId: "goal-parent",
      session,
      method: "thread/goal/set",
      expectedActivationGeneration: admitted[i].receipt.activationGeneration,
      queueClaim: { id: "stop-claim", promptRevision: 0 },
      intent: { goalStatus: "active", resumeAutonomy: true },
    }),
  );
  const lateResume = await observe("admit queued resume before Stop", (i) =>
    command({
      operationId: "late-resume",
      session,
      method: "thread/queue/add",
      expectedActivationGeneration: admitted[i].receipt.activationGeneration,
      intent: { resumeAutonomy: true },
    }),
  );
  const stop = await observe("admit Stop", (i) =>
    command({
      operationId: "stop",
      session,
      method: "turn/interrupt",
      expectedActivationGeneration: admitted[i].receipt.activationGeneration,
    }),
  );
  const stopped = await dispatch(
    "dispatch Stop cancels Goal and late resume",
    (i) => input(stop, i),
  );
  const stoppedState = await snapshot("atomic Stop state");
  for (const [i, value] of stoppedState.entries()) {
    const chat = value.chats.find((c) => c.id === "chat");
    assert.equal(chat.managed_autonomy_stopped, true);
    assert.equal(chat.managed_input_revision, 1);
    assert.equal(
      stopped[i].execution.managedInputRevision,
      0,
      "Source returns context captured before Stop",
    );
    assert.equal(value.activations[0].logical_cancelled, true);
    assert.equal(value.queues[0].revision, 2);
    assert.equal(value.claims[0].status, "rejected");
    assert.equal(value.prompts[0].state, "pending");
    assert.equal(
      value.commands.find((c) => c.operation_id === "goal-parent")
        .rejection_code,
      "queue-goal-handoff-cancelled",
    );
    assert.equal(
      value.commands.find((c) => c.operation_id === "late-resume")
        .rejection_code,
      "autonomy-stopped",
    );
  }
  await rejected(
    "late resume cannot reopen stopped autonomy",
    (i) => input(lateResume, i),
    { code: "autonomy-stopped" },
  );
  for (const status of ["running", "idle"])
    for (const method of ["skills/list", "hooks/list"]) {
      admitted = await setup(true);
      await seed(`UPDATE chats SET status=${literal(status)} WHERE id='chat'`);
      const discovery = await observe(
        "admit discovery " + status + " " + method,
        command({ operationId: "discovery", session, method }),
      );
      const result = await dispatch(
        "dispatch discovery without activation " + status + " " + method,
        (i) => input(discovery, i),
      );
      for (const value of result)
        assert.equal(value.receipt.activationGeneration, null);
      const state = await snapshot(
        "discovery keeps canonical activation " + status + " " + method,
      );
      for (const value of state) {
        assert.equal(value.activations[0].operation_id, "request");
        assert.equal(value.queues[0].revision, 0);
      }
    }
  for (const method of ["thread/goal/set", "thread/goal/clear"]) {
    admitted = await setup(true);
    await seed(
      `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,state,mode,revision,created_at,updated_at) VALUES('goal-prompt','chat','Queue fixture','queue-model','goal-prompt','claimed','goal',0,${literal(stamp)},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,created_at) VALUES('goal-claim','chat','goal-prompt',0,${literal(stamp)})`,
    );
    const parent = await observe("admit goal parent before " + method, (i) =>
      command({
        operationId: "goal-parent",
        session,
        method: "thread/goal/set",
        expectedActivationGeneration: admitted[i].receipt.activationGeneration,
        queueClaim: { id: "goal-claim", promptRevision: 0 },
        intent: { goalStatus: "active", resumeAutonomy: true },
      }),
    );
    await dispatch("dispatch claimed goal parent before " + method, (i) =>
      input(parent, i),
    );
    let state = await snapshot(
      "queue claim dispatched with goal parent " + method,
    );
    for (const value of state) {
      assert.equal(value.claims[0].status, "dispatched");
      assert.equal(value.claims[0].awaiting_goal, true);
    }
    const cancel = await observe("admit goal cancellation " + method, (i) =>
      command({
        operationId: "goal-cancel",
        session,
        method,
        expectedActivationGeneration: admitted[i].receipt.activationGeneration,
        intent: method === "thread/goal/set" ? { goalStatus: "paused" } : {},
      }),
    );
    await dispatch("dispatch goal cancellation " + method, (i) =>
      input(cancel, i),
    );
    state = await snapshot(
      "goal cancellation preserves dispatched parent " + method,
    );
    for (const value of state) {
      assert.equal(value.claims[0].status, "rejected");
      assert.equal(value.prompts[0].state, "pending");
      assert.equal(
        value.commands.find((c) => c.operation_id === "goal-parent").status,
        "dispatched",
      );
      assert.equal(value.queues[0].revision, 2);
      assert.equal(
        value.chats.find((c) => c.id === "chat").managed_input_revision,
        0,
      );
    }
  }
}
