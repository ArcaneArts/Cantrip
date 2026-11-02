import assert from "node:assert/strict";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
import { handoffPrepared } from "./native-handoff-wire-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
export async function runAccountFailoverCases(h) {
  const { observe, reset, seed, snapshot, owner } = h;
  const provider = "account-transfer-provider",
    model = "account-transfer-model",
    route = "account-transfer-route",
    source = "account-transfer-source",
    target = "account-transfer-credit";
  const credits = { hasCredits: true, unlimited: false, balance: "250.00" };
  const prepared = handoffPrepared();
  prepared.snapshot.modelAttribution = {
    fingerprint: "c".repeat(64),
    selection: {
      status: "resolved",
      workerId: "alpha",
      providerId: provider,
      providerAccountId: target,
      modelId: model,
      routeId: route,
    },
  };
  async function clean(statements = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      `UPDATE model_providers SET kind='openai-compatible' WHERE owner_id=${literal(owner)} AND kind='chatgpt' AND id<>'${provider}'`,
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,weekly_usage_reserve_percent) VALUES('${provider}',${literal(owner)},'Account transfer','chatgpt','https://chatgpt.com',3) ON CONFLICT DO NOTHING`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('${model}',${literal(owner)},'Account transfer') ON CONFLICT DO NOTHING`,
      `INSERT INTO model_routes(id,model_id,provider_id,model_name,enabled) VALUES('${route}','${model}','${provider}','gpt-fixture',true) ON CONFLICT DO NOTHING`,
      `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position) VALUES('${source}','${provider}','{}'::jsonb,'source-home',0),('${target}','${provider}','{}'::jsonb,'credit-home',1) ON CONFLICT DO NOTHING`,
      `UPDATE model_providers SET kind='chatgpt' WHERE id='${provider}'`,
      `UPDATE model_routes SET enabled=true,provider_model_id=NULL WHERE id='${route}'`,
      "DELETE FROM provider_model_availability WHERE provider_model_id='account-transfer-catalog'",
      "DELETE FROM provider_models WHERE id='account-transfer-catalog'",
      `UPDATE model_provider_accounts SET credential_state='signed-in',enabled=true,weekly_usage_used_basis_points=10000,credits=NULL WHERE provider_id='${provider}'`,
      `UPDATE model_provider_accounts SET credits=${json(credits)} WHERE id='${target}'`,
      `DELETE FROM model_provider_account_workers WHERE account_id IN ('${source}','${target}')`,
      `UPDATE chats SET model_id='${model}',experience='agent',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id='chat'`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('77777777-7777-4777-8777-000000000085','chat','alpha','github-alpha-main','thread','${route}','${source}','ready')`,
      ...statements,
    ]);
    await observe(
      "bind actual account source settings",
      { chat: "chat", snapshot: settingsSnapshot },
      { op: "native-command-settings-refresh", shape: "raw" },
    );
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        chat: "chat",
        expected: 0,
        mode: "complete",
        checkConfiguration: true,
        prepared,
        ...fields,
      },
      { op: "native-command-account-prepare", shape: "raw" },
    );
  function transferred(values, { results = 1, held = false } = {}) {
    for (const value of values) {
      assert.equal(value.commands.length, 1);
      assert.equal(value.pendingWhileHeld, held);
      assert.equal(value.results.length, results);
      for (const item of value.results) {
        assert.equal(item.value.providerAccountId, target);
        assert.equal(item.value.modelRouteId, route);
        assert.equal(item.value.threadId, "thread");
      }
      assert.equal(value.events.length, 2);
      assert.deepEqual(value.configurations, [
        {
          side: "source",
          accountId: source,
          home: "source-home",
          route,
          thread: "thread",
        },
        {
          side: "destination",
          accountId: target,
          home: "credit-home",
          route,
          thread: "thread",
        },
      ]);
    }
  }
  async function unchanged(name, statements = [], fields = {}) {
    await clean(statements);
    const before = await snapshot("before " + name);
    const values = await run(name, fields);
    for (const value of values) {
      assert.equal(value.commands.length, 0);
      assert.deepEqual(value.events, []);
      assert.equal(value.results[0].value.providerAccountId, source);
    }
    assert.deepEqual(await snapshot("unchanged " + name), before);
  }
  await clean();
  transferred(
    await run(
      "depleted account moves to credits before admission and subsequent preparation retains the destination",
      { again: true },
    ),
    { results: 2 },
  );
  let state = await snapshot(
    "actual account transfer retains conversation and commits destination binding",
  );
  for (const s of state) {
    assert.equal(s.handoffs.length, 1);
    assert.equal(s.handoffs[0].phase, "completed");
    assert.equal(s.handoffs[0].target_provider_account_id, target);
    assert.equal(s.handoffs[0].source.providerAccountId, source);
    assert.equal(s.handoffs[0].binding.providerAccountId, target);
  }
  await clean();
  transferred(
    await run(
      "concurrent account preparation shares one durable handoff even with a stale joining revision",
      { concurrent: true },
    ),
    { results: 2, held: true },
  );
  await clean();
  transferred(
    await run(
      "dropping the first account waiter retains real transfer and shutdown ownership",
      { concurrent: true, dropFirst: true },
    ),
    { held: true },
  );
  await clean();
  transferred(
    await run(
      "dropping every account waiter still commits the transfer before owned work drains",
      { concurrent: true, dropAll: true },
    ),
    { held: true },
  );
  await clean();
  transferred(
    await run(
      "production queue adapter uses its captured revision and the same actual transfer",
      { queued: true, expected: null },
    ),
  );
  await clean();
  let values = await run(
    "shared worker failure preserves typed handoff errors and later automatic attempt respects the existing reservation",
    { mode: "fail", concurrent: true, again: true },
  );
  for (const v of values) {
    assert.equal(v.commands.length, 1);
    assert.equal(v.pendingWhileHeld, true);
    assert.deepEqual(
      v.results.map((r) => r.error.code),
      [
        "handoff-worker-unavailable",
        "handoff-worker-unavailable",
        "native-runtime-handoff-pending",
      ],
    );
    for (const r of v.results) {
      assert.equal(r.error.kind, "native-command");
      assert.equal(r.error.status, 409);
    }
  }
  state = await snapshot(
    "failed account handoff retains actual source and retriable preparing reservation",
  );
  for (const s of state) {
    assert.equal(s.handoffs[0].phase, "preparing");
    assert.equal(s.handoffs[0].binding.providerAccountId, source);
  }
  await clean();
  values = await run(
    "early worker transport reply cannot complete automatic account transfer",
    { mode: "early" },
  );
  for (const v of values) {
    assert.equal(v.results[0].error.code, "handoff-not-completed");
    assert.equal(v.results[0].error.status, 409);
  }
  await unchanged("partly used current account is retained", [
    `UPDATE model_provider_accounts SET weekly_usage_used_basis_points=9999 WHERE id='${source}'`,
  ]);
  await unchanged("unknown weekly usage does not force a transfer", [
    `UPDATE model_provider_accounts SET weekly_usage_used_basis_points=NULL WHERE id='${source}'`,
  ]);
  for (const [name, balance, unlimited] of [
    ["current credits remain in use", "100.01", false],
    ["trimmed current credit balance remains in use", " 100.01 ", false],
    ["unlimited current credits remain in use", null, true],
  ]) {
    await unchanged(name, [
      `UPDATE model_provider_accounts SET credits=${json({ hasCredits: true, unlimited, balance })} WHERE id='${source}'`,
    ]);
  }
  for (const balance of ["100.00", "malformed"]) {
    await clean([
      `UPDATE model_provider_accounts SET credits=${json({ hasCredits: true, unlimited: false, balance })} WHERE id='${source}'`,
    ]);
    transferred(
      await run(
        "depleted current balance " + balance + " chooses actual alternative",
      ),
    );
  }
  await unchanged("no routable alternative never blocks the current turn", [
    `UPDATE model_provider_accounts SET credits=NULL WHERE id='${target}'`,
  ]);
  await unchanged("disabled alternative is not selected", [
    `UPDATE model_provider_accounts SET enabled=false WHERE id='${target}'`,
  ]);
  await unchanged("signed-out alternative is not selected", [
    `UPDATE model_provider_accounts SET credential_state='reauth-required' WHERE id='${target}'`,
  ]);
  const catalog = [
    `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source) VALUES('account-transfer-catalog','${provider}','gpt-fixture','GPT fixture','manual') ON CONFLICT DO NOTHING`,
    `UPDATE model_routes SET provider_model_id='account-transfer-catalog' WHERE id='${route}'`,
  ];
  await unchanged(
    "unknown model availability does not select an account or block the original turn",
    catalog,
  );
  await clean([
    ...catalog,
    `INSERT INTO provider_model_availability(id,provider_model_id,scope_key,provider_account_id,state) VALUES('account-transfer-availability','account-transfer-catalog','account:credit','${target}','available')`,
  ]);
  transferred(
    await run("actual catalog availability selects only the matching account"),
  );
  await clean([
    `UPDATE model_provider_accounts SET credential_state='migration-needed',credits=NULL WHERE id='${target}'`,
    `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state) VALUES('${target}','alpha','signed-in')`,
  ]);
  transferred(
    await run(
      "authenticated legacy account remains the actual migration fallback",
    ),
  );
  await unchanged("automatic account transfer is limited to ChatGPT", [
    `UPDATE model_providers SET kind='openai-compatible' WHERE id='${provider}'`,
  ]);
  await unchanged(
    "stale input revision cannot start a native account transfer",
    [],
    { expected: 1 },
  );
  await unchanged(
    "explicit null revision cannot start a native account transfer",
    [],
    { expected: null },
  );
  await clean();
  values = await observe(
    "missing revision remains undefined rather than zero",
    { chat: "chat", mode: "complete", prepared },
    { op: "native-command-account-prepare", shape: "raw" },
  );
  for (const v of values) assert.equal(v.commands.length, 0);
  await unchanged("an active execution lane cannot be migrated", [
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,codex_thread_id) VALUES('account-active-lane','chat','github-alpha-main','alpha','gui','active','thread')",
  ]);
  for (const [name, sql] of [
    [
      "non-agent conversation",
      "UPDATE chats SET experience='task' WHERE id='chat'",
    ],
    [
      "missing native thread",
      "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id='chat'",
    ],
    [
      "missing bound route",
      "UPDATE chat_runtime_sessions SET model_route_id=NULL WHERE chat_id='chat'",
    ],
  ]) {
    await clean();
    await seed(sql);
    const before = await snapshot("before account preparation for " + name);
    values = await run(name + " does not start an automatic transfer");
    for (const v of values) assert.equal(v.commands.length, 0);
    assert.deepEqual(
      await snapshot("unchanged account preparation for " + name),
      before,
    );
  }
  for (const key of [
    "threadId",
    "workerId",
    "modelRouteId",
    "providerAccountId",
  ]) {
    await clean();
    await seed(
      `UPDATE native_settings_states SET state=jsonb_set(state,'{binding,${key}}','"replaced-identity"'::jsonb) WHERE chat_id='chat'`,
    );
    const before = await snapshot(
      "before account binding " + key + " replacement",
    );
    values = await run(
      "replaced canonical " + key + " is reread without transferring",
    );
    for (const v of values) {
      assert.equal(v.commands.length, 0);
      assert.equal(v.results[0].value.providerAccountId, source);
    }
    assert.deepEqual(
      await snapshot("unchanged account binding " + key + " replacement"),
      before,
    );
  }
  await clean();
  await seed(
    "UPDATE native_settings_states SET state=jsonb_set(state,'{binding}','null'::jsonb) WHERE chat_id='chat'",
  );
  values = await run(
    "missing canonical binding does not authorize an account transfer",
  );
  for (const v of values) assert.equal(v.commands.length, 0);
  await clean([`UPDATE model_routes SET enabled=false WHERE id='${route}'`]);
  values = await run(
    "configured disabled route reaches real handoff target validation",
  );
  for (const v of values) {
    assert.equal(v.results[0].error.code, "handoff-target-not-found");
    assert.equal(v.commands.length, 0);
  }
}
