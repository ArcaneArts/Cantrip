import assert from "node:assert/strict";
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-replica-lifecycle-"));
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
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x, i, k)]),
    );
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
    sql: "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM project_replica_jobs j),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p)) AS result",
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
  await observe("empty claim", { op: "replica-claim" });
  await observe("missing project list", {
    op: "replica-list",
    owner,
    project: "missing",
  });
  await observe("empty list", {
    op: "replica-list",
    owner,
    project: "project",
  });
  for (const kind of ["provision", "synchronize", "remove"]) {
    await seed("DELETE FROM project_replica_jobs");
    await seed(
      `INSERT INTO project_replica_jobs(id,owner_id,project_id,worker_id,kind,state,idempotency_key,payload_fingerprint,progress) VALUES(${literal(job)},${literal(owner)},'project','alpha',${literal(kind)},'queued','fixture','opaque-fingerprint','{"stage":"queued","percent":0,"updatedAt":"2026-10-25T00:00:00.000Z"}')`,
    );
    await observe(`${kind} foreign read`, {
      op: "replica-get",
      owner: "foreign",
      job,
    });
    const claims = await observe(`${kind} claim`, { op: "replica-claim" });
    const operation =
      (op, extra = {}) =>
      (i) => ({ op, job, command: claims[i].commandId, attempt: 1, ...extra });
    await observe(
      `${kind} stale renewal`,
      operation("replica-renew", { attempt: 2 }),
    );
    await observe(`${kind} renewal`, operation("replica-renew"));
    await observe(
      `${kind} progress`,
      operation("replica-progress", {
        update: { stage: "verifying", percent: 67 },
      }),
    );
    const before = await snapshot(`${kind} before stale completion`);
    await observe(
      `${kind} stale completion`,
      operation("replica-fail", {
        command: "stale",
        error: { code: "worker-error", retryable: true },
      }),
      true,
    );
    const after = await snapshot(`${kind} after stale completion`);
    assert.deepEqual(
      after,
      before,
      "stale completion preserves exact durable state",
    );
    const blocked = await observe(
      `${kind} block`,
      operation("replica-block", {
        error: { code: "worker-error", retryable: true },
      }),
    );
    const cancelled = await observe(`${kind} cancellation fence`, (i) => ({
      op: "replica-cancel",
      owner,
      job,
      revision: blocked[i].stateRevision,
    }));
    for (const result of cancelled)
      assert.equal(result === null, kind !== "provision");
    if (kind !== "provision") {
      await observe(`${kind} requeue`, {
        op: "replica-requeue",
        worker: "alpha",
      });
      const reclaimed = await observe(`${kind} reclaim`, {
        op: "replica-claim",
      });
      for (const value of reclaimed) assert.equal(value.job.attempt, 2);
      await observe(`${kind} live lease retained`, {
        op: "replica-recover",
        force: false,
        now: "2020-01-01T00:00:00.000Z",
      });
      await observe(`${kind} forced recovery`, {
        op: "replica-recover",
        force: true,
        now: "2026-10-25T00:00:00.000Z",
      });
      const third = await observe(`${kind} recovered claim`, {
        op: "replica-claim",
      });
      const failed = await observe(`${kind} fail`, (i) => ({
        op: "replica-fail",
        job,
        command: third[i].commandId,
        error: { code: "worker-error", retryable: false },
      }));
      await observe(`${kind} stale retry`, (i) => ({
        op: "replica-retry",
        owner,
        job,
        revision: failed[i].stateRevision - 1,
      }));
      await observe(`${kind} retry`, (i) => ({
        op: "replica-retry",
        owner,
        job,
        revision: failed[i].stateRevision,
      }));
    }
    await snapshot(`${kind} final state`);
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
