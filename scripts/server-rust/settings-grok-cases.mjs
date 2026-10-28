import assert from "node:assert/strict";
import {
  grokCatalogModel,
  quotaSnapshot,
} from "./settings-provider-fixtures.mjs";

export async function grokCases({
  seed,
  compare,
  unchanged,
  literal,
  envelope,
}) {
  const owner = "grok-catalog-owner",
    provider = "grok-service",
    worker = "grok-catalog-worker";
  const primary = "99999999-9999-4999-8999-999999999991",
    second = "99999999-9999-4999-8999-999999999992",
    legacy = "99999999-9999-4999-8999-999999999993";
  await seed(
    `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(owner)},'account','member','active','Grok fixture','grok-catalog@example.invalid','grok-catalog@example.invalid')`,
  );
  await compare("initialize Grok catalog owner", {
    op: "ensure-account",
    owner,
  });
  await compare("create Grok provider", {
    op: "provider-create",
    owner,
    input: {
      id: provider,
      name: "Grok",
      kind: "grok",
      baseUrl: "https://grok.com",
      protectedApiKey: null,
      initialAccount: { id: primary, protectedLabel: envelope },
    },
  });
  for (const id of [second, legacy])
    await compare("create Grok sign-in " + id, {
      op: "account-create",
      owner,
      provider,
      input: { id, protectedLabel: envelope },
    });
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(worker)},${literal(owner)},'Grok worker','linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z')`,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE provider_id=${literal(provider)}`,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(primary)}`,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_state='migration-needed' WHERE id=${literal(legacy)}`,
  );
  await seed(
    `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state) VALUES(${literal(legacy)},${literal(worker)},'signed-in')`,
  );
  await compare("create wrong Grok family", {
    op: "provider-create",
    owner,
    input: {
      id: "grok-wrong",
      name: "Custom",
      kind: "openai-compatible",
      baseUrl: "https://fixture.invalid",
      protectedApiKey: null,
    },
  });
  const visible = {
      ...grokCatalogModel,
      id: "grok-visible",
      displayName: "Visible",
    },
    hidden = {
      ...grokCatalogModel,
      id: "grok-hidden",
      displayName: "Hidden",
      hidden: true,
    };
  const inventory = {
    models: [visible, hidden],
    observedAt: "2026-10-27T00:00:00.000Z",
  };
  const call = (extra = {}) => ({
    op: "grok-get",
    owner,
    provider,
    worker,
    input: { connected: true, inventory },
    ...extra,
  });
  const read = (label, extra = {}) => compare(label, call(extra));
  for (const [label, extra, error] of [
    ["missing provider", { provider: "missing", worker: "missing" }, null],
    ["foreign provider", { owner: "quota-other" }, null],
    ["missing worker", { worker: "missing" }, "Worker not found."],
    ["foreign worker", { worker: "quota-worker" }, "Worker not found."],
    [
      "wrong family",
      { provider: "grok-wrong" },
      "Provider is not a Grok provider.",
    ],
    [
      "worker check precedes family",
      { provider: "grok-wrong", worker: "missing" },
      "Worker not found.",
    ],
    [
      "offline worker",
      { input: { connected: false, inventory } },
      "Worker is offline.",
    ],
    ["missing account", { account: "missing" }, "Grok account not found."],
  ]) {
    const result = await unchanged("Grok " + label, call(extra));
    assert.equal(result.error ?? result.result, error);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.publicCalls, []);
    assert.deepEqual(result.diagnostics, []);
  }
  let result = await read(
    "Grok worker vision skips public metadata and discovers legacy credential homes",
  );
  assert.equal(result.result.models.length, 2);
  assert.deepEqual(result.publicCalls, []);
  assert.deepEqual(
    result.calls.map((c) => c.command.provider.credentialHomeKey),
    [provider, legacy],
  );
  assert.ok(
    result.calls.every(
      (c) =>
        c.command.type === "model.grok.catalog" &&
        c.command.provider.name === "Grok" &&
        c.options.timeoutMs === 120000 &&
        c.options.ownerId === owner,
    ),
  );
  let settings = await compare(
    "Grok hidden models never create logical profiles",
    { op: "settings", owner },
  );
  assert.equal(settings.models.length, 1);
  const missingVision = {
    ...inventory,
    models: [
      { ...visible, inputModalities: ["text"] },
      { ...hidden, inputModalities: ["text"] },
    ],
  };
  const publicPayload = {
    data: [
      {
        id: "x-ai/grok-visible",
        architecture: { input_modalities: ["text", "image"] },
      },
    ],
  };
  result = await read(
    "Grok shares one lazy public metadata read across sequential accounts",
    {
      force: true,
      now: 1000,
      input: {
        connected: true,
        inventory: missingVision,
        public: { payload: publicPayload, etag: '"grok-public-v1"' },
      },
    },
  );
  assert.equal(result.calls.length, 2);
  assert.equal(result.publicCalls.length, 1);
  assert.deepEqual(result.publicCalls[0], {
    url: "https://openrouter.ai/api/v1/models",
    accept: "application/json",
    etag: null,
    authorization: null,
  });
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-visible")
      .supportsVision,
    true,
  );
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-hidden")
      .supportsVision,
    null,
  );
  result = await read(
    "Grok public failure is optional and warns once per account batch",
    {
      force: true,
      input: {
        connected: true,
        inventory: missingVision,
        public: { error: "controlled public metadata failure" },
      },
    },
  );
  assert.equal(result.calls.length, 2);
  assert.equal(result.publicCalls.length, 1);
  assert.equal(result.result.servedStale, false);
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-visible")
      .supportsVision,
    null,
  );
  assert.deepEqual(result.diagnostics, [
    {
      key: "grok-catalog-openrouter-metadata-unavailable",
      level: "warn",
      message: "Grok catalog capability enrichment is temporarily unavailable",
      context: {
        event: "provider.grok.catalog_enrichment_unavailable",
        subsystem: "provider-catalog",
        operation: "enrich-grok-catalog",
        status: "degraded",
        reasonCode: "openrouter_public_catalog_unavailable",
        error: "controlled public metadata failure",
      },
      options: { summaryEvery: 10, windowMs: 60000 },
    },
  ]);
  const expire = () =>
    seed(
      `UPDATE provider_catalog_sync_states SET last_success_at='1970-01-01T00:00:00Z' WHERE provider_id=${literal(provider)}`,
    );
  await expire();
  result = await read(
    "Grok retains good public metadata after forced failure",
    {
      input: {
        connected: true,
        inventory: missingVision,
        public: { error: "must not fetch" },
      },
    },
  );
  assert.deepEqual(result.publicCalls, []);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-visible")
      .supportsVision,
    true,
  );
  await expire();
  result = await read(
    "Grok stale public metadata returns while refresh starts",
    {
      now: 1100,
      input: {
        connected: true,
        inventory: missingVision,
        public: {
          payload: {
            data: [
              {
                id: "x-ai/grok-visible",
                architecture: { input_modalities: ["text"] },
              },
            ],
          },
          etag: '"grok-public-v2"',
        },
      },
    },
  );
  assert.equal(result.publicCalls.length, 1);
  assert.equal(result.publicCalls[0].etag, '"grok-public-v1"');
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-visible")
      .supportsVision,
    true,
  );
  await expire();
  result = await read(
    "Grok next read sees refreshed public metadata without another request",
    {
      input: {
        connected: true,
        inventory: missingVision,
        public: { error: "must not fetch" },
      },
    },
  );
  assert.deepEqual(result.publicCalls, []);
  assert.equal(
    result.result.models.find((m) => m.nativeModelId === "grok-visible")
      .supportsVision,
    null,
  );
  await seed(
    `UPDATE provider_catalog_sync_states SET last_success_at='2035-01-01T00:00:00Z' WHERE provider_id=${literal(provider)}`,
  );
  result = await unchanged(
    "Grok fresh account cache precedes credential and public metadata reads",
    call(),
  );
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.publicCalls, []);
  result = await unchanged(
    "Grok offline check still precedes fresh cache",
    call({ input: { connected: false, inventory } }),
  );
  assert.equal(result.error, "Worker is offline.");
  const snapshot = {
    ...quotaSnapshot,
    snapshotId: "grok-quota",
    observedAt: "2036-01-01T00:00:00.000Z",
  };
  result = await read(
    "Grok quota snapshot precedes catalog and legacy weekly fallback",
    {
      force: true,
      account: primary,
      input: {
        connected: true,
        inventory: {
          ...inventory,
          quotaSnapshot: snapshot,
          weeklyUsage: { usedPercent: 99, resetsAt: 0 },
        },
      },
    },
  );
  const query = (label, sql) =>
    compare(
      label,
      { op: "query-json", owner, sql },
      { fixedDates: ["observed_at", "resets_at"] },
    );
  let projection = await query(
    "Grok weekly observation advances without ChatGPT-only credits",
    `SELECT jsonb_build_object('used',weekly_usage_used_basis_points,'plan',plan_type,'credits',credits,'auth_at',auth_last_synced_at) AS result FROM model_provider_accounts WHERE id=${literal(primary)}`,
  );
  assert.equal(projection.used, 1235);
  assert.equal(projection.plan, "pro");
  assert.equal(projection.credits, null);
  assert.equal(projection.auth_at, null);
  let rows = await query(
    "Grok quota retains provider family and automatic trigger",
    `SELECT jsonb_agg(to_jsonb(q)-'id'-'received_at' ORDER BY event_key) AS result FROM provider_quota_observations q WHERE provider_id=${literal(provider)}`,
  );
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.provider_kind === "grok" &&
        row.observation_trigger === "manual-refresh",
    ),
  );
  await seed(
    `ALTER TABLE provider_models ADD CONSTRAINT fixture_grok_failure CHECK(provider_id<>${literal(provider)} OR native_model_id<>'grok-rejected')`,
  );
  const recovery = {
    force: true,
    account: primary,
    trigger: "grok-before-catalog",
    input: {
      connected: true,
      inventory: {
        models: [{ ...visible, id: "grok-rejected", displayName: "Rejected" }],
        observedAt: inventory.observedAt,
        quotaSnapshot: {
          ...snapshot,
          snapshotId: "grok-before-catalog",
          observedAt: "2037-01-01T00:00:00.000Z",
        },
      },
    },
  };
  result = await read("Grok catalog failure preserves quota commits", recovery);
  assert.equal(result.result.servedStale, true);
  assert.ok(
    !result.result.models.some((m) => m.nativeModelId === "grok-rejected"),
  );
  const countSQL = `SELECT to_jsonb(count(*)::integer) AS result FROM provider_quota_observations WHERE provider_id=${literal(provider)} AND observation_batch_key='grok-before-catalog'`;
  assert.equal(
    await query("Grok quota windows survive catalog rollback", countSQL),
    2,
  );
  await seed(
    "ALTER TABLE provider_models DROP CONSTRAINT fixture_grok_failure",
  );
  result = await read(
    "Grok retry converges without duplicate observations",
    recovery,
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(await query("Grok retry is idempotent", countSQL), 2);
  const rejectedId = result.result.models.find(
    (m) => m.nativeModelId === "grok-rejected",
  ).id;
  await compare("suppress Grok discovered model", {
    op: "model-delete",
    owner,
    model: "discovered:model:" + rejectedId,
  });
  await read("Grok discovery respects suppression", recovery);
  settings = await compare("suppressed Grok model stays absent", {
    op: "settings",
    owner,
  });
  assert.ok(
    !settings.models.some((m) => m.id === "discovered:model:" + rejectedId),
  );
  result = await compare("explicit Grok unavailable scope", {
    op: "grok-unavailable",
    owner,
    provider,
    account: primary,
  });
  assert.deepEqual(result.publicCalls, []);
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE provider_id=${literal(provider)}`,
  );
  result = await read(
    "Grok signed-out accounts retain metadata with unavailable scopes",
    { force: true },
  );
  assert.equal(result.result.servedStale, true);
  assert.deepEqual(result.calls, []);
  assert.ok(
    result.result.availability.every((row) => row.state === "unavailable"),
  );
  result = await unchanged(
    "Grok current unavailable cache is still fresh",
    call(),
  );
  assert.equal(result.result.servedStale, false);
  assert.deepEqual(result.calls, []);
  const emptyOwner = "grok-empty-owner",
    emptyProvider = "grok-empty",
    emptyAccount = "99999999-9999-4999-8999-999999999994",
    emptyWorker = "grok-empty-worker";
  await seed(
    `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(emptyOwner)},'account','member','active','Empty Grok','grok-empty@example.invalid','grok-empty@example.invalid')`,
  );
  await compare("initialize empty Grok owner", {
    op: "ensure-account",
    owner: emptyOwner,
  });
  await compare("create empty Grok provider", {
    op: "provider-create",
    owner: emptyOwner,
    input: {
      id: emptyProvider,
      name: "Empty",
      kind: "grok",
      baseUrl: "https://grok.com",
      protectedApiKey: null,
      initialAccount: { id: emptyAccount, protectedLabel: envelope },
    },
  });
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(emptyWorker)},${literal(emptyOwner)},'Empty','linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z')`,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-out' WHERE id=${literal(emptyAccount)}`,
  );
  const empty = {
    owner: emptyOwner,
    provider: emptyProvider,
    worker: emptyWorker,
    force: true,
  };
  result = await read(
    "uncached Grok with no sign-in reports exact error",
    empty,
  );
  assert.equal(result.error, "No signed-in Grok account is available.");
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(emptyAccount)}`,
  );
  result = await read("uncached Grok worker error propagates", {
    ...empty,
    input: { connected: true, error: "controlled uncached Grok error" },
  });
  assert.equal(result.error, "controlled uncached Grok error");
  result = await read("uncached Grok invalid inventory retains exact error", {
    ...empty,
    input: {
      connected: true,
      inventory: { ...inventory, models: [{ ...visible, hidden: null }] },
    },
  });
  assert.ok(result.error.includes("hidden"));
  result = await read(
    "empty Grok inventory succeeds without metadata request",
    {
      ...empty,
      input: { connected: true, inventory: { ...inventory, models: [] } },
    },
  );
  assert.equal(result.result.models.length, 0);
  assert.equal(result.result.servedStale, false);
  assert.deepEqual(result.publicCalls, []);
}
