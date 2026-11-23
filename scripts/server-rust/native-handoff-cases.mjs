import assert from "node:assert/strict";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
import {
  handoffPrepared,
  handoffOperation,
} from "./native-handoff-wire-fixtures.mjs";
import { literal, otherOwner } from "./project-target-state.mjs";
export async function runNativeHandoffCases(h) {
  const { observe, reset, seed, snapshot, owner, reopen } = h;
  let bindings;
  const run = (action, name, fields = {}, options = {}) =>
    observe(
      name,
      (i) => ({
        action,
        chat: "chat",
        worker: "alpha",
        operation: handoffOperation,
        ...(typeof fields === "function" ? fields(i) : fields),
      }),
      { op: "native-command-runtime-handoff", shape: "raw", ...options },
    );
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "UPDATE chats SET model_id='bootstrap-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id='chat'",
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('handoff-provider',${literal(owner)},'Handoff destination','openai-compatible','http://localhost:8080') ON CONFLICT DO NOTHING`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('handoff-model',${literal(owner)},'Handoff model') ON CONFLICT DO NOTHING`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,enabled) VALUES('handoff-route','handoff-model','handoff-provider','handoff-native-model',true) ON CONFLICT DO NOTHING",
      "UPDATE model_routes SET enabled=true WHERE id IN ('bootstrap-route','handoff-route')",
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('77777777-7777-4777-8777-000000000076','chat','alpha','github-alpha-main','thread','bootstrap-route','ready')",
    ]);
    const states = await observe(
      "bind actual source settings for handoff",
      { chat: "chat", snapshot: settingsSnapshot },
      { op: "native-command-settings-refresh", shape: "raw" },
    );
    bindings = states.map((s) => s.state.binding.bindingId);
  };
  const begin = (
    name = "reserve actual native provider handoff",
    fields = {},
    options = {},
  ) =>
    run(
      "begin",
      name,
      (i) => ({
        input: {
          operationId: handoffOperation,
          bindingId: bindings[i],
          targetModelRouteId: "handoff-route",
          targetProviderAccountId: null,
          ...(typeof fields === "function" ? fields(i) : fields),
        },
      }),
      options,
    );
  const prepared = (extra) => {
    const value = handoffPrepared(extra);
    value.snapshot = {
      ...value.snapshot,
      modelAttribution: {
        fingerprint: "c".repeat(64),
        selection: {
          status: "resolved",
          workerId: "alpha",
          providerId: "handoff-provider",
          providerAccountId: null,
          modelId: "handoff-model",
          routeId: "handoff-route",
        },
      },
    };
    return value;
  };
  const prepare = (
    name = "publish actual prepared destination",
    value = prepared(),
    fields = {},
    options = {},
  ) => run("prepared", name, { prepared: value, ...fields }, options);
  await clean();
  let values = await run(
    "inventory",
    "owned handoff inventory reads actual binding and configured routes",
  );
  for (const v of values) {
    assert.equal(v.latest, null);
    assert.ok(v.providers.some((p) => p.id === "handoff-provider"));
  }
  await run(
    "inventory",
    "another owner cannot discover the handoff inventory",
    {},
    { requestOwner: otherOwner },
  );
  await begin();
  let state = await snapshot(
    "handoff reservation stores immutable source and current binding",
  );
  for (const s of state) {
    assert.equal(s.handoffs[0].phase, "preparing");
    assert.deepEqual(s.handoffs[0].source, s.handoffs[0].binding);
  }
  values = await run(
    "configuration",
    "worker reads exact configured source without native initialization",
    { side: "source" },
  );
  for (const v of values) {
    assert.equal(v.configuration.model.routeId, "bootstrap-route");
    assert.equal(v.configuration.threadId, "thread");
  }
  values = await run(
    "configuration",
    "worker reads exact destination while preserving shared conversation identity",
    { side: "destination" },
  );
  for (const v of values) {
    assert.equal(v.configuration.model.routeId, "handoff-route");
    assert.equal(v.configuration.session.chatId, "chat");
  }
  assert.deepEqual(
    await snapshot(
      "handoff configuration reads do not mutate runtime or settings",
    ),
    state,
  );
  await seed(
    "UPDATE model_routes SET enabled=false WHERE id='bootstrap-route'",
  );
  try {
    values = await run(
      "configuration",
      "disabled source remains available for actual cold recovery configuration",
      { side: "source" },
    );
    for (const v of values)
      assert.equal(v.configuration.model.routeId, "bootstrap-route");
  } finally {
    await seed(
      "UPDATE model_routes SET enabled=true WHERE id='bootstrap-route'",
    );
  }
  await begin(
    "identical operation retry retains its actual durable reservation",
  );
  await begin(
    "same operation cannot choose a different target",
    { targetModelRouteId: "bootstrap-route" },
    { error: true, code: "handoff-operation-conflict" },
  );
  await run(
    "guard",
    "native input is fenced while provider handoff is pending",
    { runtime: "runtime", epoch: "epoch" },
    { error: true, code: "native-runtime-handoff-pending" },
  );
  await run(
    "guard",
    "preserving attachment can use the actual source during preparation",
    { runtime: "runtime", epoch: "epoch", access: "attach" },
  );
  values = await run(
    "active",
    "worker reconnect reads the actual active handoff reservations",
  );
  for (const v of values) assert.equal(v.length, 1);
  values = await run(
    "active",
    "another worker cannot inherit the handoff reservation",
    { worker: "beta" },
  );
  for (const v of values) assert.deepEqual(v, []);
  await run(
    "commit",
    "commit cannot skip worker preparation",
    {},
    { error: true, code: "handoff-not-prepared" },
  );
  await run("failure", "public handoff diagnostic is a bounded code", {
    errorCode: "worker-unavailable",
  });
  await run(
    "failure",
    "private diagnostic content cannot become a handoff code",
    { errorCode: "private provider error" },
    { error: true, code: "invalid-handoff-error" },
  );
  await prepare();
  const rotated = prepared();
  rotated.snapshot.protectedContent = {
    ...rotated.snapshot.protectedContent,
    nonce: "BBBBBBBBBBBBBBBB",
  };
  values = await prepare(
    "same prepared snapshot may retry with a newly encrypted nonce",
    rotated,
  );
  for (const v of values)
    assert.equal(
      v.prepared.snapshot.protectedContent.nonce,
      settingsSnapshot.protectedContent.nonce,
    );
  values = await prepare(
    "legacy preparation learns an explicit default reasoning claim",
    prepared({ reasoningEffort: null }),
  );
  for (const v of values) assert.equal(v.prepared.reasoningEffort, null);
  await prepare(
    "same prepared version cannot replace an authenticated reasoning claim",
    prepared({ reasoningEffort: "high" }),
    {},
    { error: true, code: "handoff-preparation-conflict" },
  );
  const replacement = prepared({ runtimeGeneration: "replacement-runtime" });
  replacement.snapshot = {
    ...replacement.snapshot,
    context: {
      ...replacement.snapshot.context,
      runtimeGeneration: "replacement-runtime",
      settingsVersion: { epoch: "replacement-core", revision: "0" },
    },
  };
  await prepare(
    "restarted preparation must compare the current generation",
    replacement,
    { expectedRuntime: "wrong" },
    { error: true, code: "handoff-preparation-conflict" },
  );
  values = await prepare(
    "actual preparation CAS retires its superseded incarnation",
    replacement,
    { expectedRuntime: "target-runtime" },
  );
  for (const v of values) {
    assert.deepEqual(v.retiredRuntimeGenerations, ["target-runtime"]);
    assert.equal(v.retiredNativeEpochs[0].nativeEpoch, "target-core");
  }
  await prepare(
    "retired destination preparation cannot return",
    prepared(),
    { expectedRuntime: "replacement-runtime" },
    { error: true, code: "handoff-prepared-source-mismatch" },
  );
  await run(
    "commit",
    "commit transfers route and settings in one actual transaction",
  );
  await run(
    "configuration",
    "committed transfer cannot reinitialize its retired source",
    { side: "source" },
    { error: true, code: "handoff-phase-conflict" },
  );
  await run(
    "configuration",
    "committed destination still supplies its exact native configuration",
    { side: "destination" },
  );
  state = await snapshot(
    "committed handoff retains thread and child configuration",
  );
  for (const s of state) {
    assert.equal(s.handoffs[0].phase, "committed");
    assert.equal(s.handoffs[0].source.runtimeGeneration, "runtime");
    assert.equal(s.runtimes[0].codex_thread_id, "thread");
    assert.equal(s.runtimes[0].model_route_id, "handoff-route");
    assert.equal(
      s.chats.find((c) => c.id === "chat").model_id,
      "handoff-model",
    );
    assert.equal(
      s.settings[0].state.binding.runtimeGeneration,
      "replacement-runtime",
    );
  }
  await run(
    "guard",
    "committed destination still waits for durable worker selection",
    { runtime: "replacement-runtime" },
    { error: true, code: "native-runtime-handoff-pending" },
  );
  await run(
    "guard",
    "actual destination attachment remains allowed before final acknowledgement",
    {
      runtime: "replacement-runtime",
      epoch: "replacement-core",
      access: "attach",
    },
  );
  await run(
    "cancel",
    "cancellation cannot overtake an already committed handoff",
    {},
    { error: true, code: "handoff-already-committed" },
  );
  await run(
    "finish",
    "worker acknowledgement completes actual provider selection",
    { outcome: "completed" },
  );
  await run(
    "finish",
    "duplicate completion cannot advance the queue revision twice",
    { outcome: "completed" },
  );
  await run(
    "guard",
    "retired source remains fenced after handoff completion",
    { runtime: "runtime", epoch: "epoch" },
    { error: true, code: "native-runtime-retired" },
  );
  await run("guard", "acknowledged destination may admit native input", {
    runtime: "replacement-runtime",
    epoch: "replacement-core",
  });
  await run("failure", "late failure cannot overwrite terminal handoff state", {
    errorCode: "worker-unavailable",
  });
  values = await run(
    "active",
    "completed handoff is no longer an active reconnect reservation",
  );
  for (const v of values) assert.deepEqual(v, []);
  await seed("UPDATE native_runtime_handoffs SET binding=NULL");
  values = await run(
    "get",
    "legacy committed rows expose only the matching actual canonical binding",
  );
  for (const v of values)
    assert.equal(v.binding.runtimeGeneration, "replacement-runtime");
  state = await snapshot("legacy binding read does not mutate its old receipt");
  for (const s of state) assert.equal(s.handoffs[0].binding, null);
  await reopen(
    "completed handoff and retired source survive actual database reopen",
  );
  await run(
    "guard",
    "reopened handoff still rejects retired native source",
    { runtime: "runtime", epoch: "epoch" },
    { error: true, code: "native-runtime-retired" },
  );
  await clean();
  await begin();
  await prepare();
  await run("cancel", "reserve cancellation against actual prepared state");
  await run(
    "commit",
    "reserved cancellation blocks a late commit",
    {},
    { error: true, code: "handoff-cancel-requested" },
  );
  await run(
    "finish",
    "owning worker acknowledges restored source after cancellation",
    { outcome: "cancelled" },
  );
  await run(
    "guard",
    "cancelled destination remains retired",
    { runtime: "target-runtime", epoch: "target-core" },
    { error: true, code: "native-runtime-retired" },
  );
  await run("guard", "cancelled transfer retains the original source", {
    runtime: "runtime",
    epoch: "epoch",
  });
  state = await snapshot(
    "cancellation preserves original routing and stored settings",
  );
  for (const s of state) {
    assert.equal(s.runtimes[0].model_route_id, "bootstrap-route");
    assert.equal(s.handoffs[0].phase, "cancelled");
  }
  await clean();
  await begin();
  const sourceRestart = prepared({
    runtimeGeneration: "source-restarted",
    reasoningEffort: "high",
  });
  sourceRestart.snapshot.context = {
    ...sourceRestart.snapshot.context,
    runtimeGeneration: "source-restarted",
    settingsVersion: { epoch: "source-restarted-core", revision: "0" },
  };
  sourceRestart.snapshot.modelAttribution = {
    fingerprint: "d".repeat(64),
    selection: {
      status: "resolved",
      workerId: "alpha",
      providerId: "bootstrap-provider",
      providerAccountId: null,
      modelId: "bootstrap-model",
      routeId: "bootstrap-route",
    },
  };
  values = await run(
    "recover",
    "cold source recovery publishes its actual replacement binding",
    (i) => ({
      side: "source",
      expectedBindingId: bindings[i],
      recovered: sourceRestart,
    }),
  );
  for (const v of values) {
    assert.equal(v.source.runtimeGeneration, "runtime");
    assert.equal(v.binding.runtimeGeneration, "source-restarted");
    assert.deepEqual(v.retiredRuntimeGenerations, ["runtime"]);
  }
  await run(
    "recover",
    "identical recovered snapshot may retry after its expected binding advanced",
    {
      side: "source",
      expectedBindingId: "old-retry",
      recovered: sourceRestart,
    },
  );
  await begin("begin retry retains its immutable source after cold recovery");
  await prepare();
  values = await run(
    "commit",
    "commit follows the actually recovered source binding",
  );
  const destinationBindings = values.map((v) => v.binding.bindingId);
  const destinationRestart = prepared({
    runtimeGeneration: "destination-restarted",
  });
  destinationRestart.snapshot.context = {
    ...destinationRestart.snapshot.context,
    runtimeGeneration: "destination-restarted",
    settingsVersion: { epoch: "destination-restarted-core", revision: "0" },
  };
  values = await run(
    "recover",
    "cold destination recovery retains reserved route and thread",
    (i) => ({
      side: "destination",
      expectedBindingId: destinationBindings[i],
      recovered: destinationRestart,
    }),
  );
  for (const v of values) {
    assert.equal(v.source.runtimeGeneration, "runtime");
    assert.equal(v.binding.runtimeGeneration, "destination-restarted");
    assert.equal(v.prepared.runtimeGeneration, "destination-restarted");
  }
  await run(
    "recover",
    "retired destination cannot overwrite a newer recovered incarnation",
    (i) => ({
      side: "destination",
      expectedBindingId: destinationBindings[i],
      recovered: prepared(),
    }),
    { error: true, code: "handoff-recovery-source-mismatch" },
  );
  await run(
    "finish",
    "recovered destination acknowledgement completes its real handoff",
    { outcome: "completed" },
  );
  await snapshot(
    "cold recovery persists both retirement history and canonical settings",
  );
  await clean();
  await begin();
  await prepare();
  await seed(
    "CREATE OR REPLACE FUNCTION handoff_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='committed' THEN RAISE EXCEPTION 'handoff commit fault'; END IF; RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER handoff_commit_fault BEFORE UPDATE ON native_runtime_handoffs FOR EACH ROW EXECUTE FUNCTION handoff_commit_fault()",
  );
  const before = await snapshot("before actual late handoff SQL failure");
  try {
    await run(
      "commit",
      "late handoff SQL failure rolls back every earlier write",
      {},
      { error: true, sqlstate: "P0001" },
    );
    assert.deepEqual(
      await snapshot(
        "actual handoff commit failure leaves no partial route/settings write",
      ),
      before,
    );
  } finally {
    await seed("DROP TRIGGER handoff_commit_fault ON native_runtime_handoffs");
    await seed("DROP FUNCTION handoff_commit_fault()");
  }
  await run(
    "commit",
    "actual commit retries successfully after transactional fault removal",
  );
  await snapshot("retry commits exactly the actual destination binding");
  const service = (name, fields = {}, options = {}) =>
    run(
      "service",
      name,
      (i) => ({
        input: {
          operationId: handoffOperation,
          bindingId: bindings[i],
          targetModelRouteId: "handoff-route",
          targetProviderAccountId: null,
        },
        prepared: prepared(),
        ...fields,
      }),
      options,
    );
  await clean();
  values = await service(
    "handoff coordinator returns its reservation while actual worker completion proceeds",
    { mode: "complete" },
  );
  for (const v of values) {
    assert.equal(v.reply.phase, "preparing");
    assert.equal(v.state.phase, "completed");
    assert.equal(v.commands[0].timeoutMs, null);
    assert.equal(v.commands[0].owner, owner);
    assert.equal(v.events.length, 2);
  }
  await snapshot(
    "controlled worker completion commits the actual handoff route and settings",
  );
  await clean();
  values = await service(
    "beginAndWait accepts only actual durable destination acknowledgement",
    { method: "wait", mode: "complete" },
  );
  for (const v of values) assert.equal(v.reply.phase, "completed");
  await clean();
  await service(
    "early worker reply cannot authorize destination input",
    { method: "wait", mode: "early" },
    { error: true, code: "handoff-not-completed" },
  );
  await snapshot("early reply retains actual preparing reservation");
  await clean();
  await service(
    "worker transport failure persists public diagnostic before rejecting account switch",
    { method: "wait", mode: "fail" },
    { error: true, code: "handoff-worker-unavailable" },
  );
  state = await snapshot(
    "failed transport leaves source unchanged with retriable handoff",
  );
  for (const s of state) {
    assert.equal(s.handoffs[0].error_code, "handoff-worker-unavailable");
    assert.equal(s.runtimes[0].model_route_id, "bootstrap-route");
  }
  values = await service(
    "retry resumes actual durable reservation after worker failure",
    { method: "retry", mode: "complete" },
  );
  for (const v of values) {
    assert.equal(v.reply.errorCode, "handoff-worker-unavailable");
    assert.equal(v.state.phase, "completed");
    assert.equal(v.events.length, 1);
  }
  await clean();
  await begin();
  values = await service(
    "cancel coordinator preserves actual cancellation intent through worker acknowledgement",
    { method: "cancel", mode: "complete" },
  );
  for (const v of values) {
    assert.equal(v.reply.cancelRequested, true);
    assert.equal(v.commands[0].command.intent, "cancel");
    assert.equal(v.state.phase, "cancelled");
  }
  await clean();
  await begin();
  values = await service(
    "authenticated worker reconnect joins the actual in-flight handoff",
    { method: "reconnect", mode: "complete" },
  );
  for (const v of values) {
    assert.equal(v.state.phase, "completed");
    assert.equal(v.commands.length, 1);
  }
  await snapshot("reconnect completes durable handoff and queue wake");
}
