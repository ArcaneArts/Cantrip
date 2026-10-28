import assert from "node:assert/strict";

export async function ollamaCases({
  seed,
  compare,
  unchanged,
  literal,
  owner,
  other,
}) {
  const provider = "ollama-service",
    worker = "worker";
  const call = (extra = {}) => ({
    op: "ollama-get",
    owner,
    provider,
    worker,
    input: {},
    ...extra,
  });
  const create = (id) =>
    compare("create discovery provider " + id, {
      op: "provider-create",
      owner,
      input: {
        id,
        kind: "ollama",
        name: id,
        baseUrl: "http://localhost:11434",
        protectedApiKey: null,
      },
    });
  const model = {
    name: " served-model ",
    modifiedAt: null,
    sizeBytes: 100,
    digest: " digest ",
    family: " llama ",
    families: [" llama "],
    parameterSize: "8B",
    quantization: "Q4",
    capabilities: ["VISION", "TOOLS", "THINKING"],
    modelInfo: {
      "general.architecture": "llama",
      "llama.context_length": 128000.5,
    },
  };
  const inventory = { models: [model], observedAt: "2026-10-27T00:00:00.000Z" };
  await create(provider);
  for (const [name, extra, expected] of [
    [
      "missing provider wins over missing worker",
      { provider: "missing", worker: "missing" },
      null,
    ],
    [
      "foreign provider is not disclosed",
      { owner: other, worker: "foreign-worker" },
      null,
    ],
    ["missing worker is rejected", { worker: "missing" }, "Worker not found."],
    [
      "foreign worker is rejected",
      { worker: "foreign-worker" },
      "Worker not found.",
    ],
    [
      "unlinked worker is rejected",
      { worker: "unlinked-worker" },
      "Worker not found.",
    ],
    [
      "worker lookup precedes family check",
      { provider: "openrouter", worker: "missing" },
      "Worker not found.",
    ],
    [
      "wrong provider family is rejected",
      { provider: "openrouter" },
      "Provider is not an Ollama provider.",
    ],
  ]) {
    const value = await unchanged("Ollama " + name, call(extra));
    assert.deepEqual(value.calls, []);
    assert.equal(value.error ?? value.result, expected);
  }
  let result = await compare(
    "offline uncached discovery persists stale state before failing",
    call(),
  );
  assert.equal(result.error, "Worker is offline.");
  let catalog = await compare("offline catalog records its worker scope", {
    op: "catalog-get",
    owner,
    provider,
  });
  assert.equal(catalog.syncStates[0].status, "stale");
  assert.equal(catalog.syncStates[0].error, "worker-offline");
  result = await compare(
    "actual discovery normalizes and persists worker inventory",
    call({ input: { connected: true, inventory } }),
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].options.timeoutMs, 120000);
  assert.equal(result.result.models[0].contextWindow, 128001);
  assert.deepEqual(result.result.models[0].inputModalities, ["text", "image"]);
  const retained = result.result.models[0].id;
  await seed(
    `UPDATE provider_catalog_sync_states SET last_success_at='2030-01-01T00:00:00Z' WHERE provider_id=${literal(provider)};`,
  );
  result = await unchanged(
    "fresh cache is returned before offline detection",
    call(),
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(result.calls.length, 0);
  result = await compare(
    "force bypasses fresh cache and returns stale retained models offline",
    call({ force: true }),
  );
  assert.equal(result.result.servedStale, true);
  assert.equal(result.result.models[0].id, retained);
  result = await compare(
    "worker failure retains and serves existing catalog",
    call({
      force: true,
      input: { connected: true, error: "Controlled catalog failure." },
    }),
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.result.servedStale, true);
  assert.equal(
    result.result.syncStates[0].error,
    "ollama-catalog-refresh-failed",
  );
  result = await compare(
    "stale cache refreshes without force",
    call({ input: { connected: true, inventory } }),
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.result.servedStale, false);
  assert.equal(result.result.models[0].id, retained);
  result = await compare(
    "malformed inventory keeps prior catalog and records failure",
    call({
      force: true,
      input: {
        connected: true,
        inventory: { ...inventory, models: [{ ...model, name: " " }] },
      },
    }),
  );
  assert.equal(result.result.servedStale, true);
  assert.equal(result.result.models[0].id, retained);
  result = await compare(
    "empty successful inventory marks previously known models unavailable",
    call({
      force: true,
      input: { connected: true, inventory: { ...inventory, models: [] } },
    }),
  );
  assert.equal(result.result.servedStale, false);
  assert.equal(result.result.models[0].id, retained);
  assert.equal(result.result.availability[0].state, "unavailable");

  const empty = "ollama-empty";
  await create(empty);
  result = await compare(
    "empty first discovery becomes current",
    call({
      provider: empty,
      input: { connected: true, inventory: { ...inventory, models: [] } },
    }),
  );
  assert.equal(result.result.models.length, 0);
  await seed(
    `UPDATE provider_catalog_sync_states SET last_success_at='2030-01-01T00:00:00Z' WHERE provider_id=${literal(empty)};`,
  );
  result = await unchanged(
    "fresh empty cache is still valid while offline",
    call({ provider: empty }),
  );
  assert.equal(result.result.models.length, 0);
  assert.equal(result.result.servedStale, false);
  const failed = "ollama-failed";
  await create(failed);
  result = await compare(
    "uncached worker failure propagates original error",
    call({
      provider: failed,
      input: { connected: true, error: "Controlled catalog failure." },
    }),
  );
  assert.equal(result.error, "Controlled catalog failure.");
  catalog = await compare("uncached worker failure persists failed state", {
    op: "catalog-get",
    owner,
    provider: failed,
  });
  assert.equal(catalog.syncStates[0].status, "failed");
  result = await compare(
    "missing inventory has exact source validation error",
    call({ provider: failed, input: { connected: true } }),
  );
  assert.ok(result.error.includes("expected object, received undefined"));
  result = await compare(
    "invalid inventory has exact source validation error",
    call({
      provider: failed,
      input: {
        connected: true,
        inventory: {
          ...inventory,
          models: [{ ...model, capabilities: [null] }],
        },
      },
    }),
  );
  assert.ok(result.error.includes("capabilities"));
  result = await compare(
    "failed discovery can retry without force",
    // Settings orders profiles only by name. Give this separate provider a
    // distinct model so independent SQL tie ordering cannot alter the final
    // retained-bundle comparison; all sequence assertions remain strict.
    call({
      provider: failed,
      input: {
        connected: true,
        inventory: {
          ...inventory,
          models: [{ ...model, name: "recovered-model" }],
        },
      },
    }),
  );
  assert.equal(result.result.syncStates[0].status, "current");
  assert.equal(result.result.models.length, 1);
}
