// Actual Node and Rust repositories, isolated real stores, exact rollback
// snapshots. Scope rows are fixtures; project/workspace CRUD is not claimed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { assets } from "./policy-assets.mjs";
import { policyCreate, policyEnvelope } from "./policy-wire-fixtures.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const executable = await buildRustExample("policy-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-policy-repository-"));
const report = {
  suite: "actual-policy-repositories",
  databaseMode,
  completeReplacement: false,
  root,
  cases: [],
};
const pair = [],
  options = [];
let postgresOwner, failure;
const owner = "policy-owner",
  other = "policy-other",
  stamp = "2026-10-25T00:00:00.000Z";
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const uuid = (n) =>
  `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const policy = (n, fields = {}) => ({
  ...structuredClone(policyCreate),
  id: uuid(n),
  content: {
    ...structuredClone(policyCreate.content),
    keyBlindIndex: createHash("sha256")
      .update("policy-" + n)
      .digest("base64url"),
  },
  ...fields,
});
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
  if (typeof value === "string" && /(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  return value;
}
async function seed(sql) {
  for (const f of pair) await f.seed(sql);
}
async function compare(
  label,
  input,
  { rejected = false, code, compareError = true } = {},
) {
  const expected = await pair[0].request(input),
    actual = await pair[1].request(input);
  report.cases.push({ label, input, expected, actual });
  assert.equal(expected.rejected, rejected, "reference outcome: " + label);
  assert.equal(
    actual.rejected,
    expected.rejected,
    label + ": " + actual.diagnostic,
  );
  if (rejected && compareError) {
    assert.equal(actual.code, expected.code, label);
    assert.equal(expected.code, code, label);
    if (code) assert.equal(actual.diagnostic, expected.diagnostic, label);
  }
  if (!rejected)
    assert.deepEqual(normalize(actual.value), normalize(expected.value), label);
  return expected.value;
}
const snapshotSql =
  "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner_id) FROM policy_owner_states t),'policies',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM policies t),'workspace',(SELECT jsonb_agg(to_jsonb(t) ORDER BY workspace_id,policy_id) FROM workspace_policy_assignments t),'project',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,policy_id) FROM project_policy_assignments t)) AS result";
async function snapshots() {
  return Promise.all(
    pair.map(async (f) => {
      const r = await f.request({ op: "query-json", sql: snapshotSql });
      assert.equal(r.rejected, false, r.diagnostic);
      return r.value;
    }),
  );
}
async function noWrites(label, input, code) {
  const before = await snapshots();
  await compare(label, input, { rejected: true, code, compareError: !!code });
  const after = await snapshots();
  before.forEach((value, index) =>
    assert.deepEqual(
      after[index],
      value,
      label + ": exact rollback/runtime " + index,
    ),
  );
  report.cases.at(-1).unchangedSnapshots = true;
}
const list = () => compare("current collection", { op: "list", owner });
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"]) {
    const config = {
      kind,
      executable,
      root,
      databaseMode,
      nodeScript: "scripts/server-rust/policy-node-fixture.mjs",
      databaseUrl:
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined,
    };
    options.push(config);
    pair.push(await repositoryFixture(config));
  }
  await seed("DELETE FROM users;");
  for (const id of [owner, other])
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email,created_at,updated_at) VALUES(${literal(id)},'account','member','active','Fixture',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")},${literal(stamp)},${literal(stamp)});`,
    );
  await compare("public template summaries", { op: "templates" });
  for (const template of assets.templates)
    await compare("template " + template.templateKey, {
      op: "template",
      key: template.templateKey,
    });
  await compare("missing template", { op: "template", key: "missing" });
  await compare(
    "reorder does not initialize owner state",
    {
      op: "order",
      owner: other,
      input: { collectionVersion: 1, policyIds: [] },
    },
    { rejected: true, code: "collection-changed" },
  );
  await list();
  await compare("other collection", { op: "list", owner: other });
  const defaults = assets.templates
    .filter((t) => t.suggestedDefault)
    .map((t, i) => policy(100 + i, { templateKey: t.templateKey }));
  await noWrites(
    "invalid bootstrap does not claim version",
    {
      op: "bootstrap",
      owner,
      input: {
        expectedBootstrapVersion: 0,
        policies: [policy(101, { templateKey: "missing-default" })],
      },
    },
    "invalid-order",
  );
  await compare("encrypted default bootstrap", {
    op: "bootstrap",
    owner,
    input: { expectedBootstrapVersion: 0, policies: defaults },
  });
  await compare("raced bootstrap is no-op", {
    op: "bootstrap",
    owner,
    input: { expectedBootstrapVersion: 0, policies: defaults },
  });
  await compare("current bootstrap version can be claimed", {
    op: "bootstrap",
    owner,
    input: {
      expectedBootstrapVersion: assets.bootstrapVersion,
      policies: defaults,
    },
  });
  const first = await compare("opaque create", {
    op: "create",
    owner,
    input: policy(1, { mandatory: true, audience: "both" }),
  });
  await noWrites(
    "blind-index duplicate rolls back collection",
    { op: "create", owner, input: { ...policy(1), id: uuid(2) } },
    "duplicate-key",
  );
  await noWrites(
    "ID duplicate rolls back collection",
    { op: "create", owner, input: policy(2, { id: first.id }) },
    "duplicate-key",
  );
  await compare("same blind index in another tenant", {
    op: "create",
    owner: other,
    input: policy(1, { id: uuid(3) }),
  });
  await compare("foreign get is absent", {
    op: "get",
    owner: other,
    policy: first.id,
  });
  await compare("foreign update is absent", {
    op: "update",
    owner: other,
    policy: first.id,
    input: { rowVersion: 1, enabled: false },
  });
  await compare("foreign delete is absent", {
    op: "delete",
    owner: other,
    policy: first.id,
    version: 1,
  });
  const second = await compare("chat-only create", {
    op: "create",
    owner,
    input: policy(4, { audience: "chat" }),
  });
  const third = await compare("disabled create", {
    op: "create",
    owner,
    input: policy(5, { enabled: false, mandatory: true }),
  });
  await compare("opaque content update preserves blind index", {
    op: "update",
    owner,
    policy: first.id,
    input: {
      rowVersion: 1,
      content: {
        protectedSummary: { ...policyEnvelope, keyRevision: 2 },
        protectedBody: { ...policyEnvelope, keyRevision: 3 },
      },
      mandatory: false,
    },
  });
  await noWrites(
    "stale row rejects update",
    {
      op: "update",
      owner,
      policy: first.id,
      input: { rowVersion: 1, enabled: false },
    },
    "stale-version",
  );
  await noWrites(
    "stale row rejects delete",
    { op: "delete", owner, policy: first.id, version: 1 },
    "stale-version",
  );
  await compare("missing get", { op: "get", owner, policy: "missing" });
  await compare("standalone includes enabled chat audience", {
    op: "standalone",
    owner,
  });
  let current = await list();
  await noWrites(
    "incomplete order rolls back collection",
    {
      op: "order",
      owner,
      input: {
        collectionVersion: current.collectionVersion,
        policyIds: [first.id],
      },
    },
    "invalid-order",
  );
  current = await compare("collection reorder", {
    op: "order",
    owner,
    input: {
      collectionVersion: current.collectionVersion,
      policyIds: current.policies.map((p) => p.id).reverse(),
    },
  });
  assert.equal(
    current.policies.find((p) => p.id === first.id).rowVersion,
    2,
    "reorder does not increment row versions",
  );
  await noWrites(
    "stale collection rejects reorder",
    {
      op: "order",
      owner,
      input: {
        collectionVersion: current.collectionVersion - 1,
        policyIds: current.policies.map((p) => p.id),
      },
    },
    "collection-changed",
  );
  const protectedLabel = {
    classification: { recordKind: "project" },
    protectedLabel: policyEnvelope,
  };
  for (const [id, principal] of [
    ["project", owner],
    ["foreign-project", other],
  ])
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES(${literal(id)},${literal(principal)},${literal(JSON.stringify(protectedLabel))},'managed-folder','external','direct');`,
    );
  for (const [id, principal] of [
    ["workspace", owner],
    ["foreign-workspace", other],
  ])
    await seed(
      `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision) VALUES(${literal(id)},${literal(principal)},${literal(JSON.stringify(policyEnvelope.envelope))},${literal(id)},1,1);`,
    );
  await seed(
    "INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES('workspace','project');",
  );
  for (const workspace of [false, true]) {
    const scope = workspace ? "workspace" : "project";
    await compare("empty " + scope + " assignments", {
      op: "assignments",
      owner,
      workspace,
      scope,
    });
    await compare("foreign " + scope + " list", {
      op: "assignments",
      owner: other,
      workspace,
      scope,
    });
    current = await list();
    await noWrites(
      "missing scope rolls back claim " + scope,
      {
        op: "replace",
        owner,
        workspace,
        scope: "missing",
        input: { collectionVersion: current.collectionVersion, policyIds: [] },
      },
      "scope-not-found",
    );
    await noWrites(
      "stale version precedes missing scope " + scope,
      {
        op: "replace",
        owner,
        workspace,
        scope: "missing",
        input: {
          collectionVersion: current.collectionVersion - 1,
          policyIds: [],
        },
      },
      "collection-changed",
    );
    await noWrites(
      "foreign scope rolls back claim " + scope,
      {
        op: "replace",
        owner: other,
        workspace,
        scope,
        input: {
          collectionVersion: (
            await pair[0].request({ op: "list", owner: other })
          ).value.collectionVersion,
          policyIds: [],
        },
      },
      "scope-not-found",
    );
    await noWrites(
      "foreign policy rolls back replacement " + scope,
      {
        op: "replace",
        owner,
        workspace,
        scope,
        input: {
          collectionVersion: current.collectionVersion,
          policyIds: [uuid(3)],
        },
      },
      "scope-not-found",
    );
    await compare("assign " + scope, {
      op: "replace",
      owner,
      workspace,
      scope,
      input: {
        collectionVersion: current.collectionVersion,
        policyIds: [first.id, second.id, third.id],
      },
    });
    await compare("assignment order follows collection " + scope, {
      op: "assignments",
      owner,
      workspace,
      scope,
    });
  }
  await compare("effective filters disabled and chat policies", {
    op: "effective",
    owner,
    project: "project",
  });
  await compare("enable mandatory and direct source", {
    op: "update",
    owner,
    policy: first.id,
    input: { rowVersion: 2, mandatory: true },
  });
  const effective = await compare(
    "ordered mandatory workspace project sources",
    { op: "effective", owner, project: "project" },
  );
  assert.deepEqual(effective.policies[0].sources, [
    { type: "mandatory" },
    { type: "workspace", workspaceId: "workspace" },
    { type: "project", projectId: "project" },
  ]);
  await compare("foreign effective is absent", {
    op: "effective",
    owner: other,
    project: "project",
  });
  current = await list();
  await seed(
    "CREATE FUNCTION policy_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'policy-fixture-fault'; END; $$;",
  );
  await seed(
    "CREATE TRIGGER policy_fixture_insert BEFORE INSERT ON project_policy_assignments FOR EACH ROW EXECUTE FUNCTION policy_fixture_fail();",
  );
  await noWrites("insert fault restores old assignments and collection", {
    op: "replace",
    owner,
    scope: "project",
    input: {
      collectionVersion: current.collectionVersion,
      policyIds: [second.id],
    },
  });
  await seed(
    "DROP TRIGGER policy_fixture_insert ON project_policy_assignments;",
  );
  await seed("DROP FUNCTION policy_fixture_fail();");
  await compare("delete cascades assignments", {
    op: "delete",
    owner,
    policy: first.id,
    version: 3,
  });
  await compare("effective after delete", {
    op: "effective",
    owner,
    project: "project",
  });
  await compare("delete already absent", {
    op: "delete",
    owner,
    policy: first.id,
    version: 3,
  });
  await compare("assignment counts after cascade", {
    op: "assignments",
    owner,
    scope: "project",
  });
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await repositoryFixture(options[i]);
  }
  await compare("retained collection after process reopen", {
    op: "list",
    owner,
  });
  await compare("retained assignments after process reopen", {
    op: "assignments",
    owner,
    workspace: true,
    scope: "workspace",
  });
  await seed(`DELETE FROM policies WHERE owner_id=${literal(owner)};`);
  await seed(
    `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,mandatory,audience) SELECT 'limit-'||n,${literal(owner)},md5(n::text)||repeat('A',11),${literal(JSON.stringify(policyEnvelope))},${literal(JSON.stringify(policyEnvelope))},true,'both' FROM generate_series(1,65) n;`,
  );
  await noWrites(
    "IDE effective policy limit",
    { op: "effective", owner, project: "project" },
    "limit-exceeded",
  );
  await noWrites(
    "Chat effective policy limit",
    { op: "standalone", owner },
    "limit-exceeded",
  );
  await seed(
    `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body) SELECT 'limit-'||n,${literal(owner)},md5(n::text)||repeat('A',11),${literal(JSON.stringify(policyEnvelope))},${literal(JSON.stringify(policyEnvelope))} FROM generate_series(66,500) n;`,
  );
  await noWrites(
    "owner policy limit rolls back collection",
    { op: "create", owner, input: policy(600) },
    "limit-exceeded",
  );
  const full = await list();
  assert.equal(full.policies.length, 500);
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  const cleanup = await Promise.allSettled(pair.map((f) => f.close()));
  if (postgresOwner)
    cleanup.push(
      await Promise.resolve(postgresOwner.close()).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      ),
    );
  report.cleanupFailures = cleanup
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason));
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
assert.deepEqual(report.cleanupFailures, []);
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    completeReplacement: false,
    reportPath,
  }),
);
