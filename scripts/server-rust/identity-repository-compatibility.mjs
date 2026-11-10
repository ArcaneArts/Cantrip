// Current identity/model facades over real migrated stores and native repositories.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-identity-repository-"));
const report = {
  suite: "identity-model-repositories",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  cases: [],
  cleanupFailures: [],
};
const pair = [],
  urls = [],
  owner = "identity-owner",
  other = "identity-other";
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const stamp = "2026-10-25T00:00:00.000Z";
let pg, executable, failure;
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode: values.database,
    databaseUrl: urls[i],
    nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
  });
async function seed(sql) {
  for (const repo of pair) await repo.seed(sql);
}
async function observe(name, input) {
  const request = { owner, ...input },
    windows = [];
  const outcomes = await Promise.all(
    pair.map(async (r, i) => {
      const from = Date.now(),
        outcome = await r.request(request);
      windows[i] = [from, Date.now()];
      return outcome;
    }),
  );
  report.cases.push({ name, input: request, outcomes, windows });
  for (const r of outcomes)
    assert.equal(r.rejected, false, name + ": " + r.diagnostic);
  // This internal query has no ORDER BY; the ordered inference catalog remains strict.
  const normalize = (value, runtime, key = "") => {
    if (Array.isArray(value)) {
      const rows = value.map((v) => normalize(v, runtime));
      return request.op === "inference-configurations"
        ? rows.sort((a, b) => a.providerId.localeCompare(b.providerId))
        : rows;
    }
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, runtime, k)]),
      );
    if (
      typeof value === "string" &&
      ["createdAt", "updatedAt"].includes(key) &&
      value !== stamp
    ) {
      const at = Date.parse(value);
      assert.ok(Number.isFinite(at), name + ": real write timestamp");
      assert.equal(
        new Date(at).toISOString(),
        value,
        name + ": ISO wire timestamp",
      );
      assert.ok(
        at >= windows[runtime][0] && at <= windows[runtime][1],
        name + ": write time belongs to this actual operation",
      );
      return "<verified operation write time>";
    }
    return value;
  };
  assert.deepEqual(
    normalize(outcomes[1].value, 1),
    normalize(outcomes[0].value, 0),
    name,
  );
  return outcomes[0].value;
}
try {
  executable =
    process.env.CANTRIP_RUST_SETTINGS_FIXTURE_BINARY ??
    (await buildRustExample("settings-repository-fixture"));
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (pg && (kind === "node" || values.database === "postgres"))
      urls[i] = await pg.database();
    pair.push(await open(kind, i));
  }
  for (const id of [owner, other])
    await seed(
      `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(id)},'account','Identity fixture',${literal(id + "@fixture.invalid")},${literal(id + "@fixture.invalid")})`,
    );
  for (const [id, principal] of [
    ["language-provider", owner],
    ["embedding-provider", owner],
    ["decision-provider", owner],
    ["foreign-provider", other],
  ])
    await seed(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,created_at,updated_at) VALUES(${literal(id)},${literal(principal)},${literal(id)},'ollama','http://localhost:11434',${literal(stamp)},${literal(stamp)})`,
    );
  for (const [id, principal, operation] of [
    ["language-model", owner, "language"],
    ["embedding-model", owner, "embedding"],
    ["decision-model", owner, "decision"],
    ["foreign-model", other, "language"],
  ])
    await seed(
      `INSERT INTO model_profiles(id,owner_id,name,operation,created_at,updated_at) VALUES(${literal(id)},${literal(principal)},${literal(id)},${literal(operation)},${literal(stamp)},${literal(stamp)})`,
    );
  for (const id of ["worker", "other-worker"])
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(id)},${literal(owner)},'Worker','linux','x64',${literal(stamp)},${literal(stamp)})`,
    );
  for (const [operation, adapter] of [
    ["embedding", "openai-embeddings"],
    ["decision", "openai-decisions"],
  ]) {
    const caps = {
      [operation]: {
        status: "supported",
        source: "fixture",
        modelRevision: "catalog-revision",
      },
    };
    await seed(
      `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source,operation_capabilities,created_at,updated_at,last_seen_at) VALUES(${literal(operation + "-catalog")},${literal(operation + "-provider")},${literal(operation + "-native")},'Operation catalog','ollama',${literal(JSON.stringify(caps))}::jsonb,${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO model_routes(id,model_id,provider_id,model_name,provider_model_id,operation_adapter,operation_options,position,enabled) VALUES(${literal(operation + "-route")},${literal(operation + "-model")},${literal(operation + "-provider")},${literal(operation + "-native")},${literal(operation + "-catalog")},${literal(adapter)},'{}',0,true)`,
    );
  }
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('language-route','language-model','language-provider','language-native',0,true),('disabled-route','language-model','language-provider','disabled-native',1,false),('foreign-route','foreign-model','foreign-provider','foreign-native',0,true)",
  );
  const catalog = await observe("owned inference catalog", {
    op: "inference-catalog",
  });
  assert.equal(catalog.configurations.length, 3);
  assert.ok(
    Number.isSafeInteger(catalog.catalogRevision) &&
      catalog.catalogRevision > 0,
  );
  for (const [principal, count] of [
    [owner, 3],
    [other, 1],
    ["missing-owner", 0],
  ]) {
    const configs = await observe("inference configurations " + principal, {
      op: "inference-configurations",
      owner: principal,
    });
    assert.equal(configs.length, count);
    const scoped = await observe("inference catalog " + principal, {
      op: "inference-catalog",
      owner: principal,
    });
    assert.equal(scoped.configurations.length, count);
    if (!count) assert.equal(scoped.catalogRevision, 0);
  }
  let runtime = await observe("owned selected runtime", {
    op: "model-runtime",
    model: "language-model",
  });
  assert.equal(runtime.routeId, "language-route");
  assert.equal(
    (
      await observe("empty runtime route means no selector", {
        op: "model-runtime",
        model: "language-model",
        route: "",
      })
    ).routeId,
    "language-route",
  );
  for (const input of [
    { model: "missing" },
    { model: "foreign-model" },
    { model: "language-model", owner: other },
    { model: "language-model", route: "disabled-route" },
    { model: "language-model", route: "foreign-route" },
  ])
    assert.equal(
      await observe("runtime negative " + JSON.stringify(input), {
        op: "model-runtime",
        ...input,
      }),
      null,
    );
  runtime = await observe("explicit disabled route runtime", {
    op: "model-runtime-route",
    route: "disabled-route",
  });
  assert.equal(runtime.routeId, "disabled-route");
  assert.equal(runtime.model.name, "disabled-native");
  for (const input of [
    { route: "missing" },
    { route: "foreign-route" },
    { route: "language-route", owner: other },
  ])
    assert.equal(
      await observe("runtime by route negative " + JSON.stringify(input), {
        op: "model-runtime-route",
        ...input,
      }),
      null,
    );
  for (const operation of ["embedding", "decision"]) {
    const input = {
      op: "model-operation-route",
      operation,
      model: operation + "-model",
      worker: "worker",
    };
    const route = await observe(operation + " catalog fallback", input);
    assert.equal(route.routeId, operation + "-route");
    assert.equal(
      route.capabilities[operation].modelRevision,
      "catalog-revision",
    );
    assert.equal(
      route.observedRevision,
      operation === "embedding" ? "catalog-revision" : null,
    );
    const cap = (revision) => ({
      [operation]: {
        status: "supported",
        source: "fixture",
        modelRevision: revision,
      },
    });
    for (const [id, worker, revision, date] of [
      ["global", null, "global-revision", "2026-10-27T00:00:00Z"],
      ["worker", "worker", "worker-revision", "2026-10-26T00:00:00Z"],
      [
        "other-worker",
        "other-worker",
        "other-revision",
        "2026-10-28T00:00:00Z",
      ],
    ])
      await seed(
        `INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,state,operation_capabilities,updated_at) VALUES(${literal(operation + "-" + id)},${literal(operation + "-catalog")},${literal(id)},${worker === null ? "NULL" : literal(worker)},'available',${literal(JSON.stringify(cap(revision)))}::jsonb,${literal(date)})`,
      );
    assert.equal(
      (await observe(operation + " worker scope wins over newer global", input))
        .capabilities[operation].modelRevision,
      "worker-revision",
    );
    assert.equal(
      (
        await observe(operation + " unmatched worker uses global", {
          ...input,
          worker: "unobserved",
        })
      ).capabilities[operation].modelRevision,
      "global-revision",
    );
    await seed(
      `DELETE FROM provider_model_availability WHERE id=${literal(operation + "-global")}`,
    );
    assert.deepEqual(
      (
        await observe(
          operation + " unrelated worker prevents catalog fallback",
          { ...input, worker: "unobserved" },
        )
      ).capabilities,
      {},
    );
    for (const extra of [
      { owner: other },
      { model: "missing" },
      { operation: operation === "embedding" ? "decision" : "embedding" },
      { route: "missing" },
    ])
      assert.equal(
        await observe(
          operation + " operation negative " + JSON.stringify(extra),
          { ...input, ...extra },
        ),
        null,
      );
    // Source treats an empty optional selector as absent, as language runtime selection does.
    assert.equal(
      (
        await observe(operation + " empty operation route means no selector", {
          ...input,
          route: "",
        })
      ).routeId,
      operation + "-route",
    );
  }
  const provider = await observe("update inference configuration", {
    op: "provider-update",
    provider: "language-provider",
    input: {
      name: "language-provider",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      maxConcurrentInference: 2,
    },
  });
  assert.equal(provider.maxConcurrentInference, 2);
  assert.equal(provider.inferenceConfigRevision, 1);
  const updated = await observe("inference catalog after configuration write", {
    op: "inference-catalog",
  });
  assert.equal(updated.catalogRevision, catalog.catalogRevision);
  assert.equal(
    updated.configurations.find((c) => c.providerId === "language-provider")
      .maxConcurrentInference,
    2,
  );
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await open(i ? "rust" : "node", i);
  }
  assert.deepEqual(
    await observe("inference catalog retained after actual reopen", {
      op: "inference-catalog",
    }),
    updated,
  );
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const fixture of pair)
    try {
      await fixture.close();
    } catch (error) {
      failure ??= error;
      report.cleanupFailures.push(error.stack ?? String(error));
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailures.push(error.stack ?? String(error));
  }
  if (failure) report.passed = false;
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !values["keep-fixture"])
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode: values.database,
    cases: report.cases.length,
    passed: true,
  }),
);
