// Production entrypoints over real HTTP and Live sockets. Uses the existing
// client crypto to prove ciphertext survives persistence without server keys.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { policyCreate, policyEnvelope } from "./policy-wire-fixtures.mjs";
import {
  encryptPolicyContent,
  decryptPolicySummaryContent,
  decryptPolicyBodyContent,
} from "../../packages/crypto/dist/policy-content.js";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-policy-http-"));
const report = {
  suite: "actual-policy-http-live-crypto",
  databaseMode,
  root,
  completeReplacement: false,
  runtimes: [],
};
let postgresOwner, failure;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
    "policy-repository-fixture",
  );
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      postgresOwner && (kind === "node" || databaseMode === "postgres")
        ? await postgresOwner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "policies",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_SESSION_TTL_SECONDS: "3600",
        CANTRIP_REGISTRATION_ENABLED: "true",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...(kind === "rust" && databaseMode === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    const observations = [],
      result = {
        kind,
        observations,
        publications: [],
        queryErrors: [],
        crypto: {},
      };
    report.runtimes.push(result);
    let accountOwner;
    let repository, live, otherLive;
    const policyEvents = (probe) =>
      probe.history.filter(
        (frame) => frame.type === "event" && frame.resource === "policy",
      );
    async function visit(label, method, url, options = {}) {
      const started = Date.now();
      const before = live ? policyEvents(live).length : 0;
      const observation = await fixture.observe(label, method, url, {
        csrf: method !== "GET" && method !== "HEAD",
        ...options,
      });
      if (observation.body?.error?.startsWith("Failed query: ")) {
        const raw = observation.body.error;
        if (raw.includes('"owner_id"'))
          assert.ok(raw.includes(accountOwner), label + ": query owner");
        const normalized = raw
          .replaceAll(accountOwner, "<policy-owner>")
          .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (date) => {
            assert.ok(
              Date.parse(date) >= started && Date.parse(date) <= Date.now(),
              label + ": actual query timestamp",
            );
            return "<query-timestamp>";
          });
        result.queryErrors.push({ label, raw });
        observation.body = { error: normalized };
      }
      observations.push({ label, ...observation });
      if (live) {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(method) &&
          observation.status < 400
        ) {
          const event = await live.message(
            (frame) => frame.type === "event" && frame.resource === "policy",
          );
          const expectedId =
            url.startsWith("/api/policies/") &&
            !["/api/policies/bootstrap", "/api/policies/order"].includes(url)
              ? decodeURIComponent(url.split("/").at(-1))
              : null;
          assert.equal(event.entityId, expectedId, label + ": entity");
          assert.equal(event.action, "invalidated");
          assert.equal(event.payload, null);
          assert.equal(event.revision, null);
          result.publications.push({ label, event });
        }
        await live.ping(label + " barrier");
        assert.equal(
          policyEvents(live).length,
          before +
            (!["GET", "HEAD", "OPTIONS"].includes(method) &&
            observation.status < 400
              ? 1
              : 0),
          label + ": one success publication",
        );
        assert.equal(
          policyEvents(otherLive).length,
          0,
          label + ": foreign subscriber isolation",
        );
      }
      return fixture.records.get(label);
    }
    try {
      await fixture.start();
      for (const route of [
        "/api/policies",
        "/api/policy-templates",
        "/api/policy-templates/missing",
        "/api/policies/missing",
        "/api/projects/project/policies",
        "/api/projects/project/effective-policies",
        "/api/workspaces/workspace/policies",
      ])
        await visit("anonymous " + route, "GET", route, { status: 401 });
      for (const client of ["main", "second"])
        await fixture.observe(
          "register " + client,
          "POST",
          "/api/auth/register",
          {
            client,
            status: 201,
            json: {
              displayName: "Policy " + client,
              email: `policy-${client}@example.invalid`,
              password: "isolated policy fixture password",
            },
          },
        );
      const owner = fixture.records.get("register main").currentUser.id;
      accountOwner = owner;
      const other = fixture.records.get("register second").currentUser.id;
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, "policies"),
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/policy-node-fixture.mjs",
      });
      const protectedLabel = {
        classification: { recordKind: "project" },
        protectedLabel: policyEnvelope,
      };
      for (const [scope, principal] of [
        ["project", owner],
        ["foreign-project", other],
      ])
        await repository.seed(
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES(${literal(scope)},${literal(principal)},${literal(JSON.stringify(protectedLabel))},'managed-folder','external','direct');`,
        );
      for (const [scope, principal] of [
        ["workspace", owner],
        ["foreign-workspace", other],
      ])
        await repository.seed(
          `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision) VALUES(${literal(scope)},${literal(principal)},${literal(JSON.stringify(policyEnvelope.envelope))},${literal(scope)},1,1);`,
        );
      await repository.seed(
        "INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES('workspace','project');",
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      live = new LiveProbe(fixture);
      await live.open();
      await live.initialized();
      await live.subscribed();
      otherLive = new LiveProbe(fixture, { client: "second" });
      await otherLive.open();
      await otherLive.initialized();
      await otherLive.subscribed();
      const templates = await visit(
        "templates",
        "GET",
        "/api/policy-templates",
      );
      for (const template of templates)
        await visit(
          "template " + template.templateKey,
          "GET",
          "/api/policy-templates/" + template.templateKey,
        );
      await visit("missing template", "GET", "/api/policy-templates/missing", {
        status: 404,
      });
      await visit("empty policies", "GET", "/api/policies");
      await visit("missing policy", "GET", "/api/policies/missing", {
        status: 404,
      });
      await visit("invalid create", "POST", "/api/policies", {
        json: {},
        status: 400,
      });
      await visit("malformed JSON", "POST", "/api/policies", {
        raw: "{",
        headers: { "content-type": "application/json" },
        status: 400,
      });
      await visit("missing CSRF", "POST", "/api/policies", {
        csrf: false,
        json: policyCreate,
        status: 403,
      });
      await visit("unexpected plaintext rejected", "POST", "/api/policies", {
        json: { ...policyCreate, bodyMarkdown: "must not be accepted" },
        status: 400,
      });
      await visit(
        "invalid bootstrap defaults",
        "POST",
        "/api/policies/bootstrap",
        {
          json: {
            expectedBootstrapVersion: 0,
            policies: [{ ...policyCreate, templateKey: "missing-default" }],
          },
          status: 409,
        },
      );
      await visit("bootstrap", "POST", "/api/policies/bootstrap", {
        json: { expectedBootstrapVersion: 0, policies: [] },
      });
      await visit("bootstrap race no-op", "POST", "/api/policies/bootstrap", {
        json: { expectedBootstrapVersion: 0, policies: [] },
      });
      await visit("create", "POST", "/api/policies", {
        json: policyCreate,
        status: 201,
      });
      await visit("duplicate blind index", "POST", "/api/policies", {
        json: { ...policyCreate, id: "22222222-2222-4222-8222-222222222222" },
        status: 409,
      });
      const id = policyCreate.id,
        url = "/api/policies/" + id;
      await visit("get", "GET", url);
      await visit("large row version update", "PATCH", url, {
        json: { rowVersion: 2147483648, enabled: false },
        status: 500,
      });
      await visit("row version next-value overflow", "PATCH", url, {
        json: { rowVersion: 2147483647, enabled: false },
        status: 500,
      });
      await visit("large row version delete", "DELETE", url, {
        json: { rowVersion: 2147483648 },
        status: 500,
      });
      await visit(
        "large collection version order",
        "PATCH",
        "/api/policies/order",
        {
          json: { collectionVersion: 2147483648, policyIds: [id] },
          status: 500,
        },
      );
      await visit(
        "large collection version assignment",
        "PATCH",
        "/api/projects/project/policies",
        {
          json: { collectionVersion: 2147483648, policyIds: [id] },
          status: 500,
        },
      );
      await visit(
        "large bootstrap version",
        "POST",
        "/api/policies/bootstrap",
        {
          json: { expectedBootstrapVersion: 2147483648, policies: [] },
          status: 500,
        },
      );
      await visit("HEAD", "HEAD", url);
      await visit("foreign get", "GET", url, { client: "second", status: 404 });
      await visit("foreign patch", "PATCH", url, {
        client: "second",
        json: { rowVersion: 1, enabled: false },
        status: 404,
      });
      await visit("foreign delete", "DELETE", url, {
        client: "second",
        json: { rowVersion: 1 },
        status: 404,
      });
      await visit("no update fields", "PATCH", url, {
        json: { rowVersion: 1 },
        status: 400,
      });
      await visit("update", "PATCH", url, {
        json: { rowVersion: 1, mandatory: true, audience: "both" },
      });
      await visit("stale update", "PATCH", url, {
        json: { rowVersion: 1, enabled: false },
        status: 409,
      });
      await visit("stale delete", "DELETE", url, {
        json: { rowVersion: 1 },
        status: 409,
      });
      await visit("duplicate order IDs", "PATCH", "/api/policies/order", {
        json: { collectionVersion: 3, policyIds: [id, id] },
        status: 400,
      });
      let current = await visit(
        "collection before order",
        "GET",
        "/api/policies",
      );
      await visit("incomplete order", "PATCH", "/api/policies/order", {
        json: { collectionVersion: current.collectionVersion, policyIds: [] },
        status: 409,
      });
      current = await visit("order", "PATCH", "/api/policies/order", {
        json: {
          collectionVersion: current.collectionVersion,
          policyIds: [id],
          ignored: true,
        },
      });
      for (const workspace of [false, true]) {
        const scope = workspace ? "workspace" : "project",
          base = `/api/${workspace ? "workspaces" : "projects"}/${scope}/policies`;
        await visit("empty " + scope + " assignments", "GET", base);
        await visit("foreign " + scope + " list", "GET", base, {
          client: "second",
          status: 404,
        });
        await visit("foreign " + scope + " mutation", "PATCH", base, {
          json: { collectionVersion: 1, policyIds: [] },
          client: "second",
          status: 404,
        });
        await visit("unavailable " + scope + " policy", "PATCH", base, {
          json: {
            collectionVersion: current.collectionVersion,
            policyIds: ["missing"],
          },
          status: 404,
        });
        await visit("unpaired " + scope + " policy ID", "PATCH", base, {
          json: {
            collectionVersion: current.collectionVersion,
            policyIds: ["\ud800"],
          },
          status: 404,
        });
        await visit(
          "distinct UTF16 IDs collapse only at database " + scope,
          "PATCH",
          base,
          {
            json: {
              collectionVersion: current.collectionVersion,
              policyIds: ["\ud800", "\ufffd"],
            },
            status: 404,
          },
        );
        current = await visit("assign " + scope, "PATCH", base, {
          json: {
            collectionVersion: current.collectionVersion,
            policyIds: [id],
          },
        });
        await visit("read " + scope + " assignment", "GET", base);
      }
      await visit(
        "effective",
        "GET",
        "/api/projects/project/effective-policies",
      );
      await visit(
        "foreign effective",
        "GET",
        "/api/projects/project/effective-policies",
        { client: "second", status: 404 },
      );
      const raceBody = { rowVersion: 2, enabled: false };
      const before = policyEvents(live).length;
      const race = await Promise.all(
        [0, 1].map(async () => {
          const r = await fetch(fixture.server.origin + url, {
            method: "PATCH",
            headers: {
              origin: "http://127.0.0.1:5173",
              "content-type": "application/json",
              "x-cantrip-csrf": fixture.client().csrf,
              cookie: [...fixture.client().cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            },
            body: JSON.stringify(raceBody),
          });
          return { status: r.status, body: await r.json() };
        }),
      );
      race.sort((a, b) => a.status - b.status);
      assert.deepEqual(
        race.map((r) => r.status),
        [200, 409],
      );
      await live.message(
        (frame) => frame.type === "event" && frame.resource === "policy",
      );
      await live.ping("race barrier");
      assert.equal(policyEvents(live).length, before + 1);
      observations.push({
        label: "concurrent row fence",
        responses: fixture.normalize(race),
      });
      await visit("delete", "DELETE", url, {
        json: { rowVersion: 3 },
        status: 204,
      });
      await visit(
        "empty effective after cascade",
        "GET",
        "/api/projects/project/effective-policies",
      );
      await visit("deleted policy", "GET", url, { status: 404 });
      const policyId = "33333333-3333-4333-8333-333333333333",
        componentKey = new Uint8Array(32).fill(37);
      const summary = {
          version: 1,
          key: "secret-policy",
          name: "Private policy name 🔐",
          summary: "Private encrypted policy summary",
        },
        body = {
          version: 1,
          bodyMarkdown: "# Private policy body\nThis stays at the endpoint.",
        };
      const cryptoContext = {
        ownerId: owner,
        policyId,
        keyRevision: 1,
        componentKey,
      };
      const content = await encryptPolicyContent({
        ...cryptoContext,
        summary,
        body,
      });
      const create = {
        ...policyCreate,
        id: policyId,
        content,
        audience: "chat",
      };
      // Capture raw bodies and verify them exactly. Fresh encryption and account
      // IDs differ per runtime, so they are not erased from the raw evidence.
      await fixture.observe("crypto create", "POST", "/api/policies", {
        json: create,
        csrf: true,
        status: 201,
      });
      await live.message(
        (frame) => frame.type === "event" && frame.resource === "policy",
      );
      assert.deepEqual(fixture.records.get("crypto create").content, content);
      await fixture.observe("crypto get", "GET", "/api/policies/" + policyId);
      const returned = fixture.records.get("crypto get");
      assert.deepEqual(returned.content, content);
      assert.deepEqual(
        await decryptPolicySummaryContent({
          ...cryptoContext,
          encrypted: returned.content.protectedSummary,
        }),
        summary,
      );
      assert.deepEqual(
        await decryptPolicyBodyContent({
          ...cryptoContext,
          encrypted: returned.content.protectedBody,
        }),
        body,
      );
      await assert.rejects(
        decryptPolicyBodyContent({
          ...cryptoContext,
          policyId: id,
          encrypted: returned.content.protectedBody,
        }),
      );
      await assert.rejects(
        decryptPolicySummaryContent({
          ...cryptoContext,
          ownerId: other,
          encrypted: returned.content.protectedSummary,
        }),
      );
      assert.equal(JSON.stringify(returned).includes(body.bodyMarkdown), false);
      result.crypto = {
        created: fixture.records.get("crypto create"),
        read: returned,
        summaryDecrypted: true,
        bodyDecrypted: true,
        wrongRowRejected: true,
        wrongOwnerRejected: true,
      };
      await live.close();
      live = undefined;
      await otherLive.close();
      otherLive = undefined;
      await fixture.close();
      await fixture.start();
      await fixture.observe(
        "crypto after restart",
        "GET",
        "/api/policies/" + policyId,
      );
      assert.deepEqual(
        fixture.records.get("crypto after restart").content,
        content,
      );
      result.crypto.retainedAfterRestart = true;
      await fixture.observe(
        "second account after restart",
        "GET",
        "/api/policies",
        { client: "second" },
      );
      assert.deepEqual(
        fixture.records.get("second account after restart").policies,
        [],
      );
      await visit(
        "delete proven crypto fixture",
        "DELETE",
        "/api/policies/" + policyId,
        { json: { rowVersion: 1 }, status: 204 },
      );
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, "policies"),
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/policy-node-fixture.mjs",
      });
      const edgeId = "44444444-4444-4444-8444-444444444444";
      await repository.seed(
        `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,position,enabled) VALUES(${literal(edgeId)},${literal(owner)},${literal(Buffer.alloc(32, 2).toString("base64url"))},${literal(JSON.stringify(policyEnvelope))},${literal(JSON.stringify(policyEnvelope))},2147483647,false);`,
      );
      await repository.seed(
        `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,enabled) VALUES(${literal("\ufffd")},${literal(owner)},${literal(Buffer.alloc(32, 3).toString("base64url"))},${literal(JSON.stringify(policyEnvelope))},${literal(JSON.stringify(policyEnvelope))},false);`,
      );
      await repository.seed(
        "ALTER TABLE project_policy_assignments ADD CONSTRAINT policy_fixture_refuse CHECK (false) NOT VALID;",
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      const beforeFaults = await visit(
        "before database faults",
        "GET",
        "/api/policies",
      );
      await visit(
        "order compares original UTF16 identifiers",
        "PATCH",
        "/api/policies/order",
        {
          json: {
            collectionVersion: beforeFaults.collectionVersion,
            policyIds: ["\ud800", edgeId],
          },
          status: 409,
        },
      );
      await visit("position overflow insert", "POST", "/api/policies", {
        json: { ...policyCreate, id: "55555555-5555-4555-8555-555555555555" },
        status: 500,
      });
      await visit(
        "assignment insert fault",
        "PATCH",
        "/api/projects/project/policies",
        {
          json: {
            collectionVersion: beforeFaults.collectionVersion,
            policyIds: [edgeId],
          },
          status: 500,
        },
      );
      const afterFaults = await visit(
        "after database faults",
        "GET",
        "/api/policies",
      );
      assert.deepEqual(
        afterFaults,
        beforeFaults,
        "failed inserts preserve the complete collection",
      );
      result.faultRollback = true;
      async function alter(sql) {
        await fixture.close();
        repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, "policies"),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/policy-node-fixture.mjs",
        });
        for (const statement of Array.isArray(sql) ? sql : [sql])
          await repository.seed(statement);
        await repository.close();
        repository = undefined;
        await fixture.start();
      }
      const version = beforeFaults.collectionVersion;
      await alter(
        "ALTER TABLE policies RENAME COLUMN owner_id TO fixture_owner_id;",
      );
      await visit("create count query failure", "POST", "/api/policies", {
        json: policyCreate,
        status: 500,
      });
      await visit(
        "assignment owner lookup failure",
        "PATCH",
        "/api/projects/project/policies",
        {
          json: { collectionVersion: version, policyIds: [edgeId] },
          status: 500,
        },
      );
      await visit(
        "query error preserves original UTF16 policy ID",
        "PATCH",
        "/api/projects/project/policies",
        {
          json: { collectionVersion: version, policyIds: ["\ud800"] },
          status: 500,
        },
      );
      await alter(
        "ALTER TABLE policies RENAME COLUMN fixture_owner_id TO owner_id;",
      );
      await alter(
        "ALTER TABLE policies RENAME COLUMN position TO fixture_position;",
      );
      await visit(
        "create maximum-position query failure",
        "POST",
        "/api/policies",
        { json: policyCreate, status: 500 },
      );
      await alter(
        "ALTER TABLE policies RENAME COLUMN fixture_position TO position;",
      );
      await alter(
        "ALTER TABLE policies RENAME COLUMN updated_at TO fixture_updated_at;",
      );
      await visit("reorder row write failure", "PATCH", "/api/policies/order", {
        json: {
          collectionVersion: version,
          policyIds: beforeFaults.policies.map((p) => p.id),
        },
        status: 500,
      });
      await alter(
        "ALTER TABLE policies RENAME COLUMN fixture_updated_at TO updated_at;",
      );
      await alter(
        "ALTER TABLE project_policy_assignments RENAME TO fixture_project_assignments;",
      );
      await visit(
        "assignment deletion failure",
        "PATCH",
        "/api/projects/project/policies",
        {
          json: { collectionVersion: version, policyIds: [edgeId] },
          status: 500,
        },
      );
      await alter(
        "ALTER TABLE fixture_project_assignments RENAME TO project_policy_assignments;",
      );
      await alter(
        "ALTER TABLE workspace_policy_assignments RENAME TO fixture_workspace_assignments;",
      );
      await visit(
        "committed update projection failure",
        "PATCH",
        "/api/policies/" + edgeId,
        { json: { rowVersion: 1, enabled: true }, status: 500 },
      );
      await visit(
        "committed bootstrap projection failure",
        "POST",
        "/api/policies/bootstrap",
        { json: { expectedBootstrapVersion: 2, policies: [] }, status: 500 },
      );
      await alter(
        "ALTER TABLE fixture_workspace_assignments RENAME TO workspace_policy_assignments;",
      );
      const committed = await visit(
        "writes retained after projection failure",
        "GET",
        "/api/policies",
      );
      assert.equal(committed.collectionVersion, version + 1);
      assert.equal(
        committed.policies.find((p) => p.id === edgeId).rowVersion,
        2,
      );
      assert.equal(
        committed.policies.find((p) => p.id === edgeId).enabled,
        true,
      );
      await alter(
        `ALTER TABLE policy_owner_states ADD CONSTRAINT policy_fixture_init CHECK (owner_id <> ${literal(owner)}) NOT VALID;`,
      );
      await visit(
        "owner initialization query failure",
        "POST",
        "/api/policies",
        { json: policyCreate, status: 500 },
      );
      await alter([
        "ALTER TABLE policy_owner_states DROP CONSTRAINT policy_fixture_init;",
        "CREATE FUNCTION policy_fixture_owner_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ALTER TABLE policy_owner_states RENAME TO fixture_policy_owner_states; RETURN OLD; END; $$;",
        "CREATE TRIGGER policy_fixture_owner_failure BEFORE DELETE ON policies FOR EACH ROW EXECUTE FUNCTION policy_fixture_owner_failure();",
      ]);
      await visit(
        "delete increment rolls back deletion",
        "DELETE",
        "/api/policies/" + edgeId,
        { json: { rowVersion: 2 }, status: 500 },
      );
      const final = await visit(
        "deletion rolled back after owner-state failure",
        "GET",
        "/api/policies",
      );
      assert.deepEqual(final, committed);
      result.postCommitProjectionFailureRetained = true;
    } finally {
      await live?.close();
      await otherLive?.close();
      await fixture.close();
      await repository?.close();
    }
  }
  assert.deepEqual(
    report.runtimes[1].observations,
    report.runtimes[0].observations,
  );
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  await postgresOwner?.close();
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    casesPerRuntime: report.runtimes.map((r) => r.observations.length),
    reportPath,
    completeReplacement: false,
  }),
);
