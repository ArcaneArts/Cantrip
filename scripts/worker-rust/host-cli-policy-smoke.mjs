import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { encryptPolicyContent } from "../../packages/crypto/dist/policy-content.js";

const markdown = "# Private CLI policy fixture\n\nProtected instructions 🔐\n";

export async function verifyHostCliPolicies({
  call,
  core,
  run,
  projectId,
  ownerId,
  checkout,
  componentKey,
}) {
  const create = async (key, mandatory, wrongBody) => {
    const id = randomUUID();
    const content = await encryptPolicyContent({
      ownerId,
      policyId: id,
      keyRevision: 1,
      componentKey,
      summary: {
        version: 1,
        key,
        name: `Private fixture ${key}`,
        summary: `Effective policy fixture for ${key} 🔐`,
      },
      body: { version: 1, bodyMarkdown: markdown },
    });
    if (wrongBody) content.protectedBody = wrongBody;
    const result = await call("POST", "/api/policies", {
      id,
      enabled: true,
      mandatory,
      content,
    });
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.deepEqual(result.body.content, content);
    return { id, content };
  };
  const mandatory = await create("mandatory-fixture", true);
  const direct = await create("project-fixture", false);
  const unassigned = await create("unassigned-fixture", false);
  const foreignBody = await create(
    "wrong-body-fixture",
    false,
    direct.content.protectedBody,
  );

  const policies = await call("GET", "/api/policies");
  assert.equal(policies.status, 200, JSON.stringify(policies));
  const assigned = await call("PATCH", `/api/projects/${projectId}/policies`, {
    collectionVersion: policies.body.collectionVersion,
    policyIds: [direct.id, mandatory.id, foreignBody.id],
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned));

  const wireList = await core("policy.list", {});
  assert.equal(wireList.status, 200, JSON.stringify(wireList));
  assert.equal(wireList.body.data.policies.length, 3);
  assert.ok(
    !wireList.body.data.policies.some(({ id }) => id === unassigned.id),
  );
  assert.ok(!JSON.stringify(wireList.body).includes("project-fixture"));
  assert.ok(!JSON.stringify(wireList.body).includes(markdown));
  const wireDetail = await core("policy.read", { policyId: direct.id });
  assert.equal(wireDetail.status, 200, JSON.stringify(wireDetail));
  assert.deepEqual(wireDetail.body.data.policy.content, direct.content);

  const { openPolicyCliList, openPolicyCliDetail } =
    await import("../../tests/reference-node-worker/src/policy-encryption.ts");
  const service = {
    ownerId: () => ownerId,
    componentKey: () => ({
      key: Uint8Array.from(componentKey),
      keyRevision: 1,
    }),
  };

  await run(
    [
      "set -e",
      "cantrip --json policy list > .cantrip-fixture-policy-list",
      "cantrip --json policy read project-fixture > .cantrip-fixture-policy-read",
      "if cantrip policy read unassigned-fixture 2> .cantrip-fixture-policy-missing; then exit 97; fi",
      "if cantrip policy read wrong-body-fixture 2> .cantrip-fixture-policy-corrupt; then exit 98; fi",
    ].join("\n"),
  );
  const file = (kind) =>
    readFile(path.join(checkout, `.cantrip-fixture-policy-${kind}`), "utf8");
  const listed = JSON.parse(await file("list"));
  assert.equal(listed.summary, "Found 3 effective policies.");
  assert.equal(listed.worktreeId, wireList.body.worktreeId);
  assert.deepEqual(
    listed.data,
    await openPolicyCliList({ policies: wireList.body.data, service }),
  );
  assert.deepEqual(
    listed.data.policies
      .find(({ key }) => key === "mandatory-fixture")
      .sources.map(({ type }) => type)
      .sort(),
    ["mandatory", "project"],
  );
  const read = JSON.parse(await file("read"));
  assert.equal(read.summary, "Read policy project-fixture.");
  assert.equal(read.worktreeId, wireDetail.body.worktreeId);
  assert.deepEqual(
    read.data,
    await openPolicyCliDetail({ policy: wireDetail.body.data.policy, service }),
  );
  assert.equal(read.data.policy.bodyMarkdown, markdown);
  assert.match(
    await file("missing"),
    /Policy unassigned-fixture is not effective.*HTTP 404/u,
  );
  const corrupt = await file("corrupt");
  assert.match(corrupt, /HTTP 502/u);
  assert.ok(!corrupt.includes("Protected instructions"));
}
