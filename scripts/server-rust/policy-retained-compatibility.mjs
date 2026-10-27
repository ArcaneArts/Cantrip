// Sequential Node -> Rust -> Node operations on the same disposable external
// database. Proves policy writes survive a return to the unchanged Node code.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
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
const reportPath = option("--report"),
  root = await mkdtemp(path.join(tmpdir(), "cantrip-policy-retained-"));
const report = {
  suite: "policy-node-rust-node-retained-writes",
  databaseMode: "postgres",
  root,
  completeReplacement: false,
  steps: [],
  seededScopes: true,
};
let cluster, fixture, failure;
const owner = "policy-reversal-owner",
  policyId = policyCreate.id;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
try {
  const executable = await buildRustExample("policy-repository-fixture");
  cluster = await postgresFixture(path.join(root, "postgres"));
  const databaseUrl = await cluster.database();
  async function open(kind) {
    fixture = await repositoryFixture({
      kind,
      executable,
      root,
      databaseMode: "postgres",
      databaseUrl,
      nodeScript: "scripts/server-rust/policy-node-fixture.mjs",
    });
  }
  async function step(label, request) {
    const result = await fixture.request(request);
    report.steps.push({ label, request, result });
    assert.equal(result.rejected, false, result.diagnostic);
    return result.value;
  }
  await open("node");
  await fixture.seed(
    `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(owner)},'account','member','active','Fixture','reversal@example.invalid','reversal@example.invalid');`,
  );
  await fixture.seed(
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES('project',${literal(owner)},${literal(JSON.stringify({ classification: { recordKind: "project" }, protectedLabel: policyEnvelope }))},'managed-folder','external','direct');`,
  );
  await fixture.seed(
    `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision) VALUES('workspace',${literal(owner)},${literal(JSON.stringify(policyEnvelope.envelope))},'fixture',1,1);`,
  );
  await fixture.seed(
    "INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES('workspace','project');",
  );
  await step("Node bootstrap", {
    op: "bootstrap",
    owner,
    input: { expectedBootstrapVersion: 0, policies: [] },
  });
  const context = {
    ownerId: owner,
    policyId,
    keyRevision: 1,
    componentKey: new Uint8Array(32).fill(91),
  };
  const summary = {
      version: 1,
      key: "retained-policy",
      name: "Retained policy",
      summary: "Created by the existing client",
    },
    body = { version: 1, bodyMarkdown: "# Preserved through a Rust write" };
  const original = await encryptPolicyContent({ ...context, summary, body });
  await step("Node creates opaque policy", {
    op: "create",
    owner,
    input: {
      ...policyCreate,
      content: original,
      mandatory: true,
      audience: "both",
    },
  });
  await step("Node project assignment", {
    op: "replace",
    owner,
    scope: "project",
    input: { collectionVersion: 3, policyIds: [policyId] },
  });
  await fixture.close();
  fixture = undefined;
  await open("rust");
  const read = await step("Rust reads retained Node ciphertext", {
    op: "get",
    owner,
    policy: policyId,
  });
  assert.deepEqual(read.content, original);
  assert.equal(read.projectAssignmentCount, 1);
  const nextSummary = {
      ...summary,
      summary: "Updated through the native server",
    },
    nextBody = {
      version: 1,
      bodyMarkdown: "# Rust write retained when Node returns",
    };
  const changed = await encryptPolicyContent({
    ...context,
    summary: nextSummary,
    body: nextBody,
  });
  await step("Rust updates opaque policy", {
    op: "update",
    owner,
    policy: policyId,
    input: {
      rowVersion: 1,
      content: {
        protectedSummary: changed.protectedSummary,
        protectedBody: changed.protectedBody,
      },
    },
  });
  await step("Rust reorders retained collection", {
    op: "order",
    owner,
    input: { collectionVersion: 4, policyIds: [policyId] },
  });
  await step("Rust workspace assignment", {
    op: "replace",
    owner,
    workspace: true,
    scope: "workspace",
    input: { collectionVersion: 5, policyIds: [policyId] },
  });
  await fixture.close();
  fixture = undefined;
  await open("node");
  const returned = await step("Node reads Rust writes", {
    op: "get",
    owner,
    policy: policyId,
  });
  assert.equal(returned.rowVersion, 2);
  assert.equal(returned.workspaceAssignmentCount, 1);
  assert.equal(returned.projectAssignmentCount, 1);
  assert.equal(returned.content.keyBlindIndex, original.keyBlindIndex);
  assert.deepEqual(returned.content.protectedSummary, changed.protectedSummary);
  assert.deepEqual(returned.content.protectedBody, changed.protectedBody);
  assert.deepEqual(
    await decryptPolicySummaryContent({
      ...context,
      encrypted: returned.content.protectedSummary,
    }),
    nextSummary,
  );
  assert.deepEqual(
    await decryptPolicyBodyContent({
      ...context,
      encrypted: returned.content.protectedBody,
    }),
    nextBody,
  );
  const effective = await step("Node resolves retained sources", {
    op: "effective",
    owner,
    project: "project",
  });
  assert.deepEqual(effective.policies[0].sources, [
    { type: "mandatory" },
    { type: "workspace", workspaceId: "workspace" },
    { type: "project", projectId: "project" },
  ]);
  const list = await step("Node collection version", { op: "list", owner });
  assert.equal(list.collectionVersion, 6);
  const updated = await step("Node continues writing after Rust", {
    op: "update",
    owner,
    policy: policyId,
    input: { rowVersion: 2, enabled: false },
  });
  assert.equal(updated.rowVersion, 3);
  assert.deepEqual(updated.content, returned.content);
  report.clientDecryptionPassed = true;
  report.postWriteReversalPassed = true;
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  await fixture?.close();
  await cluster?.close();
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    steps: report.steps.length,
    reportPath,
    completeReplacement: false,
  }),
);
