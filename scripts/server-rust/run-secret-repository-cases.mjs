import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { runConfigurationSecretSetRequestSchema } from "../../packages/protocol/dist/run-configuration-secrets.js";
export async function runSecretCases({ pair, seed, report, owner, other }) {
  const project = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await seed(
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) SELECT '${project}',owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id,'run-secret-fixture' FROM projects WHERE id='github'`,
  );
  const protectedValue =
    fileDocumentWireFixtures().fileDocumentCreateSchema[0].stateProtection
      .protectedState;
  let sequence = 0;
  const operationId = () =>
    `ffffffff-ffff-4fff-8fff-${String(++sequence).padStart(12, "0")}`;
  const first = {
    operationId: operationId(),
    reference: "run/api",
    protectedValue,
  };
  const began = Date.now();
  const original = [];
  async function run(label, request, error) {
    const results = [];
    for (const repo of pair)
      results.push(await repo.request({ owner, project, ...request }));
    report.cases.push({
      label,
      request,
      expected: results[0],
      actual: results[1],
    });
    for (const value of results) {
      assert.equal(value.rejected, !!error, label);
      if (error) assert.equal(value.diagnostic, error, label);
    }
    if (error) return;
    const normalized = results.map(({ value }) => {
      const copy = structuredClone(value);
      for (const row of Array.isArray(copy)
        ? copy
        : copy.secret
          ? [copy.secret]
          : []) {
        assert.ok(
          Date.parse(row.updatedAt) >= began &&
            Date.parse(row.updatedAt) <= Date.now(),
          label + " operation clock",
        );
        row.updatedAt = "verified-operation-clock";
      }
      return copy;
    });
    assert.deepEqual(normalized[1], normalized[0], label);
    return results.map((r) => r.value);
  }
  assert.deepEqual(
    (await run("secret list initially empty", { op: "run-secret-list" }))[0],
    [],
  );
  original.push(
    ...(await run("secret initial write", {
      op: "run-secret-set",
      input: first,
    })),
  );
  assert.equal(original[0].secret.revision, 1);
  assert.equal(original[0].replayed, false);
  const second = await run(
    "secret same envelope new operation increments revision",
    { op: "run-secret-set", input: { ...first, operationId: operationId() } },
  );
  assert.equal(second[0].secret.revision, 2);
  const replay = await run(
    "secret old receipt retains revision and timestamp",
    { op: "run-secret-set", input: first },
  );
  replay.forEach((value, index) => {
    assert.equal(value.replayed, true);
    assert.deepEqual(value.secret, original[index].secret);
  });
  await run(
    "secret conflicting reference",
    { op: "run-secret-set", input: { ...first, reference: "run/other" } },
    "The Run configuration secret operation identity is already in use.",
  );
  await run(
    "secret foreign receipt",
    { op: "run-secret-set", owner: other, input: first },
    "The Run configuration secret operation identity is already in use.",
  );
  assert.deepEqual(
    (
      await run("secret foreign list", { op: "run-secret-list", owner: other })
    )[0],
    [],
  );
  const listed = await run("secret current owned summary", {
    op: "run-secret-list",
  });
  assert.equal(listed[0][0].revision, 2);
  const concurrent = {
    ...first,
    reference: "run/concurrent",
    operationId: operationId(),
  };
  for (const repo of pair) {
    const response = await repo.request({
      op: "run-secret-race",
      owner,
      project,
      inputs: [concurrent, concurrent],
    });
    report.cases.push({
      label: "concurrent identical secret receipts",
      response,
    });
    assert.equal(response.rejected, false);
    assert.equal(response.value.length, 2);
    assert.deepEqual(response.value.map((value) => value.replayed).sort(), [
      false,
      true,
    ]);
    assert.deepEqual(response.value[0].secret, response.value[1].secret);
    assert.equal(response.value[0].secret.revision, 1);
    assert.ok(
      Date.parse(response.value[0].secret.updatedAt) >= began &&
        Date.parse(response.value[0].secret.updatedAt) <= Date.now(),
    );
    const stored = await repo.request({
      op: "query-json",
      sql: `SELECT jsonb_build_object('revision',(SELECT revision FROM run_configuration_secrets WHERE project_id='${project}' AND reference='run/concurrent'),'receipts',(SELECT count(*) FROM run_configuration_secret_operations WHERE id='${concurrent.operationId}')) result`,
    });
    assert.equal(stored.rejected, false);
    assert.deepEqual(stored.value, { revision: 1, receipts: 1 });
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        runConfigurationSecretSetRequestSchema.parse(first).protectedValue,
      ),
    )
    .digest("hex");
  for (const repo of pair) {
    const stored = await repo.request({
      op: "query-json",
      sql: `SELECT jsonb_build_object('digest',(SELECT protected_value_digest FROM run_configuration_secret_operations WHERE id='${first.operationId}'),'value',(SELECT protected_value FROM run_configuration_secrets WHERE project_id='${project}' AND reference='run/api')) result`,
    });
    assert.equal(stored.rejected, false);
    assert.deepEqual(stored.value, { digest, value: protectedValue });
  }
}
