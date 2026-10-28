import assert from "node:assert/strict";
import { ZAI_CODEX_MODELS } from "../../cantrip_server/src/models/zai-catalog.ts";

export async function zaiCases({ seed, compare, unchanged, literal }) {
  await compare("built-in Z.ai catalog exactly matches the actual source", {
    op: "zai-constants",
  });
  for (const kind of [
    "openai-compatible",
    "ollama",
    "chatgpt",
    "grok",
    "unknown",
  ]) {
    for (const baseUrl of [
      "https://api.z.ai/api/v1",
      "https://API.Z.AI:443/api/v1/",
      "https://api.z.ai/api/v1/responses",
      "https://api.z.ai/api/v1/chat/completions/?ignored=1#fragment",
      "https://user:password@api.z.ai:8443/api/v1",
      "https://api.z.ai/api/./v1/",
      "https://api.z.ai/api/v1/%2e%2e/v1",
      "https://api.z.ai/api/v1/RESPONSES",
      "http://api.z.ai/api/v1",
      "https://api.z.ai./api/v1",
      "https://api.z.ai.invalid/api/v1",
      "https://api.z.ai/api/v2",
      "https://api.z.ai/API/v1",
      "https://api.z.ai/api%2fv1",
      "invalid",
      "",
    ])
      await unchanged(`Z.ai provider inference ${kind} ${baseUrl}`, {
        op: "zai-predicate",
        input: { kind, baseUrl },
      });
  }
  const owner = "settings-zai-owner",
    other = "settings-zai-other",
    provider = "zai-service";
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Catalog fixture',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")});`,
    );
    await compare("initialize built-in catalog owner " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  const call = (op, extra = {}) => ({ op, owner, provider, ...extra });
  const get = (label, extra = {}) => compare(label, call("zai-get", extra));
  const create = async (id) =>
    compare(
      "create built-in catalog provider " + id,
      call("provider-create", {
        input: {
          id,
          kind: "openai-compatible",
          name: id,
          baseUrl: "https://api.z.ai/api/v1",
          protectedApiKey: null,
        },
      }),
    );
  await unchanged(
    "missing Z.ai provider returns null",
    call("zai-get", { provider: "missing" }),
  );
  await create(provider);
  await unchanged(
    "foreign Z.ai provider returns null",
    call("zai-get", { owner: other }),
  );
  await unchanged(
    "wrong family rejects without catalog writes",
    call("zai-get", { owner: "settings-owner", provider: "ollama" }),
    { rejected: true },
  );
  let catalog = await get(
    "hydrate both built-in models and stable discovery routes",
  );
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.syncStates[0].status, "current");
  assert.equal(catalog.syncStates[0].etag, "built-in-v1");
  const flagship = catalog.models.find(
    (model) => model.nativeModelId === "glm-5.3",
  );
  let settings = await compare(
    "built-in discovery selects initial default",
    call("settings"),
  );
  assert.equal(
    settings.preferences.defaultModelId,
    "discovered:model:" + flagship.id,
  );
  assert.equal(
    settings.models.filter((model) => model.discoveryManaged).length,
    2,
  );
  assert.deepEqual(
    await unchanged(
      "current complete built-in catalog does not write",
      call("zai-reconcile"),
    ),
    [provider],
  );
  await seed(
    `UPDATE provider_models SET display_name='Previously retained metadata' WHERE provider_id=${literal(provider)} AND native_model_id='glm-5.3';`,
  );
  await unchanged(
    "current catalog does not eagerly replace retained metadata",
    call("zai-reconcile"),
  );
  catalog = await compare(
    "retained metadata remains visible until refresh",
    call("catalog-get"),
  );
  assert.equal(
    catalog.models.find((model) => model.id === flagship.id).displayName,
    "Previously retained metadata",
  );
  await seed(
    `UPDATE provider_catalog_sync_states SET etag='built-in-v0' WHERE provider_id=${literal(provider)};`,
  );
  await compare(
    "old built-in version triggers reconciliation",
    call("zai-reconcile"),
  );
  catalog = await compare(
    "refresh retains provider model identity",
    call("catalog-get"),
  );
  assert.equal(
    catalog.models.find((model) => model.nativeModelId === "glm-5.3").id,
    flagship.id,
  );
  assert.equal(
    catalog.models.find((model) => model.id === flagship.id).displayName,
    "glm-5.3",
  );
  await compare(
    "user removes discovered logical model",
    call("model-delete", { model: "discovered:model:" + flagship.id }),
  );
  await get("explicit catalog refresh respects discovery suppression");
  settings = await compare(
    "suppressed logical model is not recreated",
    call("settings"),
  );
  assert.equal(
    settings.models.some(
      (model) => model.id === "discovered:model:" + flagship.id,
    ),
    false,
  );

  const partial = "zai-partial";
  await create(partial);
  await compare(
    "seed one model in otherwise current built-in catalog",
    call("catalog-reconcile", {
      provider: partial,
      input: {
        models: [ZAI_CODEX_MODELS[0]],
        availabilityScope: "zai:built-in",
        availableNativeModelIds: ["glm-5.3"],
        autoCreateLogicalModels: false,
      },
    }),
  );
  await compare(
    "mark incomplete catalog current",
    call("catalog-sync", {
      provider: partial,
      input: {
        scopeKey: "zai:built-in",
        status: "current",
        etag: "built-in-v1",
      },
    }),
  );
  catalog = await compare(
    "read incomplete built-in identities",
    call("catalog-get", { provider: partial }),
  );
  const retained = catalog.models[0].id;
  assert.deepEqual(
    await compare(
      "current version with a missing model is hydrated",
      call("zai-reconcile"),
    ),
    [provider, partial],
  );
  catalog = await compare(
    "missing model filled without replacing existing model",
    call("catalog-get", { provider: partial }),
  );
  assert.equal(catalog.models.length, 2);
  assert.equal(
    catalog.models.find((model) => model.nativeModelId === "glm-5.3").id,
    retained,
  );
  assert.deepEqual(
    await unchanged(
      "foreign owner has no built-in catalog side effects",
      call("zai-reconcile", { owner: other }),
    ),
    [],
  );

  const failed = "zai-failure";
  await create(failed);
  await seed(
    "ALTER TABLE provider_models ADD CONSTRAINT fixture_zai_native_failure CHECK (provider_id<>'zai-failure');",
  );
  await compare(
    "failed hydration propagates actual database failure",
    call("zai-get", { provider: failed }),
    { rejected: true, exactError: false },
  );
  catalog = await compare(
    "failed transaction retains separately committed refreshing state",
    call("catalog-get", { provider: failed }),
  );
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.syncStates[0].status, "refreshing");
  assert.equal(catalog.syncStates[0].lastSuccessAt, null);
  assert.deepEqual(
    await compare(
      "failed model transaction rolls metadata snapshots back",
      call("query-json", {
        sql: "SELECT jsonb_build_object('count',count(*)) AS result FROM provider_model_catalog_snapshots WHERE provider_id='zai-failure'",
      }),
    ),
    { count: 0 },
  );
  await seed(
    "ALTER TABLE provider_models DROP CONSTRAINT fixture_zai_native_failure;",
  );
  catalog = await get(
    "actual retry completes previously interrupted hydration",
    { provider: failed },
  );
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.syncStates[0].status, "current");
  await unchanged(
    "all built-in providers converge without repeated writes",
    call("zai-reconcile"),
  );
}
