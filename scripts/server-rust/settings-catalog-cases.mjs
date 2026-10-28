import assert from "node:assert/strict";
import { availableCatalogModelIds } from "../../cantrip_app/src/components/settings/provider-catalog-display.ts";

export async function catalogCases({
  seed,
  compare,
  unchanged,
  owner,
  other,
  stamp,
  literal,
  pair,
  report,
}) {
  const provider = "chatgpt";
  const scoped = (op, extra = {}) => ({ op, owner, provider, ...extra });
  const model = (nativeModelId, extra = {}) => ({
    nativeModelId,
    canonicalModelId: "openai/" + nativeModelId,
    displayName: nativeModelId,
    description: null,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsParallelTools: null,
    supportsStructuredOutput: true,
    supportsVision: null,
    supportsReasoning: true,
    supportedReasoningEfforts: [
      { effort: "high", description: "Extended thinking" },
    ],
    defaultReasoningEffort: "high",
    reasoningMandatory: false,
    family: "fixture",
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource: "codex",
    matchConfidenceBasisPoints: 8750,
    rawMetadata: {
      public: { capacity: 3 },
      api_key: "opaque-fixture",
      nested: [{ authorization: "not-in-hash", label: "visible" }],
    },
    ...extra,
  });
  const base = {
    availabilityScope: "worker:fixture",
    availabilityWorkerId: "worker",
    availabilityProviderAccountId: "account",
    autoCreateLogicalModels: false,
    availableNativeModelIds: ["first", "second"],
  };
  const reconcile = (label, models, extra = {}) =>
    compare(
      label,
      scoped("catalog-reconcile", { input: { ...base, models, ...extra } }),
    );
  const get = (label, extra = {}) =>
    compare(label, scoped("catalog-get", extra));
  const snapshots = () =>
    compare(
      "immutable metadata snapshot hashes",
      scoped("query-json", {
        sql: `SELECT coalesce(jsonb_agg(jsonb_build_object('scope',availability_scope,'source',metadata_source,'hash',metadata_hash) ORDER BY availability_scope,metadata_hash),'[]'::jsonb) AS result FROM provider_model_catalog_snapshots WHERE provider_id=${literal(provider)}`,
      }),
    );
  await compare(
    "catalog refresh targets with pooled account summaries",
    scoped("catalog-refresh-targets"),
  );
  await compare(
    "provider catalog refresh target order",
    scoped("catalog-targets"),
  );
  assert.equal(
    await get("empty provider catalog").then((v) => v.models.length),
    0,
  );
  assert.equal(
    await get("foreign provider catalog denied", { owner: other }),
    null,
  );
  assert.equal(
    await unchanged(
      "foreign reconciliation cannot write catalog",
      scoped("catalog-reconcile", {
        owner: other,
        input: { ...base, models: [model("foreign")] },
      }),
    ),
    false,
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('catalog-custom',${literal(owner)},'Custom route');`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('catalog-custom-route','catalog-custom','chatgpt','first',0);",
  );
  assert.equal(
    await reconcile("create first native catalog and scoped availability", [
      model("first"),
      model("second"),
      model("third"),
    ]),
    true,
  );
  let catalog = await get("read complete catalog and availability");
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.availability.length, 3);
  assert.equal(
    catalog.models.find((m) => m.nativeModelId === "first").matchConfidence,
    0.875,
  );
  assert.equal(
    catalog.availability.filter((a) => a.state === "available").length,
    2,
  );
  const first = catalog.models.find((m) => m.nativeModelId === "first"),
    second = catalog.models.find((m) => m.nativeModelId === "second");
  let runtime = await compare(
    "legacy route binds available native catalog ID",
    scoped("runtimes", { model: "catalog-custom" }),
  );
  assert.equal(runtime[0].model.providerModelId, first.id);
  await compare(
    "owned provider model availability",
    scoped("catalog-availability", { model: first.id }),
  );
  assert.deepEqual(
    await compare(
      "foreign model availability denied",
      scoped("catalog-availability", { owner: other, model: first.id }),
    ),
    [],
  );
  const before = (await snapshots()).length;
  assert.equal(before, 3);
  const changedSecret = model("first", {
    rawMetadata: {
      nested: [{ label: "visible", authorization: "changed-secret" }],
      api_key: "changed-key",
      public: { capacity: 3 },
    },
  });
  await reconcile(
    "secret metadata and object insertion order do not change hash",
    [changedSecret, model("second"), model("third")],
  );
  assert.equal((await snapshots()).length, before);
  await reconcile("public metadata changes produce immutable observation", [
    model("first", { rawMetadata: { public: { capacity: 4 } } }),
  ]);
  assert.equal((await snapshots()).length, before + 1);
  await reconcile("same metadata redelivery does not duplicate snapshot", [
    model("first", { rawMetadata: { public: { capacity: 4 } } }),
  ]);
  assert.equal((await snapshots()).length, before + 1);
  await compare(
    "record refreshing state with opaque ETag",
    scoped("catalog-sync", {
      input: {
        scopeKey: base.availabilityScope,
        status: "refreshing",
        etag: "opaque-etag",
        errorCode: "old-error",
        refreshStartedAt: stamp,
        lastSuccessAt: stamp,
        workerId: "worker",
        providerAccountId: "account",
      },
    }),
  );
  catalog = await get("read refreshing catalog state");
  assert.equal(catalog.syncStates[0].etag, "opaque-etag");
  assert.equal(catalog.syncStates[0].error, "old-error");
  await compare(
    "partial sync update preserves omitted fields",
    scoped("catalog-sync", {
      input: { scopeKey: base.availabilityScope, status: "current" },
    }),
  );
  catalog = await get("sync state retains ETag worker account and timestamps");
  assert.equal(catalog.syncStates[0].etag, "opaque-etag");
  assert.equal(catalog.syncStates[0].workerId, "worker");
  assert.equal(catalog.syncStates[0].providerAccountId, "account");
  await compare(
    "explicit null clears only supplied sync fields",
    scoped("catalog-sync", {
      input: {
        scopeKey: base.availabilityScope,
        status: "stale",
        errorCode: null,
        etag: null,
        refreshStartedAt: null,
        lastSuccessAt: null,
        workerId: null,
        providerAccountId: null,
      },
    }),
  );
  catalog = await get("read explicitly cleared sync state", {
    servedStale: true,
  });
  assert.equal(catalog.servedStale, true);
  assert.equal(catalog.syncStates[0].etag, null);
  assert.equal(catalog.syncStates[0].refreshStartedAt, null);
  assert.equal(catalog.syncStates[0].workerId, null);
  await unchanged(
    "invalid catalog sync state preserves prior row",
    scoped("catalog-sync", {
      input: { scopeKey: base.availabilityScope, status: "invalid" },
    }),
    { rejected: true, exactError: false },
  );
  await reconcile(
    "catalog discovery adds logical model and preserves custom route",
    [],
    { autoCreateLogicalModels: true, defaultNativeModelId: "second" },
  );
  catalog = await get("catalog identities survive discovery");
  let settings = await compare(
    "discovered model routes and default projection",
    { op: "settings", owner },
  );
  const discovered = settings.models.find(
    (m) => m.id === "discovered:model:" + second.id,
  );
  assert.ok(discovered);
  assert.equal(discovered.discoveryManaged, true);
  assert.equal(discovered.routes[0].id, "discovered:route:" + second.id);
  assert.equal(discovered.routes[0].providerModelId, second.id);
  assert.equal(settings.preferences.defaultModelId, discovered.id);
  assert.ok(
    !settings.models.some((m) => m.id === "discovered:model:" + first.id),
  );
  await compare("delete discovered catalog model records suppression", {
    op: "model-delete",
    owner,
    model: discovered.id,
  });
  await reconcile("suppressed discovered model is not recreated", [], {
    autoCreateLogicalModels: true,
    defaultNativeModelId: "first",
  });
  settings = await compare("suppression and custom default routing retained", {
    op: "settings",
    owner,
  });
  assert.ok(!settings.models.some((m) => m.id === discovered.id));
  assert.equal(settings.preferences.defaultModelId, "catalog-custom");
  await reconcile(
    "explicit discovery IDs may include an unavailable model",
    [],
    {
      autoCreateLogicalModels: true,
      autoCreateNativeModelIds: ["third"],
      defaultNativeModelId: "third",
    },
  );
  settings = await compare(
    "explicit discovery does not overwrite saved default",
    { op: "settings", owner },
  );
  assert.equal(settings.preferences.defaultModelId, "catalog-custom");
  catalog = await get(
    "explicitly discovered unavailable catalog entry retained",
  );
  const third = catalog.models.find((m) => m.nativeModelId === "third");
  assert.ok(
    settings.models.some((m) => m.id === "discovered:model:" + third.id),
  );
  await reconcile("second availability scope preserves first scope", [], {
    availabilityScope: "global",
    availabilityWorkerId: null,
    availabilityProviderAccountId: null,
    availableNativeModelIds: ["third"],
  });
  catalog = await get("independent availability scopes");
  assert.equal(catalog.availability.length, 6);
  await reconcile(
    "empty catalog refresh marks retained models unavailable",
    [],
    { availableNativeModelIds: [] },
  );
  catalog = await get("unavailable retained model rows are not deleted");
  assert.equal(catalog.models.length, 3);
  assert.equal(
    catalog.availability.filter(
      (a) => a.scopeKey === base.availabilityScope && a.state === "unavailable",
    ).length,
    3,
  );
  await unchanged(
    "duplicate native models in one batch roll back snapshots and models",
    scoped("catalog-reconcile", {
      input: {
        ...base,
        models: [model("same"), model("same", { displayName: "duplicate" })],
      },
    }),
    { rejected: true, exactError: false },
  );
  await unchanged(
    "availability worker FK failure rolls back catalog update",
    scoped("catalog-reconcile", {
      input: {
        ...base,
        models: [model("worker-fault")],
        availabilityWorkerId: "missing-worker",
      },
    }),
    { rejected: true, exactError: false },
  );
  await seed(
    "ALTER TABLE model_routes ADD CONSTRAINT fixture_discovery_failure CHECK(model_name<>'profile-fault') NOT VALID;",
  );
  await unchanged(
    "discovered route failure rolls back all earlier phases",
    scoped("catalog-reconcile", {
      input: {
        ...base,
        models: [model("profile-fault")],
        availableNativeModelIds: ["profile-fault"],
        autoCreateLogicalModels: true,
      },
    }),
    { rejected: true, exactError: false },
  );
  await seed(
    "ALTER TABLE model_routes DROP CONSTRAINT fixture_discovery_failure;",
  );
  const large = Array.from({ length: 503 }, (_, i) =>
    model("batch-" + String(i).padStart(3, "0")),
  );
  await reconcile("catalog and logical discovery span 500-row batches", large, {
    autoCreateLogicalModels: true,
    availableNativeModelIds: large.map((m) => m.nativeModelId),
  });
  catalog = await get("complete 503-entry catalog addition");
  assert.equal(catalog.models.length, 506);
  settings = await compare("all large-batch discovered profiles persist", {
    op: "settings",
    owner,
  });
  assert.equal(
    settings.models.filter((m) => m.name.startsWith("batch-")).length,
    503,
  );
  // A normal physical maintenance operation is allowed to reorder the
  // reference's unsorted availability rows without changing any logical state.
  const logicalSql =
    "SELECT jsonb_agg(to_jsonb(a) ORDER BY provider_model_id,scope_key) AS result FROM provider_model_availability a";
  const beforeLogical = await pair[0].request({
    op: "query-json",
    sql: logicalSql,
  });
  const beforeApi = await pair[0].request(scoped("catalog-get"));
  await pair[0].seed(
    "CLUSTER provider_model_availability USING provider_model_availability_model_scope_unique;",
  );
  const afterLogical = await pair[0].request({
    op: "query-json",
    sql: logicalSql,
  });
  const afterApi = await pair[0].request(scoped("catalog-get"));
  for (const result of [beforeLogical, beforeApi, afterLogical, afterApi])
    assert.equal(result.rejected, false, result.diagnostic);
  assert.deepEqual(
    afterLogical.value,
    beforeLogical.value,
    "Node maintenance preserves every stored availability field",
  );
  assert.deepEqual(
    availableCatalogModelIds(afterApi.value, "worker"),
    availableCatalogModelIds(beforeApi.value, "worker"),
    "unchanged client treats availability as a model-ID set",
  );
  report.catalogMaintenanceControl = {
    logicalStateUnchanged: true,
    clientModelSetUnchanged: true,
    orderChanged: beforeApi.value.availability.some(
      (row, i) => row.id !== afterApi.value.availability[i].id,
    ),
    before: beforeApi.value.availability,
    after: afterApi.value.availability,
  };
  const repeat = [
    ...large.slice(0, 500),
    { ...large[0], description: "updated in later batch" },
  ];
  await reconcile(
    "same native ID may be updated across separate batches",
    repeat,
    { availableNativeModelIds: [large[0].nativeModelId] },
  );
  catalog = await get("later batch update retains stable identity");
  assert.equal(
    catalog.models.find((m) => m.nativeModelId === large[0].nativeModelId)
      .description,
    "updated in later batch",
  );
}
