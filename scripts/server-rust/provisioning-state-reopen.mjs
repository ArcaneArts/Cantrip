import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import {
  encryptedProjectReplicaSynchronizeCreateSchema,
  encryptedProjectReplicaRemoveCreateSchema,
} from "../../packages/protocol/dist/index.js";

const stateSql = `SELECT jsonb_build_object(
  'projects',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM projects p),
  'folderJobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY project_id),'[]'::jsonb) FROM project_folder_setup_jobs j),
  'replicaJobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY project_id,kind,worker_id,idempotency_key),'[]'::jsonb) FROM project_replica_jobs j)
) result`;

// Read the actual stopped HTTP server's store twice, retaining every column.
// The HTTP suites independently verify public state transitions and worker effects.
export async function provisioningStateReopen({
  fixture,
  root,
  profile,
  startedAt,
  admissions = [],
}) {
  const executable =
    process.env.CANTRIP_RUST_PROJECT_REPOSITORY_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const read = async () => {
    const database = await repositoryFixture({
      kind: fixture.kind,
      executable,
      root: path.join(root, profile),
      databaseMode: fixture.databaseMode,
      databaseUrl: fixture.environment.DATABASE_URL,
    });
    try {
      const result = await database.request({
        op: "query-json",
        sql: stateSql,
      });
      assert.equal(result.rejected, false, result.diagnostic);
      return result.value;
    } finally {
      await database.close();
    }
  };
  const raw = await read();
  const reopened = await read();
  assert.deepEqual(
    reopened,
    raw,
    "complete raw project/job state survives reopen",
  );
  assert.ok(raw.projects.length > 0);
  const projects = new Map(
    raw.projects.map((project) => [project.id, project]),
  );
  for (const job of [...raw.folderJobs, ...raw.replicaJobs]) {
    const project = projects.get(job.project_id);
    assert.ok(project, "persisted job references its actual project");
    assert.equal(job.owner_id, project.owner_id);
    assert.ok(Number.isInteger(job.attempt) && job.attempt > 0);
    assert.ok(Number.isInteger(job.state_revision) && job.state_revision > 0);
    assert.ok(
      !["running", "queued"].includes(job.state),
      "final scenario has no unsettled job",
    );
  }
  function clocks(value, key = "") {
    if (Array.isArray(value)) return value.map((v) => clocks(v, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, clocks(v, k)]),
      );
    if (
      typeof value === "string" &&
      key.endsWith("_at") &&
      /^\d{4}-/.test(value)
    ) {
      const clock = Date.parse(value);
      assert.ok(
        Number.isFinite(clock) &&
          clock >= startedAt - 1000 &&
          clock <= Date.now() + 1000,
        key,
      );
      return "<validated project write clock>";
    }
    return value;
  }
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const canonical = clocks(fixture.normalize(raw));
  const fingerprintProofs = [];
  for (const [index, job] of raw.replicaJobs.entries()) {
    if (job.kind === "provision") continue;
    const admission = admissions.find((value) => value.jobId === job.id);
    assert.ok(
      admission,
      "every stored replica operation matches an actual accepted HTTP request",
    );
    assert.equal(admission.projectId, job.project_id);
    assert.equal(admission.replicaId, job.project_replica_id);
    assert.equal(admission.kind, job.kind);
    const input = (
      job.kind === "remove"
        ? encryptedProjectReplicaRemoveCreateSchema
        : encryptedProjectReplicaSynchronizeCreateSchema
    ).parse(admission.input);
    assert.equal(input.idempotencyKey, job.idempotency_key);
    const payload = {
      kind: job.kind,
      projectId: admission.projectId,
      projectReplicaId: admission.replicaId,
      ...input,
    };
    assert.equal(
      job.payload_fingerprint,
      hash(payload),
      "stored fingerprint authenticates the exact admitted protocol input",
    );
    const normalizedPayload = fixture.normalize(payload);
    const normalizedSha256 = hash(normalizedPayload);
    canonical.replicaJobs[index].payload_fingerprint = normalizedSha256;
    fingerprintProofs.push({
      jobId: job.id,
      payload,
      actualSha256: job.payload_fingerprint,
      normalizedPayload,
      normalizedSha256,
    });
  }
  return {
    raw,
    reopened,
    canonical,
    fingerprintProofs,
    rawReopenEqual: true,
  };
}
