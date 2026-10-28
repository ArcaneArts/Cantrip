import assert from "node:assert/strict";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";

export async function openRouterCases({ seed, compare, unchanged, literal }) {
  const owner = "openrouter-owner",
    other = "openrouter-other",
    provider = "public-catalog";
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Catalog fixture',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")})`,
    );
    await compare("initialize OpenRouter account " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  const call = (extra = {}) => ({
    op: "openrouter-get",
    owner,
    provider,
    input: { payload: { data: [] } },
    ...extra,
  });
  await unchanged(
    "missing public provider returns null without fetch",
    call({ provider: "missing" }),
  );
  await compare("create public provider with opaque key", {
    op: "provider-create",
    owner,
    input: {
      id: provider,
      name: "Public",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1?discard=1#fragment",
      protectedApiKey: policyEnvelope,
    },
  });
  await unchanged(
    "foreign public provider returns null without fetch",
    call({ owner: other }),
  );
  await compare("create non-public provider", {
    op: "provider-create",
    owner,
    input: {
      id: "public-wrong",
      name: "Custom",
      kind: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      protectedApiKey: null,
    },
  });
  const wrong = await unchanged(
    "wrong public provider rejects without sync writes",
    call({ provider: "public-wrong" }),
  );
  assert.equal(
    wrong.error,
    "Provider is not an OpenRouter-compatible provider.",
  );
  assert.deepEqual(wrong.calls, []);
  const failed = await compare(
    "cold public failure records failed sync",
    call({
      force: true,
      input: { status: 503, statusText: "Catalog offline" },
    }),
  );
  assert.equal(
    failed.error,
    "OpenRouter model catalog returned 503 Catalog offline.",
  );
  const state = await compare("inspect failed public sync", {
    op: "catalog-get",
    owner,
    provider,
  });
  assert.equal(state.syncStates[0].status, "failed");
  const payload = {
    data: [
      null,
      {},
      { id: " " },
      {
        id: " public/model ",
        name: "Public Model",
        context_length: 128000,
        architecture: {
          input_modalities: ["text", "IMAGE", " text "],
          output_modalities: ["text"],
        },
        supported_parameters: ["TOOLS", "reasoning"],
        reasoning: {
          supported_efforts: ["high", "low"],
          default_effort: "HIGH",
        },
        top_provider: { max_completion_tokens: 32000 },
      },
      { id: "other/model", name: "Other" },
    ],
  };
  const first = await compare(
    "public cache refresh persists global metadata only",
    call({ force: true, now: 1000, input: { payload, etag: '"v1"' } }),
  );
  assert.equal(first.result.models.length, 2);
  assert.equal(first.result.servedStale, false);
  assert.deepEqual(first.calls, [
    {
      url: "https://openrouter.ai/api/v1/models",
      accept: "application/json",
      etag: null,
      authorization: null,
    },
  ]);
  assert.ok(
    first.result.availability.every(
      (row) =>
        row.scopeKey === "openrouter:global" &&
        row.workerId === null &&
        row.providerAccountId === null,
    ),
  );
  const profiles = await compare(
    "public metadata does not create logical models",
    {
      op: "query-json",
      sql: `SELECT to_jsonb(count(*)::integer) AS result FROM model_profiles WHERE owner_id=${literal(owner)}`,
    },
  );
  assert.equal(profiles, 0);
  const fresh = await compare(
    "fresh public cache ignores new payload and sends no request",
    call({ now: 1099, input: { payload: { data: [] } } }),
  );
  assert.equal(fresh.result.models.length, 2);
  assert.deepEqual(fresh.calls, []);
  const forced = await compare(
    "forced request revalidates even fresh metadata",
    call({
      force: true,
      input: { status: 304, statusText: "Not Modified", etag: '"ignored"' },
    }),
  );
  assert.equal(forced.result.syncStates[0].etag, '"v1"');
  assert.equal(forced.calls[0].etag, '"v1"');
  const retained = await compare(
    "forced network failure serves durable last-good catalog",
    call({ force: true, input: { error: "public network unavailable" } }),
  );
  assert.equal(retained.result.servedStale, true);
  assert.equal(retained.result.models.length, 2);
  assert.equal(
    retained.result.syncStates[0].error,
    "openrouter-catalog-refresh-failed",
  );
  for (const payload of [[], { data: null }, { data: {} }]) {
    const invalid = await compare(
      "forced malformed public payload retains catalog " +
        JSON.stringify(payload),
      call({ force: true, input: { payload } }),
    );
    assert.equal(invalid.result.servedStale, true);
    assert.equal(invalid.result.models.length, 2);
  }
  // Cache keys use origin, so a second provider on the same host can reuse
  // public metadata without sending any account/provider authorization.
  await compare("create same-origin public provider", {
    op: "provider-create",
    owner,
    input: {
      id: "public-shared",
      name: "Shared",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/different/path",
      protectedApiKey: policyEnvelope,
    },
  });
  const shared = await compare(
    "same-origin public cache is shared across providers",
    call({
      provider: "public-shared",
      now: 1099,
      input: { payload: { data: [] } },
    }),
  );
  assert.deepEqual(shared.calls, []);
  assert.equal(shared.result.models.length, 2);
  const stale = await compare(
    "expired public read returns before blocked background refresh",
    call({
      now: 1200,
      input: {
        payload: { data: [{ id: "replacement", name: "Replacement" }] },
        etag: '"v2"',
        block: true,
      },
    }),
  );
  assert.equal(stale.result.servedStale, true);
  assert.equal(stale.result.syncStates[0].status, "stale");
  assert.equal(stale.result.syncStates[0].error, null);
  const settled = await compare(
    "background refresh persists models and current sync",
    {
      op: "openrouter-release",
      owner,
      provider,
      status: "current",
      error: null,
      etag: '"v2"',
    },
  );
  assert.equal(settled.models.length, 3); // Metadata is retained; old availability is removed.
  const available = new Set(
    settled.availability
      .filter((row) => row.state === "available")
      .map((row) => row.providerModelId),
  );
  assert.equal(available.size, 1);
  const staleFailure = await compare(
    "failed background refresh initially serves old snapshot",
    call({
      now: 1300,
      input: { error: "background unavailable", block: true },
    }),
  );
  assert.equal(staleFailure.result.servedStale, true);
  const failedBackground = await compare(
    "background rejection records background error code",
    {
      op: "openrouter-release",
      owner,
      provider,
      status: "stale",
      error: "openrouter-background-refresh-failed",
      etag: '"v2"',
    },
  );
  assert.equal(
    failedBackground.syncStates[0].error,
    "openrouter-background-refresh-failed",
  );
  // A real SQL constraint rejects persistence after the public cache accepted
  // the response. Retrying uses that good cache, without repeating the fetch.
  await seed(
    "ALTER TABLE provider_models ADD CONSTRAINT public_catalog_fault CHECK (native_model_id <> 'db-failure')",
  );
  const fault = await compare(
    "public persistence failure retains durable metadata",
    call({
      force: true,
      input: { payload: { data: [{ id: "db-failure" }] }, etag: '"db"' },
    }),
  );
  assert.equal(fault.result.servedStale, true);
  assert.equal(
    fault.result.syncStates[0].error,
    "openrouter-catalog-refresh-failed",
  );
  await seed(
    "ALTER TABLE provider_models DROP CONSTRAINT public_catalog_fault",
  );
  const retry = await compare(
    "public cache retains successful fetch after SQL failure",
    call({ input: { error: "must not fetch" } }),
  );
  assert.deepEqual(retry.calls, []);
  assert.equal(retry.result.syncStates[0].status, "current");
  assert.ok(
    retry.result.models.some((model) => model.nativeModelId === "db-failure"),
  );
}
