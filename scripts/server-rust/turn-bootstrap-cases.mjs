import assert from "node:assert/strict";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { taskEventMessage } from "./native-event-fixtures.mjs";
import { literal, stamp } from "./project-target-state.mjs";
export async function runTurnBootstrapCases(h) {
  const { observe, reset, seed, snapshot, owner, standalone } = h;
  const message = retainedPrompt().pendingMessage;
  const response = {
    id: "456789ab-1234-4234-8234-000000000009",
    idempotencyKey: "bootstrap-response",
  };
  const options = { encryptedChatMessages: { userMessage: message, response } };
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('bootstrap-provider',${literal(owner)},'Bootstrap provider','openai-compatible','http://localhost:8080') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('bootstrap-model',${literal(owner)},'Bootstrap model') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('bootstrap-route','bootstrap-model','bootstrap-provider','bootstrap-model',0,true) ON CONFLICT DO NOTHING",
  ]);
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "DELETE FROM task_dispatch_cycles",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET model_id='bootstrap-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL,protected_plan=NULL,has_pending_plan_question=false,plan_mode='default'",
    ]);
  };
  const run = (name, fields = {}, expect = {}) =>
    observe(
      name,
      {
        chat: "chat",
        input: { modelId: "bootstrap-model" },
        options,
        protectedMessage: message,
        ...fields,
      },
      { op: "native-command-turn-bootstrap", shape: "gui", ...expect },
    );
  await clean();
  let states;
  let values = await run(
    "actual turn bootstrap admits and durably attributes opaque Agent input",
  );
  for (const value of values) {
    assert.equal(value.nativeCommandReceipt.status, "accepted");
    assert.equal(value.userMessage.id, message.id);
    assert.equal(value.routePairs[0].root.runtime.routeId, "bootstrap-route");
    assert.deepEqual(value.commands, []);
    assert.deepEqual(value.stageLogs, []);
    assert.equal(
      value.events.filter((e) => e.resource === "chat-message").length,
      2,
    );
  }
  await snapshot(
    "admitted Agent input, message metadata and native receipt are durable",
  );
  await run(
    "same bootstrap cannot launch a duplicate native operation",
    {},
    { error: true },
  );
  await clean();
  const contexts = await observe(
    "capture actual bootstrap context for bound-route lookup",
    { chat: "chat" },
    { op: "chat-context", shape: "raw" },
  );
  await observe(
    "an invalid UTF16 bound route cannot become an omitted route filter",
    (i) => ({
      chat: "chat",
      context: {
        ...contexts[i],
        threadId: "bound-thread",
        modelRouteId: "missing-\ud800",
      },
      input: { modelId: "bootstrap-model" },
      options,
      protectedMessage: message,
    }),
    { op: "native-command-turn-bootstrap", shape: "gui", error: true },
  );
  const bind = () =>
    seed(
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('77777777-7777-4777-8777-000000000098','chat','alpha','github-alpha-main','bootstrap-bound-thread','bootstrap-route',NULL,'ready')",
    );
  await clean();
  await bind();
  await seed(
    "UPDATE model_routes SET enabled=false WHERE id='bootstrap-route'",
  );
  try {
    values = await run(
      "a bound native conversation retains its disabled route",
      { input: { modelId: "gui-model" } },
    );
    for (const value of values) {
      assert.equal(value.execution.threadId, "bootstrap-bound-thread");
      assert.equal(value.routePairs[0].root.runtime.routeId, "bootstrap-route");
    }
    await snapshot("bound route observation preserves the native conversation");
  } finally {
    await seed(
      "UPDATE model_routes SET enabled=true WHERE id='bootstrap-route'",
    );
  }
  await clean();
  await bind();
  await observe(
    "seed actual encrypted input for native retry",
    { chat: "chat", action: "write", message, protectedMessage: message },
    { op: "native-command-turn-live", shape: "raw" },
  );
  values = await run(
    "retry rolls back the actual bound worker before trimming and replacing input",
    { options: { ...options, retryMessageId: message.id } },
  );
  for (const value of values) {
    assert.equal(value.commands.length, 1);
    assert.equal(value.commands[0].command.type, "chat.turn.rollback");
    assert.equal(value.commands[0].command.threadId, "bootstrap-bound-thread");
  }
  states = await snapshot(
    "retry replaces the original user turn without duplicate input",
  );
  for (const state of states) assert.equal(state.messages.length, 1);
  await clean();
  values = await run(
    "Task conversation is reprotected by the worker before its legacy lane",
    {
      chat: "task",
      responses: { "task.message.protect": taskEventMessage },
    },
  );
  for (const value of values) {
    assert.equal(value.nativeCommandReceipt, undefined);
    assert.equal(value.commands[0].command.type, "task.message.protect");
    assert.equal(value.userMessage.id, message.id);
  }
  await snapshot("Task conversion persists only the protected worker result");
  await clean();
  values = await run(
    "scheduled Task bootstrap uses the authoritative lease before admission",
    {
      chat: "task",
      options: {
        encryptedTaskMessages: { userMessage: taskEventMessage, response },
        taskDispatchLease: {
          cycleId: "77777777-7777-4777-8777-000000000099",
          operationId: "bootstrap-operation",
          leaseOwner: "bootstrap-owner",
          fencingToken: 1,
        },
      },
    },
    { error: true },
  );
  // No cycle exists: the real SQL fence, rather than inferred availability,
  // must reject before a lane or message can be created.
  states = await snapshot("missing Task fence admits no lane or message");
  for (const state of states) {
    assert.equal(state.lanes, null);
    assert.equal(state.messages, null);
  }
  const lease = {
    cycleId: "77777777-7777-4777-8777-000000000099",
    operationId: "bootstrap-operation",
    leaseOwner: "bootstrap-owner",
    fencingToken: 1,
  };
  const seedLease = () =>
    seed([
      "INSERT INTO tasks(chat_id,protected_content) VALUES('task','{}'::jsonb) ON CONFLICT DO NOTHING",
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,lease_owner,lease_expires_at,fencing_token,queued_at,claimed_at,created_at,updated_at) VALUES('${lease.cycleId}',${literal(owner)},'task','bootstrap-operation','direct','claimed',${literal(stamp)},'bootstrap-owner','2999-01-01T00:00:00Z',1,${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    ]);
  await clean();
  await seedLease();
  values = await run(
    "scheduled Task bootstrap logs the real ordered stages and persists its input",
    {
      chat: "task",
      options: {
        encryptedTaskMessages: { userMessage: taskEventMessage, response },
        taskDispatchLease: lease,
        preflightWorkerCommandTimeoutMs: 30000,
      },
    },
  );
  for (const value of values) {
    const stages = value.stageLogs
      .filter((l) => l.status === "started")
      .map((l) => l.stage);
    assert.deepEqual(stages, [
      "resolve-model",
      "resolve-model-routes",
      "resolve-attachments",
      "resolve-effective-policies",
      "resolve-mcp-servers",
      "mark-dispatch-running",
      "acquire-execution-lane",
      "persist-turn-mode",
      "load-message-headers",
      "append-task-message",
      "attribute-task-message",
    ]);
    assert.ok(
      value.stageLogs.every((l) => ["started", "completed"].includes(l.status)),
    );
  }
  await snapshot("scheduled Task input and lane survive bootstrap");
  await clean();
  await seedLease();
  await seed("UPDATE task_dispatch_cycles SET fencing_token=2,state='paused'");
  await run(
    "a paused Task fence cannot admit a lane or append input",
    {
      chat: "task",
      options: {
        encryptedTaskMessages: { userMessage: taskEventMessage, response },
        taskDispatchLease: lease,
      },
    },
    { error: true },
  );
  states = await snapshot(
    "advanced Task fence leaves no duplicate durable execution",
  );
  for (const state of states) {
    assert.equal(state.lanes, null);
    assert.equal(state.messages, null);
  }
  await clean();
  values = await run(
    "standalone protected input keeps its scratch attribution",
    { chat: standalone },
  );
  for (const value of values) {
    assert.equal(value.userMessage.contextKind, "standalone");
    assert.equal(value.userMessage.worktreeId, null);
    assert.ok(value.userMessage.scratchRootId);
  }
  await snapshot("standalone bootstrap state remains scratch scoped");
  await clean();
  values = await run("standalone visible input uses actual worker protection", {
    chat: standalone,
    options: {},
    input: {
      modelId: "bootstrap-model",
      text: "bootstrap-private-marker",
      idempotencyKey: "bootstrap-visible",
    },
  });
  for (const value of values) {
    assert.equal(value.commands[0].command.type, "chat.message.protect");
    assert.equal(value.userMessage.content.length, 0);
  }
  states = await snapshot(
    "worker-protected standalone bootstrap retains no plaintext input",
  );
  for (const state of states)
    assert.ok(!JSON.stringify(state).includes("bootstrap-private-marker"));
  await clean();
  await run(
    "invalid standalone plan mode is refused before admission",
    { chat: standalone, input: { mode: "plan" } },
    { error: true },
  );
  await snapshot("invalid standalone bootstrap leaves no execution");
  await clean();
  await run(
    "missing attachment is refused before native admission",
    {
      input: {
        modelId: "bootstrap-model",
        attachmentIds: ["missing-attachment"],
      },
    },
    { error: true },
  );
  states = await snapshot("missing attachment leaves no lane or receipt");
  for (const state of states) {
    assert.equal(state.lanes, null);
    assert.equal(state.commands, null);
  }
  await clean();
  await seed(
    "ALTER TABLE chat_messages ADD CONSTRAINT reject_bootstrap_message CHECK(false)",
  );
  try {
    await run(
      "real message INSERT failure finishes the admitted native lane",
      {},
      { error: true, sqlstate: "23514" },
    );
    states = await snapshot(
      "failed input persistence closes its actual native execution",
    );
    for (const state of states) {
      assert.equal(state.messages, null);
      assert.equal(state.lanes[0].state, "suspended");
      assert.equal(state.chats.find((c) => c.id === "chat").status, "failed");
    }
  } finally {
    await seed(
      "ALTER TABLE chat_messages DROP CONSTRAINT reject_bootstrap_message",
    );
  }
}
