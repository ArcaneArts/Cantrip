// Current Source facade versus actual native repositories and migrated stores.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { repositoryFixture } from "./repository-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  identityStateSql,
  identitySnapshotSql,
  owner,
  other,
  literal,
  json,
  stamp,
  principalId,
  replacementId,
  replacement,
  wrappedKey,
  usage,
} from "./identity-state-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-identity-state-"));
const report = {
  suite: "identity-state-repositories",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  cases: [],
  cleanupFailures: [],
};
const peers = [],
  urls = [];
let pg, executable, failure;
const started = Date.now();
const open = (kind, i) =>
  repositoryFixture({
    kind,
    root,
    executable,
    databaseMode: values.database,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const p of peers) await p.seed(sql);
};
async function snapshot(peer) {
  const response = await peer.request({
    op: "query-json",
    sql: identitySnapshotSql,
  });
  assert.equal(response.rejected, false, response.diagnostic);
  return response.value;
}
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
    if (value.source_key?.startsWith("model-operation:")) {
      assert.match(
        value.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      result.id = "<verified usage UUID>";
    }
    return result;
  }
  if (
    typeof value === "string" &&
    (key.endsWith("_at") || key.endsWith("At"))
  ) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at), key);
    if (at >= started && at <= Date.now()) return "<verified write clock>";
    return new Date(at).toISOString();
  }
  return value;
}
async function observe(
  name,
  op,
  input = {},
  {
    expected,
    rejected = false,
    message,
    unchanged = false,
    check = () => {},
  } = {},
) {
  const request = {
    owner,
    worker: "alpha",
    ...input,
    op: "identity-state-" + op,
  };
  const observations = [];
  report.cases.push({ name, input: request, observations });
  for (const peer of peers) {
    const before = await snapshot(peer),
      start = Date.now(),
      response = await peer.request(request),
      end = Date.now(),
      after = await snapshot(peer);
    observations.push({ before, response, after, start, end });
    assert.equal(
      response.rejected,
      rejected,
      name + ": " + response.diagnostic,
    );
    if (expected !== undefined)
      assert.deepEqual(response.value, expected, name);
    if (message) assert.equal(response.diagnostic, message, name);
    if (unchanged || rejected)
      assert.deepEqual(
        after,
        before,
        name + " unchanged durable rows and clocks",
      );
    check({ before, response, after, start, end });
  }
  assert.deepEqual(
    normalize(observations[1].after),
    normalize(observations[0].after),
    name + " exact durable state",
  );
  if (!rejected)
    assert.deepEqual(
      normalize(observations[1].response.value),
      normalize(observations[0].response.value),
      name + " result",
    );
  return observations;
}
try {
  executable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || values.database === "postgres")
        ? await pg.database()
        : undefined;
    peers.push(await open(kind, i));
  }
  for (const sql of identityStateSql()) await seed(sql);

  for (const [email, expected] of [
    ["alice@example.invalid", true],
    ["Alice@example.invalid", false],
    ["unknown@example.invalid", false],
    ["é@example.invalid", false],
  ])
    await observe(
      "exact whitelist membership " + email,
      "whitelisted",
      { email },
      { expected, unchanged: true },
    );
  for (const [session, expected] of [
    ["missing", false],
    ["revoked-session", false],
    ["valid-session", true],
    ["expired-session", true],
  ])
    await observe(
      "CSRF rotation " + session,
      "rotate-csrf",
      { session, hash: "new-" + session },
      {
        expected,
        unchanged: !expected,
        check: ({ after, start, end }) => {
          if (!expected) return;
          const row = after.sessions.find((s) => s.id === session);
          assert.equal(row.csrf_token_hash, "new-" + session);
          for (const k of ["last_seen_at", "updated_at"])
            assert.ok(Date.parse(row[k]) >= start && Date.parse(row[k]) <= end);
        },
      },
    );
  await observe(
    "strict mobile expiry boundary",
    "prune-mobile",
    { before: stamp },
    {
      expected: null,
      check: ({ after }) =>
        assert.deepEqual(
          after.mobile.map((x) => x.id),
          ["boundary", "consumed-newer", "newer"],
        ),
    },
  );
  await observe(
    "mobile prune replay",
    "prune-mobile",
    { before: stamp },
    { expected: null, unchanged: true },
  );
  await observe(
    "later mobile cutoff",
    "prune-mobile",
    { before: new Date(Date.parse(stamp) + 1).toISOString() },
    {
      expected: null,
      check: ({ after }) =>
        assert.deepEqual(
          after.mobile.map((x) => x.id),
          ["consumed-newer", "newer"],
        ),
    },
  );

  await observe(
    "find active worker principal",
    "active-principal",
    {},
    {
      unchanged: true,
      check: ({ response }) => assert.equal(response.value.id, principalId),
    },
  );
  for (const changes of [
    { owner: other },
    { worker: "beta" },
    { worker: "missing" },
  ])
    await observe(
      "principal owner/worker fence " + JSON.stringify(changes),
      "active-principal",
      changes,
      { expected: null, unchanged: true },
    );
  await observe(
    "find worker principal by ID",
    "principal-by-id",
    { principal: principalId },
    {
      unchanged: true,
      check: ({ response }) => assert.equal(response.value.id, principalId),
    },
  );
  for (const changes of [
    { owner: other },
    { worker: "beta" },
    { principal: "missing" },
  ])
    await observe(
      "explicit principal fence " + JSON.stringify(changes),
      "principal-by-id",
      { principal: principalId, ...changes },
      { expected: null, unchanged: true },
    );
  for (const changes of [
    { owner: other },
    { worker: "beta" },
    { input: { ...replacement, kind: "client", workerId: null } },
    { input: { ...replacement, id: principalId } },
  ])
    await observe(
      "principal replacement rejection " + JSON.stringify(changes),
      "replace-principal",
      { input: replacement, ...changes },
      { expected: null, unchanged: true },
    );
  await observe(
    "replace principal and revoke opaque grants",
    "replace-principal",
    { input: replacement },
    {
      check: ({ before, response, after, start, end }) => {
        assert.equal(response.value.id, replacementId);
        assert.equal(response.value.state, "pending");
        const previous = after.principals.find((p) => p.id === principalId);
        assert.equal(previous.state, "revoked");
        assert.equal(previous.revision, 2);
        assert.equal(
          previous.revoked_reason,
          "worker encryption identity rotated",
        );
        assert.equal(after.grants[0].state, "revoked");
        assert.equal(after.grants[0].revision, 2);
        assert.deepEqual(after.grants[0].wrapped_key, wrappedKey);
        assert.deepEqual(
          before.grants[0].wrapped_key,
          after.grants[0].wrapped_key,
        );
        assert.ok(
          Date.parse(previous.revoked_at) >= start &&
            Date.parse(previous.revoked_at) <= end,
        );
      },
    },
  );
  await observe(
    "retained revoked principal remains readable by ID",
    "principal-by-id",
    { principal: principalId },
    {
      unchanged: true,
      check: ({ response }) => assert.equal(response.value.state, "revoked"),
    },
  );
  await observe(
    "active principal after replacement",
    "active-principal",
    {},
    {
      unchanged: true,
      check: ({ response }) => assert.equal(response.value.id, replacementId),
    },
  );
  // A failed INSERT must roll back the preceding principal/grant revocation.
  await observe(
    "replacement primary key failure rolls back",
    "replace-principal",
    { input: { ...replacement, id: principalId } },
    { rejected: true },
  );

  for (const [principal, expected] of [
    [owner, 3],
    [other, 1],
    ["missing", 0],
  ])
    await observe(
      "online workers owner " + principal,
      "online-count",
      { owner: principal },
      { expected, unchanged: true },
    );
  await seed("UPDATE workers SET last_seen_at='2000-01-01' WHERE id='beta'");
  await observe(
    "offline worker excluded",
    "online-count",
    {},
    { expected: 2, unchanged: true },
  );
  await seed("UPDATE workers SET unlinked_at='2026-10-25' WHERE id='alpha'");
  await observe(
    "unlinked worker excluded",
    "online-count",
    {},
    { expected: 1, unchanged: true },
  );
  await seed("UPDATE workers SET unlinked_at=NULL WHERE id='alpha'");

  const running = { ...usage, receipt: undefined, transportStatus: "running" };
  await observe(
    "record independent running operation",
    "operation-usage",
    { input: running },
    {
      expected: null,
      check: ({ after }) => {
        assert.equal(after.usage.length, 1);
        assert.equal(after.usage[0].attempt_status, "running");
        assert.equal(after.usage[0].finalized_at, null);
      },
    },
  );
  await observe(
    "record observed terminal receipt",
    "operation-usage",
    { input: usage },
    {
      expected: null,
      check: ({ after }) => {
        assert.equal(after.usage.length, 1);
        assert.equal(after.usage[0].attempt_status, "completed");
        assert.equal(after.usage[0].input_tokens, 12);
        assert.deepEqual(
          after.usage[0].model_operation_usage.receipt,
          usage.receipt,
        );
      },
    },
  );
  for (const input of [
    usage,
    running,
    { ...usage, transportStatus: "unavailable", receipt: undefined },
  ])
    await observe(
      "terminal usage is immutable " + input.transportStatus,
      "operation-usage",
      { input },
      { expected: null, unchanged: true },
    );
  await observe(
    "usage identity collision",
    "operation-usage",
    {
      input: {
        ...running,
        identity: { ...running.identity, modelId: "foreign-model" },
      },
    },
    {
      rejected: true,
      message:
        "Model operation usage identity conflicts with its retained dispatch.",
    },
  );
  await observe(
    "receipt identity rejection",
    "operation-usage",
    {
      input: {
        ...usage,
        receipt: { ...usage.receipt, modelId: "foreign-model" },
      },
    },
    {
      rejected: true,
      message:
        "Model operation usage belongs to another dispatch or has invalid counts.",
    },
  );
  await observe(
    "inconsistent receipt rejection",
    "operation-usage",
    { input: { ...usage, receipt: { ...usage.receipt, requests: 2 } } },
    {
      rejected: true,
      message:
        "Model operation usage belongs to another dispatch or has invalid counts.",
    },
  );
  const unknown = {
    ...running,
    identity: {
      ...running.identity,
      operationId: "00000000-0000-4000-8000-000000000002",
    },
    transportStatus: "unavailable",
  };
  await observe(
    "missing receipt stays unknown",
    "operation-usage",
    { input: unknown },
    {
      expected: null,
      check: ({ after }) =>
        assert.equal(
          after.usage.find(
            (r) => r.execution_attempt_id === unknown.identity.operationId,
          ).attempt_status,
          "unknown",
        ),
    },
  );
  await observe(
    "late running cannot reopen unknown final transport",
    "operation-usage",
    { input: { ...unknown, transportStatus: "running" } },
    { expected: null, unchanged: true },
  );

  await seed(
    `UPDATE token_usage_records SET provider_account_id='usage-account',turn_id='previous-turn',reasoning_effort='high' WHERE execution_attempt_id=${literal(unknown.identity.operationId)}`,
  );
  await observe(
    "final receipt clears obsolete chat attribution",
    "operation-usage",
    {
      input: { ...unknown, transportStatus: "replied", receipt: usage.receipt },
    },
    {
      expected: null,
      check: ({ after }) => {
        const row = after.usage.find(
          (r) => r.execution_attempt_id === unknown.identity.operationId,
        );
        assert.equal(row.turn_id, null);
        assert.equal(row.reasoning_effort, null);
        assert.equal(row.provider_account_id, null);
      },
    },
  );

  const noopNames = [
    "migrateProviderSecrets",
    "migrateProviderAccountCredentialSecrets",
    "migrateMcpServerSecrets",
  ];
  const file =
    "tests/reference-node-server/src/db/repository-facade-identity-model.ts";
  const raw = await readFile(file, "utf8");
  const methods = [];
  for (const name of noopNames) {
    const declaration = new RegExp(
      "async " + name + "\\(\\): Promise<void> \\{([\\s\\S]*?)^  \\}",
      "m",
    ).exec(raw);
    assert.ok(declaration, "Current Source no-op declaration " + name);
    assert.equal(
      declaration[1].replace(/\/\/[^\n]*/g, "").trim(),
      "",
      "No executable Source no-op body: " + name,
    );
    methods.push(name);
  }
  assert.deepEqual(methods, noopNames);
  const migration =
      "cantrip_server/drizzle/0120_protected_provider_mcp_secrets.sql",
    migrationRaw = await readFile(migration);
  report.noopDisposition = {
    sourceFile: file,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    emptyMethods: methods,
    migration,
    migrationSha256: createHash("sha256").update(migrationRaw).digest("hex"),
  };
  await observe(
    "legacy no-ops and native migration replay retain current state",
    "legacy-noops",
    {},
    {
      expected: null,
      unchanged: true,
      check: ({ after }) => {
        assert.equal(after.providerAccounts[0].credential_state, "signed-in");
        assert.ok(after.providerAccounts[0].protected_credential);
        assert.ok(
          after.providers.find((p) => p.id === "fixture").protected_api_key,
        );
        assert.equal(after.mcp.length, 1);
      },
    },
  );
  const retained = await Promise.all(peers.map(snapshot));
  for (const peer of peers) await peer.close();
  peers.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    peers.push(await open(kind, i));
  assert.deepEqual(
    await Promise.all(peers.map(snapshot)),
    retained,
    "exact scoped rows and clocks survive repository restart",
  );
  report.retained = retained;
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.passed = false;
} finally {
  for (const close of [...peers.map((p) => () => p.close()), () => pg?.close()])
    try {
      await close();
    } catch (error) {
      failure ??= error;
      report.cleanupFailures.push(error.stack);
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
    passed: true,
    database: values.database,
    cases: report.cases.length,
  }),
);
