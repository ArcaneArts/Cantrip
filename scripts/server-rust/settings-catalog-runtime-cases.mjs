import assert from "node:assert/strict";

// The actual composition function and real repositories select the service;
// controlled catalog backends record dispatch. Service internals have separate
// actual-repository, worker and public HTTP comparisons.
export async function catalogRuntimeCases({
  seed,
  compare,
  unchanged,
  literal,
}) {
  const owner = "catalog-runtime-owner",
    other = "catalog-runtime-other";
  const alpha = "catalog-runtime-alpha",
    beta = "catalog-runtime-beta",
    offline = "catalog-runtime-offline";
  const providers = {
    public: ["openai-compatible", "https://openrouter.ai/api/v1"],
    custom: ["openai-compatible", "https://fixture.invalid"],
    zai: ["openai-compatible", "https://api.z.ai/api/v1"],
    chatgpt: ["chatgpt", "https://chatgpt.com"],
    grok: ["grok", "https://grok.com"],
    ollama: ["ollama", "http://127.0.0.1:11434"],
  };
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Catalog runtime',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")})`,
    );
    await compare("initialize catalog runtime " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  for (const [family, [kind, base]] of Object.entries(providers))
    await seed(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal("runtime-" + family)},${literal(owner)},${literal(family)},${literal(kind)},${literal(base)})`,
    );
  for (const id of [alpha, beta, offline])
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(id)},${literal(owner)},${literal(id)},'linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z')`,
    );
  const connected = { [alpha]: true, [beta]: true };
  const call = (family, extra = {}) => ({
    op: "runtime-catalog",
    owner,
    provider: "runtime-" + family,
    input: { connected, elapsedMs: 17, ambientOwner: other },
    ...extra,
  });
  const setDefault = (worker) =>
    seed(
      `UPDATE user_settings SET default_worker_id=${worker === null ? "NULL" : literal(worker)} WHERE user_id=${literal(owner)}`,
    );
  for (const extra of [{ provider: "missing" }, { owner: other }]) {
    const value = await unchanged(
      "runtime catalog owned lookup " + JSON.stringify(extra),
      call("public", extra),
    );
    assert.equal(value.result, null);
    assert.deepEqual(value.calls, []);
    assert.equal(value.logs.at(-1).context.status, "not-applicable");
  }
  for (const family of Object.keys(providers)) {
    const value = await unchanged(
      "runtime catalog service " + family,
      call(family, {
        worker: alpha,
        force: true,
        account: "explicit-account",
        trigger: "manual-refresh",
      }),
    );
    assert.equal(value.calls.length, 1);
    assert.equal(value.calls[0].kind, family === "custom" ? "public" : family);
    assert.equal(
      value.calls[0].owner,
      owner,
      "captured owner overrides ambient context",
    );
    assert.deepEqual(value.result, { fixture: "catalog" });
    assert.equal(value.logs.at(-1).context.durationMs, 17);
  }
  for (const family of ["chatgpt", "grok", "ollama"]) {
    await setDefault(null);
    let value = await unchanged(
      "runtime chooses first connected owned worker " + family,
      call(family),
    );
    assert.equal(value.calls[0].worker, alpha);
    await setDefault(beta);
    value = await unchanged(
      "runtime prefers connected default " + family,
      call(family),
    );
    assert.equal(value.calls[0].worker, beta);
    value = await unchanged(
      "runtime empty explicit worker uses default " + family,
      call(family, { worker: "" }),
    );
    assert.equal(value.calls[0].worker, beta);
    assert.equal(
      value.logs[0].context.workerId,
      "",
      "diagnostic identity retains original input",
    );
    await setDefault(offline);
    value = await unchanged(
      "runtime prefers connected alternative over offline default " + family,
      call(family),
    );
    assert.equal(value.calls[0].worker, alpha);
    value = await unchanged(
      "runtime retains offline default for service cache handling " + family,
      call(family, { input: { connected: false } }),
    );
    assert.equal(value.calls[0].worker, offline);
    await setDefault(null);
    value = await unchanged(
      "runtime missing worker produces family error " + family,
      call(family, { input: { connected: false } }),
    );
    const label = { chatgpt: "ChatGPT", grok: "Grok", ollama: "Ollama" }[
      family
    ];
    assert.deepEqual(value.result, {
      error: `No worker is available for ${label} discovery.`,
    });
    assert.deepEqual(value.calls, []);
    assert.equal(
      value.logs.at(-1).key,
      `provider-catalog-refresh-failed:runtime-${family}:automatic`,
    );
    assert.deepEqual(value.logs.at(-1).options, {
      summaryEvery: 10,
      windowMs: 300000,
    });
    value = await unchanged(
      "runtime explicit worker bypasses automatic choice " + family,
      call(family, { worker: "explicit-worker", input: { connected: false } }),
    );
    assert.equal(value.calls[0].worker, "explicit-worker");
    for (const worker of [[], [""], [alpha, ""], [alpha, alpha], null]) {
      await setDefault(beta);
      const result = await unchanged(
        "runtime raw worker key " + family + " " + JSON.stringify(worker),
        call(family, { worker }),
      );
      assert.deepEqual(result.calls[0].worker, worker === null ? beta : worker);
    }
  }
  for (const family of ["public", "zai"]) {
    const value = await unchanged(
      "runtime nonworker catalog needs no runner " + family,
      call(family, { input: { connected: false } }),
    );
    assert.equal(value.calls[0].kind, family);
  }
  const marked = await unchanged(
    "runtime public success marks shared hydration",
    call("public", { input: { hydrateAfterLoad: true } }),
  );
  assert.equal(marked.calls.length, 1);
  assert.equal(marked.result.hydrated, false);
  const missing = await unchanged(
    "runtime null public result allows hydration retry",
    call("public", { input: { hydrateAfterLoad: true, catalog: null } }),
  );
  assert.equal(missing.calls.length, 2);
  assert.deepEqual(missing.result, { catalog: null, hydrated: false });
  for (const extra of [{}, { worker: "" }, { worker: alpha }]) {
    const value = await unchanged(
      "runtime backend failure retains original request " +
        JSON.stringify(extra),
      call("public", {
        ...extra,
        input: { catalogError: "controlled catalog failure", elapsedMs: 23 },
      }),
    );
    assert.deepEqual(value.result, { error: "controlled catalog failure" });
    assert.equal(value.logs.at(-1).context.durationMs, 23);
    assert.equal(
      value.logs.at(-1).key,
      `provider-catalog-refresh-failed:runtime-public:${extra.worker ?? "automatic"}`,
    );
  }
  for (const level of ["debug", "info", "warn"]) {
    const value = await unchanged(
      "runtime diagnostic exception " + level,
      call("public", {
        input: {
          logError: level,
          ...(level === "warn"
            ? { catalogError: "original backend failure" }
            : {}),
        },
      }),
    );
    assert.deepEqual(value.result, { error: "controlled diagnostic failure" });
    assert.equal(value.logs.at(-1).level, level === "debug" ? "debug" : "warn");
  }
  await seed("CREATE TABLE fixture_catalog_owned_work(marker text NOT NULL)");
  const dropped = await compare(
    "runtime admitted catalog survives dropped caller",
    call("public", {
      input: {
        discard: true,
        beforeCatalogSQL: [
          "INSERT INTO fixture_catalog_owned_work VALUES('completed')",
        ],
      },
    }),
  );
  assert.equal(dropped.result, null);
  assert.equal(dropped.logs.at(-1).context.status, "completed");
  assert.equal(
    await compare("runtime dropped catalog committed actual SQL", {
      op: "query-json",
      sql: "SELECT to_jsonb(count(*)) AS result FROM fixture_catalog_owned_work",
    }),
    1,
  );
  await seed("DROP TABLE fixture_catalog_owned_work");
}
