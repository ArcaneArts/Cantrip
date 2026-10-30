import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-replica-completion-"));
const owner = "00000000-0000-0000-0000-000000000001",
  job = "22222222-2222-4222-8222-222222222222";
const pair = [],
  report = {
    root,
    databaseMode,
    completeReplacement: false,
    cases: [],
    snapshots: [],
  };
const aliases = [new Map(), new Map()];
const normalize = (v, i, key = "") => {
  if (Array.isArray(v)) return v.map((x) => normalize(x, i));
  if (v && typeof v === "object") {
    // These requests name source IDs generated independently by each runtime.
    // Verify each digest against its exact request before comparing the aliases.
    if (v.payload_fingerprint && ["synchronize", "remove"].includes(v.kind)) {
      const input =
        v.kind === "synchronize"
          ? {
              repository: "opaque-name",
              expectedRevision: "a".repeat(40),
              policy: "verify-only",
              idempotencyKey: "sync",
            }
          : {
              repository: "opaque-name",
              deleteLocalFiles: false,
              idempotencyKey: "remove",
            };
      const expected = createHash("sha256")
        .update(
          JSON.stringify({
            kind: v.kind,
            projectId: "project",
            projectReplicaId: v.project_replica_id,
            ...input,
          }),
        )
        .digest("hex");
      assert.equal(
        v.payload_fingerprint,
        expected,
        "exact runtime request fingerprint",
      );
      v = { ...v, payload_fingerprint: `<verified-${v.kind}-fingerprint>` };
    }
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x, i, k)]),
    );
  }
  if (typeof v !== "string") return v;
  if (/(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(v)), key);
    return "<timestamp>";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    ) &&
    ![owner, job].includes(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `generated-${aliases[i].size}`);
    return aliases[i].get(v);
  }
  return v;
};
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
let pg, failure;
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
const observe = async (label, operation, rejected = false) => {
  const outcomes = [];
  for (let i = 0; i < 2; i++)
    outcomes.push(
      await pair[i].request(
        typeof operation === "function" ? operation(i) : operation,
      ),
    );
  report.cases.push({ label, outcomes });
  for (const r of outcomes)
    assert.equal(r.rejected, rejected, `${label}: ${r.diagnostic}`);
  const view = (r, i) =>
    rejected
      ? { diagnostic: r.diagnostic, replicaError: r.replicaError }
      : { value: normalize(r.value, i) };
  assert.deepEqual(view(outcomes[1], 1), view(outcomes[0], 0), label);
  return outcomes.map((r) => r.value);
};
const snapshot = async (label) => {
  const results = await observe(label, {
    op: "query-json",
    sql: "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY idempotency_key) FROM project_replica_jobs j),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY worker_id) FROM project_sources s),'worktrees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id) FROM project_worktrees w)) AS result",
  });
  for (const result of results) {
    for (const row of result.jobs ?? []) {
      if (row.state === "running") {
        assert.equal(
          Date.parse(row.lease_expires_at) - Date.parse(row.updated_at),
          120000,
          "running lease lasts exactly two minutes",
        );
        assert.equal(
          Date.parse(row.progress.updatedAt),
          Date.parse(row.updated_at),
          "progress timestamp matches durable update",
        );
        assert.ok(
          row.cancellation_unsafe_at,
          "dispatched attempt cannot be cancelled",
        );
      }
    }
  }
  report.snapshots.push({ label, results });
  return results;
};
try {
  const executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"])
    pair.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode,
        databaseUrl:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
      }),
    );
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('alpha',${literal(owner)},'Replica worker','linux','x64',now(),now())`,
  );
  await seed(
    `INSERT INTO projects(id,owner_id,protected_label,setup_status,github_repository_blind_index) VALUES('project',${literal(owner)},${literal(JSON.stringify(projectLabel))}::jsonb,'cloning','opaque-repository')`,
  );

  await seed(
    "UPDATE projects SET github_repository_full_name='opaque-name',preferred_worker_id='alpha' WHERE id='project'",
  );
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('beta',${literal(owner)},'Other replica worker','linux','x64',now(),now())`,
  );
  const revision = "a".repeat(40);
  const rows = await observe("create first source job", {
    op: "replica-provision",
    owner,
    project: "project",
    input: {
      workerId: "alpha",
      repository: "opaque-name",
      expectedRevision: null,
      idempotencyKey: "first",
    },
  });
  const claims = await observe("claim first source", { op: "replica-claim" });
  const ready = (i) => ({
    jobId: rows[i].id,
    attempt: 1,
    status: "ready",
    path: "opaque-path",
    displayPath: "opaque-display",
    repositoryFingerprint: "opaque-fingerprint",
    resolvedRevision: revision,
    branch: "main",
    reused: false,
  });
  const finish =
    (changes = {}, command) =>
    (i) => ({
      op: "replica-complete-provision",
      job: rows[i].id,
      command: command ?? claims[i].commandId,
      result: { ...ready(i), ...changes },
    });
  const stable = async (label, operation) => {
    const before = await snapshot("before " + label);
    await observe(label, operation, true);
    assert.deepEqual(
      await snapshot("after " + label),
      before,
      label + " exact rollback",
    );
  };
  await stable("wrong command", finish({}, "stale"));
  await stable("wrong attempt", finish({ attempt: 2 }));
  await stable("wrong job", finish({ jobId: "different" }));
  await stable(
    "wrong placement",
    finish({
      placement: {
        mode: "direct",
        materialization: "cloned",
        ownership: "cantrip",
        canonicalPath: "opaque-path",
        requestedPath: "opaque-path",
        linkPath: null,
      },
    }),
  );
  const completed = await observe("provision completion", finish());
  for (const item of completed) assert.equal(item.state, "succeeded");
  await snapshot("source and primary durable");
  await stable("repeated completion fenced", finish());
  await observe("create second source", {
    op: "replica-provision",
    owner,
    project: "project",
    input: {
      workerId: "beta",
      repository: "opaque-name",
      expectedRevision: null,
      idempotencyKey: "second",
    },
  });
  const second = await observe("claim second source", { op: "replica-claim" });
  await observe("second source completion", (i) => ({
    op: "replica-complete-provision",
    job: second[i].job.id,
    command: second[i].commandId,
    result: {
      ...ready(i),
      jobId: second[i].job.id,
      path: "opaque-beta",
      displayPath: "opaque-beta",
      branch: null,
      reused: true,
      worktreePolicy: "direct",
    },
  }));
  const replicas = completed.map((x) => x.projectReplicaId);
  await observe("synchronize source", (i) => ({
    op: "replica-synchronize",
    owner,
    project: "project",
    replica: replicas[i],
    input: {
      repository: "opaque-name",
      expectedRevision: revision,
      policy: "verify-only",
      idempotencyKey: "sync",
    },
  }));
  const sync = await observe("claim sync", { op: "replica-claim" });
  const synchronized =
    (extra = {}) =>
    (i) => ({
      op: "replica-complete-synchronize",
      job: sync[i].job.id,
      command: sync[i].commandId,
      result: {
        jobId: sync[i].job.id,
        attempt: 1,
        status: "ready",
        path: "opaque-updated",
        branch: null,
        resolvedRevision: revision,
        ...extra,
      },
    });
  await stable(
    "mismatched sync revision",
    synchronized({ resolvedRevision: "b".repeat(40) }),
  );
  await observe("sync completion", synchronized());
  await snapshot("sync source and primary update");
  await observe("remove source", (i) => ({
    op: "replica-remove",
    owner,
    project: "project",
    replica: replicas[i],
    input: {
      repository: "opaque-name",
      deleteLocalFiles: false,
      idempotencyKey: "remove",
    },
  }));
  const remove = await observe("claim removal", { op: "replica-claim" });
  const removed =
    (extra = {}) =>
    (i) => ({
      op: "replica-complete-remove",
      job: remove[i].job.id,
      command: remove[i].commandId,
      result: {
        jobId: remove[i].job.id,
        attempt: 1,
        status: "removed",
        path: "opaque-updated",
        localFilesDeleted: false,
        ...extra,
      },
    });
  await stable(
    "deletion result mismatch",
    removed({ localFilesDeleted: true }),
  );
  await stable("removed path mismatch", removed({ path: "wrong-path" }));
  await observe("remove completion", removed());
  const final = await snapshot("retired source and preferred replacement");
  for (const data of final) {
    assert.equal(data.projects[0].preferred_worker_id, "beta");
    assert.ok(data.sources.find((x) => x.worker_id === "alpha").removed_at);
    assert.equal(
      data.worktrees.find((x) => x.worker_id === "alpha").lifecycle_state,
      "missing",
    );
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  const results = await Promise.allSettled(pair.map((r) => r.close()));
  report.cleanupFailures = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason.stack);
  if (report.cleanupFailures.length)
    failure ??= new Error(report.cleanupFailures.join("\n"));
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.databaseCleanupFailure = error.stack;
  }
  const target = option("--report");
  if (target) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ databaseMode, cases: report.cases.length }));
