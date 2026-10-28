import assert from "node:assert/strict";
import {
  chatGptCatalogModel,
  quotaSnapshot,
} from "./settings-provider-fixtures.mjs";

export async function chatGptCases({
  seed,
  compare,
  unchanged,
  literal,
  envelope,
}) {
  const owner = "chatgpt-catalog-owner",
    provider = "chatgpt-service",
    worker = "chatgpt-catalog-worker";
  const primary = "88888888-8888-4888-8888-888888888885",
    second = "88888888-8888-4888-8888-888888888886",
    disabled = "88888888-8888-4888-8888-888888888887",
    legacy = "88888888-8888-4888-8888-888888888888";
  await seed(
    `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(owner)},'account','member','active','Catalog fixture','catalog@example.invalid','catalog@example.invalid');`,
  );
  await compare("initialize account catalog owner", {
    op: "ensure-account",
    owner,
  });
  await compare("create ChatGPT provider with legacy initial credential home", {
    op: "provider-create",
    owner,
    input: {
      id: provider,
      name: provider,
      kind: "chatgpt",
      baseUrl: "https://chatgpt.com",
      protectedApiKey: null,
      initialAccount: { id: primary, protectedLabel: envelope },
    },
  });
  for (const id of [second, disabled, legacy])
    await compare("create account catalog sign-in " + id, {
      op: "account-create",
      owner,
      provider,
      input: { id, protectedLabel: envelope },
    });
  await compare("create non-account family for catalog authorization", {
    op: "provider-create",
    owner,
    input: {
      id: "chatgpt-wrong-family",
      name: "Other",
      kind: "openai-compatible",
      baseUrl: "https://fixture.invalid",
      protectedApiKey: null,
    },
  });
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(worker)},${literal(owner)},'Catalog worker','linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z');`,
  );
  for (const statement of [
    `UPDATE model_provider_accounts SET credential_state='signed-out',plan_type='free' WHERE provider_id=${literal(provider)};`,
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(primary)};`,
    `UPDATE model_provider_accounts SET enabled=false WHERE id=${literal(disabled)};`,
    `UPDATE model_provider_accounts SET credential_state='migration-needed' WHERE id=${literal(legacy)};`,
    `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state) VALUES(${literal(legacy)},${literal(worker)},'signed-in');`,
  ])
    await seed(statement);
  const visible = {
    ...chatGptCatalogModel,
    model: "gpt-visible",
    displayName: "Visible",
  };
  const hidden = {
    ...chatGptCatalogModel,
    id: "hidden",
    model: "gpt-hidden",
    displayName: "Hidden",
    hidden: true,
    isDefault: true,
  };
  const inventory = {
    models: [visible, hidden],
    observedAt: "2026-10-27T00:00:00.000Z",
  };
  const call = (extra = {}) => ({
    op: "chatgpt-get",
    owner,
    provider,
    worker,
    input: { connected: true, inventory },
    ...extra,
  });
  const read = (label, extra = {}) => compare(label, call(extra));
  const query = (label, sql) =>
    compare(
      label,
      { op: "query-json", owner, sql },
      {
        fixedDates: [
          "observed_at",
          "resets_at",
          "credits_observed_at",
          "weekly_observed_at",
        ],
      },
    );
  for (const [label, extra, message] of [
    ["missing provider", { provider: "missing", worker: "missing" }, null],
    [
      "foreign owner",
      { owner: "quota-other", worker: "quota-foreign-worker" },
      null,
    ],
    ["missing worker", { worker: "missing" }, "Worker not found."],
    ["foreign worker", { worker: "quota-worker" }, "Worker not found."],
    [
      "wrong family",
      { provider: "chatgpt-wrong-family" },
      "Provider is not a ChatGPT provider.",
    ],
    [
      "worker check precedes family check",
      { provider: "chatgpt-wrong-family", worker: "missing" },
      "Worker not found.",
    ],
    [
      "offline worker",
      { input: { connected: false, inventory } },
      "Worker is offline.",
    ],
    [
      "missing requested account",
      { account: "missing" },
      "ChatGPT account not found.",
    ],
    [
      "disabled requested account",
      { account: disabled },
      "ChatGPT account not found.",
    ],
  ]) {
    const result = await unchanged("ChatGPT " + label, call(extra));
    assert.equal(result.error ?? result.result, message);
    assert.equal(result.calls.length, 0);
  }
  let result = await read(
    "signed-in and known legacy accounts discover sequentially",
  );
  assert.equal(result.result.models.length, 2);
  assert.equal(result.result.servedStale, false);
  assert.deepEqual(
    result.calls.map((call) => call.command.provider.accountId),
    [primary, legacy],
  );
  assert.deepEqual(
    result.calls.map((call) => call.command.provider.credentialHomeKey),
    [provider, legacy],
  );
  assert.ok(
    result.calls.every(
      (call) =>
        call.options.timeoutMs === 120000 && call.options.ownerId === owner,
    ),
  );
  const visibleId = result.result.models.find(
    (model) => model.nativeModelId === "gpt-visible",
  ).id;
  let settings = await compare(
    "hidden model metadata never creates a logical profile",
    { op: "settings", owner },
  );
  assert.equal(settings.models.length, 1);
  assert.equal(
    settings.preferences.defaultModelId,
    "discovered:model:" + visibleId,
  );
  assert.equal(
    result.result.syncStates.find((state) => state.providerAccountId === second)
      .status,
    "current",
  );
  await seed(
    `UPDATE provider_catalog_sync_states SET last_success_at='2030-01-01T00:00:00Z' WHERE provider_id=${literal(provider)};`,
  );
  result = await unchanged(
    "fresh per-account cache performs no worker requests",
    call(),
  );
  assert.equal(result.calls.length, 0);
  assert.equal(result.result.servedStale, false);
  result = await unchanged(
    "offline account catalog rejects even with a fresh cache",
    call({ input: { connected: false, inventory } }),
  );
  assert.equal(result.error, "Worker is offline.");
  result = await read(
    "requested forced refresh returns retained stale data on failure",
    {
      force: true,
      account: primary,
      input: {
        connected: true,
        error: "Controlled account discovery failure.",
      },
    },
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.result.servedStale, true);
  assert.equal(
    result.result.models.find((model) => model.nativeModelId === "gpt-visible")
      .id,
    visibleId,
  );
  const snapshot = {
    ...quotaSnapshot,
    snapshotId: "chatgpt-snapshot",
    observedAt: "2031-01-01T00:00:00.000Z",
  };
  result = await read(
    "one successful account overrides another account failure without hiding its sync state",
    {
      force: true,
      input: {
        connected: true,
        responses: {
          [primary]: {
            inventory: {
              ...inventory,
              quotaSnapshot: snapshot,
              weeklyUsage: { usedPercent: 99, resetsAt: 0 },
            },
          },
          [legacy]: { error: "Controlled legacy failure." },
        },
      },
    },
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(
    result.result.syncStates.find((state) => state.providerAccountId === legacy)
      .status,
    "stale",
  );
  let projection = await query(
    "quota snapshot takes precedence over legacy weekly usage",
    `SELECT jsonb_build_object('used',weekly_usage_used_basis_points,'plan',plan_type,'credits',credits,'auth_at',auth_last_synced_at) AS result FROM model_provider_accounts WHERE id=${literal(primary)}`,
  );
  assert.equal(projection.used, 1235);
  assert.equal(projection.plan, "pro");
  assert.equal(projection.credits.balance, "12.50");
  assert.equal(projection.auth_at, null);
  let rows = await query(
    "catalog snapshot stores account dimensions and automatic trigger",
    `SELECT coalesce(jsonb_agg(to_jsonb(q)-'id'-'received_at' ORDER BY event_key),'[]'::jsonb) AS result FROM provider_quota_observations q WHERE provider_id=${literal(provider)}`,
  );
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.observation_trigger === "manual-refresh" &&
        row.worker_id === worker &&
        row.provider_account_id === primary,
    ),
  );
  await read("legacy weekly usage is persisted when no snapshot is supplied", {
    force: true,
    account: primary,
    input: {
      connected: true,
      inventory: {
        ...inventory,
        weeklyUsage: { usedPercent: 17.25, resetsAt: 0 },
      },
    },
  });
  projection = await query(
    "legacy weekly fallback updates authentication observation and zero reset semantics",
    `SELECT jsonb_build_object('used',weekly_usage_used_basis_points,'resets_at',weekly_usage_resets_at,'auth_at',auth_last_synced_at) AS result FROM model_provider_accounts WHERE id=${literal(primary)}`,
  );
  assert.equal(projection.used, 1725);
  assert.equal(projection.resets_at, null);
  assert.ok(projection.auth_at);
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE provider_id=${literal(provider)};`,
  );
  result = await read(
    "all signed-out accounts retain catalog metadata with unavailable scopes",
    { force: true },
  );
  assert.equal(result.result.servedStale, true);
  assert.equal(result.calls.length, 0);
  assert.ok(
    result.result.availability.every((row) => row.state === "unavailable"),
  );
  result = await unchanged(
    "current unavailable scopes still use the per-account cache",
    call(),
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(result.calls.length, 0);
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(primary)};`,
  );
  await seed(
    `ALTER TABLE provider_models ADD CONSTRAINT fixture_chatgpt_model CHECK(provider_id<>${literal(provider)} OR native_model_id<>'rejected-model');`,
  );
  const rejectedModel = {
    ...visible,
    id: "rejected",
    model: "rejected-model",
    displayName: "Rejected",
  };
  const beforeFault = {
    ...snapshot,
    snapshotId: "before-catalog-failure",
    observedAt: "2033-01-01T00:00:00.000Z",
    credits: { hasCredits: true, unlimited: false, balance: "5.00" },
  };
  const recovery = {
    force: true,
    account: primary,
    input: {
      connected: true,
      inventory: {
        models: [rejectedModel],
        observedAt: inventory.observedAt,
        quotaSnapshot: beforeFault,
      },
    },
  };
  result = await read(
    "quota commits survive a subsequent catalog transaction failure",
    { ...recovery, trigger: "catalog-test" },
  );
  assert.equal(result.result.servedStale, true);
  assert.equal(
    result.result.models.some(
      (model) => model.nativeModelId === "rejected-model",
    ),
    false,
  );
  projection = await query(
    "credits preceding catalog failure remain committed",
    `SELECT jsonb_build_object('credits',credits) AS result FROM model_provider_accounts WHERE id=${literal(primary)}`,
  );
  assert.equal(projection.credits.balance, "5.00");
  const countSQL = `SELECT to_jsonb(count(*)::integer) AS result FROM provider_quota_observations WHERE provider_id=${literal(provider)} AND observation_batch_key='before-catalog-failure'`;
  assert.equal(
    await query(
      "quota windows preceding catalog failure remain committed",
      countSQL,
    ),
    2,
  );
  await seed(
    "ALTER TABLE provider_models DROP CONSTRAINT fixture_chatgpt_model;",
  );
  result = await read(
    "catalog retry preserves quota idempotency and converges its state",
    recovery,
  );
  assert.equal(result.result.servedStale, false);
  const rejectedId = result.result.models.find(
    (model) => model.nativeModelId === "rejected-model",
  ).id;
  assert.equal(
    await query("catalog retry never duplicates quota windows", countSQL),
    2,
  );
  await compare("user suppresses discovered account model", {
    op: "model-delete",
    owner,
    model: "discovered:model:" + rejectedId,
  });
  await read("later account refresh respects user suppression", {
    force: true,
    account: primary,
    input: {
      connected: true,
      inventory: { models: [rejectedModel], observedAt: inventory.observedAt },
    },
  });
  settings = await compare("suppressed account profile is not recreated", {
    op: "settings",
    owner,
  });
  assert.equal(
    settings.models.some(
      (model) => model.id === "discovered:model:" + rejectedId,
    ),
    false,
  );
  await compare(
    "explicit account invalidation updates availability and current sync",
    { op: "chatgpt-unavailable", owner, provider, account: primary },
  );
  result = await compare("read explicitly invalidated account catalog", {
    op: "catalog-get",
    owner,
    provider,
  });
  assert.ok(
    result.availability
      .filter((row) => row.providerAccountId === primary)
      .every((row) => row.state === "unavailable"),
  );
  // Start a separate installation to exercise failure paths with no retained models.
  const emptyOwner = "chatgpt-empty-owner",
    emptyProvider = "chatgpt-empty",
    emptyAccount = "88888888-8888-4888-8888-888888888889",
    emptyWorker = "chatgpt-empty-worker";
  await seed(
    `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(emptyOwner)},'account','member','active','Empty fixture','empty-catalog@example.invalid','empty-catalog@example.invalid');`,
  );
  await compare("initialize empty account catalog owner", {
    op: "ensure-account",
    owner: emptyOwner,
  });
  await compare("create empty ChatGPT catalog", {
    op: "provider-create",
    owner: emptyOwner,
    input: {
      id: emptyProvider,
      name: emptyProvider,
      kind: "chatgpt",
      baseUrl: "https://chatgpt.com",
      protectedApiKey: null,
      initialAccount: { id: emptyAccount, protectedLabel: envelope },
    },
  });
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(emptyWorker)},${literal(emptyOwner)},'Empty worker','linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z');`,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE id=${literal(emptyAccount)};`,
  );
  const empty = {
    owner: emptyOwner,
    provider: emptyProvider,
    worker: emptyWorker,
  };
  result = await read(
    "no existing catalog and no sign-in yields source error",
    { ...empty, force: true },
  );
  assert.equal(result.error, "No signed-in ChatGPT account is available.");
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(emptyAccount)};`,
  );
  result = await read(
    "uncached account failure propagates its original error",
    {
      ...empty,
      force: true,
      input: {
        connected: true,
        error: "Controlled uncached discovery failure.",
      },
    },
  );
  assert.equal(result.error, "Controlled uncached discovery failure.");
  result = await read(
    "malformed uncached inventory retains exact validation error",
    {
      ...empty,
      force: true,
      input: {
        connected: true,
        inventory: { ...inventory, models: [{ ...visible, hidden: null }] },
      },
    },
  );
  assert.ok(result.error.includes("hidden"));
  result = await read(
    "empty successful discovery is a successful account refresh",
    {
      ...empty,
      input: { connected: true, inventory: { ...inventory, models: [] } },
    },
  );
  assert.equal(result.result.models.length, 0);
  assert.equal(result.result.servedStale, false);
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE id=${literal(emptyAccount)};`,
  );
  result = await unchanged(
    "fresh empty cache precedes credential-state inspection",
    call({
      ...empty,
      input: { connected: true, inventory: { ...inventory, models: [] } },
    }),
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(result.calls.length, 0);
}
