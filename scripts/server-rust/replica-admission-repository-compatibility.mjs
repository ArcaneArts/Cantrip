import { replicaBlockerCases } from "./replica-blocker-cases.mjs";
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-replica-admission-"));
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
    sql: "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY idempotency_key) FROM project_replica_jobs j),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p)) AS result",
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
    "UPDATE projects SET github_repository_full_name='opaque-name' WHERE id='project'",
  );
  const clear = () => seed("DELETE FROM project_replica_jobs");
  const input = {
    workerId: "alpha",
    repository: "opaque-name",
    expectedRevision: null,
    idempotencyKey: "provision",
  };
  const provision = (changes = {}, project = "project", account = owner) => ({
    op: "replica-provision",
    owner: account,
    project,
    input: { ...input, ...changes },
  });
  await observe("missing project", provision({}, "missing"), true);
  await observe("foreign project", provision({}, "project", "foreign"), true);
  await observe("missing worker", provision({ workerId: "missing" }), true);
  await observe(
    "missing protected repository",
    provision({ repository: null }),
    true,
  );
  // The reference checks idempotency before its transaction. A racing caller
  // may see either a uniqueness conflict (then replay) or an already-active job.
  // Record both outcomes; validate exact errors and the single durable result.
  const races = [];
  for (let i = 0; i < pair.length; i++) {
    const result = await pair[i].request({
      ...provision(),
      op: "replica-provision-race",
    });
    assert.equal(result.rejected, false, result.diagnostic);
    report.cases.push({
      label: `concurrent same-key admission ${i}`,
      outcomes: [result],
    });
    const successes = result.value.filter((v) => v.ok).map((v) => v.ok);
    assert.ok(
      successes.length >= 1,
      "at least one concurrent admission succeeds",
    );
    for (const success of successes) assert.deepEqual(success, successes[0]);
    for (const item of result.value.filter((v) => !v.ok))
      assert.deepEqual(item, {
        error: "A replica provision job is already active for this worker.",
        kind: "ProjectReplicaJobConflictError",
      });
    normalize(successes[0], i);
    races.push(successes[0]);
  }
  const raced = await snapshot("single durable job after concurrent admission");
  for (let i = 0; i < raced.length; i++) {
    assert.equal(raced[i].jobs.length, 1);
    assert.equal(raced[i].jobs[0].id, races[i].id);
  }
  assert.deepEqual(
    await observe("retry after admission race", provision()),
    races,
  );
  await clear();
  const first = await observe("provision admission", provision());
  const replay = await observe("exact provision replay", provision());
  assert.deepEqual(replay, first);
  await snapshot("persisted fingerprint");
  await observe(
    "different repository conflicts",
    provision({ repository: "other" }),
    true,
  );
  await observe(
    "different idempotency conflicts active",
    provision({ idempotencyKey: "second" }),
    true,
  );
  await seed("UPDATE workers SET unlinked_at=now() WHERE id='alpha'");
  assert.deepEqual(
    await observe("replay before target lookup", provision()),
    first,
  );
  await observe(
    "new job on unlinked worker",
    provision({ idempotencyKey: "new" }),
    true,
  );
  await seed("UPDATE workers SET unlinked_at=NULL WHERE id='alpha'");
  await clear();
  for (const mode of ["managed-link", "direct"]) {
    const placement = { mode, path: "ctrr_" + "a".repeat(43) };
    await observe(`${mode} unsupported`, provision({ placement }), true);
    await seed(
      `UPDATE workers SET project_replica_capabilities='{"managedLinkPlacement":true,"directPlacement":true,"attachExisting":true,"recursiveParentCreation":true}' WHERE id='alpha'`,
    );
    await observe(`${mode} admitted`, provision({ placement }));
    await snapshot(`${mode} placement persists`);
    await clear();
    await seed(
      "UPDATE workers SET project_replica_capabilities='{}' WHERE id='alpha'",
    );
  }
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('beta',${literal(owner)},'Other replica worker','linux','x64',now(),now())`,
  );
  await seed(
    "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('source','project','alpha','opaque-path','opaque-display')",
  );
  await observe("existing source prevents provision", provision(), true);
  const sync = {
    repository: "opaque-name",
    expectedRevision: "a".repeat(40),
    policy: "verify-only",
    idempotencyKey: "synchronize",
  };
  const remove = {
    repository: "opaque-name",
    deleteLocalFiles: false,
    idempotencyKey: "remove",
  };
  const operation = (
    kind,
    changes = {},
    replica = "source",
    account = owner,
  ) => ({
    op: "replica-" + kind,
    owner: account,
    project: "project",
    replica,
    input: { ...(kind === "remove" ? remove : sync), ...changes },
  });
  await observe(
    "missing source",
    operation("synchronize", {}, "missing"),
    true,
  );
  await observe(
    "foreign source",
    operation("synchronize", {}, "source", "foreign"),
    true,
  );
  await observe("last source cannot be removed", operation("remove"), true);
  await seed(
    "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('second','project','beta','opaque-second','opaque-second')",
  );
  for (const kind of ["synchronize", "remove"]) {
    const admitted = await observe(`${kind} admission`, operation(kind));
    assert.deepEqual(
      await observe(`${kind} replay`, operation(kind)),
      admitted,
    );
    await snapshot(`${kind} exact payload fingerprint`);
    await observe(
      `${kind} altered identity`,
      operation(kind, { repository: "other" }),
      true,
    );
    await observe(
      `${kind} active operation`,
      operation(kind, { idempotencyKey: "another" }),
      true,
    );
    if (kind === "remove")
      await observe(
        "another source removal serializes project",
        operation("remove", { idempotencyKey: "other-source" }, "second"),
        true,
      );
    await clear();
  }

  await observe("repair context", {
    op: "replica-repair-context",
    owner,
    project: "project",
    replica: "source",
  });
  await observe("repair foreign context", {
    op: "replica-repair-context",
    owner: "foreign",
    project: "project",
    replica: "source",
  });
  await observe("missing primary removal blocker", {
    op: "replica-removal-blocker",
    replica: "source",
    job: "none",
  });
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('primary','source','alpha','Primary','opaque-path','opaque-display',true,'cantrip','ready')",
  );
  assert.equal(
    (
      await observe("unused source removable", {
        op: "replica-removal-blocker",
        replica: "source",
        job: "none",
      })
    )[0],
    null,
  );
  await replicaBlockerCases({
    seed,
    observe,
    owner,
    label: literal(JSON.stringify(projectLabel)),
  });
  const contextJob = await observe(
    "context job admission",
    operation("synchronize"),
  );
  const contextClaims = await observe("context job claim", {
    op: "replica-claim",
  });
  await observe("running operation context", (i) => ({
    op: "replica-context",
    job: contextJob[i].id,
    command: contextClaims[i].commandId,
  }));
  await observe("stale operation context", (i) => ({
    op: "replica-context",
    job: contextJob[i].id,
    command: "stale",
  }));
  assert.equal(
    (
      await observe("other job blocks removal", {
        op: "replica-removal-blocker",
        replica: "source",
        job: "none",
      })
    )[0],
    "Another replica job is still active.",
  );
  assert.equal(
    (
      await observe("current job excluded from blockers", (i) => ({
        op: "replica-removal-blocker",
        replica: "source",
        job: contextJob[i].id,
      }))
    )[0],
    null,
  );
  for (const name of ["initial", "idempotent"])
    assert.equal(
      (
        await observe(`${name} mark removing`, {
          op: "replica-removal-start",
          replica: "source",
        })
      )[0],
      true,
    );
  await observe("restore removal", {
    op: "replica-removal-restore",
    replica: "source",
  });
  await observe("restored actual worktree", {
    op: "query-json",
    sql: "SELECT to_jsonb(w) AS result FROM project_worktrees w WHERE id='primary'",
  });
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='missing' WHERE id='primary'",
  );
  assert.equal(
    (
      await observe("missing cannot start removal", {
        op: "replica-removal-start",
        replica: "source",
      })
    )[0],
    false,
  );
  await clear();
  await seed("DELETE FROM project_worktrees");
  await seed(
    "UPDATE project_sources SET ownership_kind='user' WHERE id='source'",
  );
  await observe(
    "user checkout deletion forbidden",
    operation("remove", { deleteLocalFiles: true }),
    true,
  );
  await observe("user checkout detach accepted", operation("remove"));
  await clear();
  await seed(
    "UPDATE projects SET origin_kind='managed-folder',folder_management='external',worktree_policy='direct',github_repository_blind_index=NULL,github_repository_full_name=NULL,github_repository_id=NULL,github_repository_url=NULL WHERE id='project'",
  );
  await observe(
    "local synchronization forbidden",
    operation("synchronize", { repository: null }),
    true,
  );
  await observe(
    "local delete forbidden",
    operation("remove", { repository: null, deleteLocalFiles: true }),
    true,
  );
  await observe(
    "local protected identity forbidden",
    operation("remove"),
    true,
  );
  await observe(
    "local detach accepted",
    operation("remove", { repository: null }),
  );
  await clear();
  await seed("DELETE FROM project_sources");
  const direct = { mode: "direct", path: "ctrr_" + "b".repeat(43) };
  await observe(
    "local managed placement forbidden",
    provision({ repository: null }),
    true,
  );
  await observe(
    "local direct needs revision",
    provision({ repository: null, placement: direct }),
    true,
  );
  await seed(
    `UPDATE workers SET project_replica_capabilities='{"directPlacement":true,"attachExisting":true,"recursiveParentCreation":false}' WHERE id='alpha'`,
  );
  await observe(
    "local direct accepts existing without parent creation",
    provision({
      repository: null,
      placement: direct,
      expectedRevision: "a".repeat(40),
    }),
  );
  await snapshot("local direct admission");
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
