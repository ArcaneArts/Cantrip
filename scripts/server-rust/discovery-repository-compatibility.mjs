// Actual Node/Rust repositories on disposable databases, including raw SQL state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";
import { projectLabel } from "./security-fixtures.mjs";
import { discoveryImportCases } from "./discovery-import-repository-cases.mjs";
import { discoveryWorkspaceCases } from "./discovery-workspace-repository-cases.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-discovery-repository-"),
);
const report = {
  suite: "workspace-discovery-repository-in-progress",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const owner = "00000000-0000-0000-0000-000000000001",
  workspace = "88888888-8888-4888-8888-000000000001";
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const aliases = [new Map(), new Map()],
  pair = [];
const normalize = (value, index, key = "") => {
  if (Array.isArray(value)) return value.map((v) => normalize(v, index));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, index, k)]),
    );
  if (typeof value !== "string") return value;
  if (/(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(value)), key);
    return "<timestamp>";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    ) &&
    !/^([1-9])\1{7}-/.test(value)
  ) {
    if (!aliases[index].has(value))
      aliases[index].set(value, "generated-" + aliases[index].size);
    return aliases[index].get(value);
  }
  return value;
};
const errors = new Set([
  "ProjectWorkspaceInvariantError",
  "WorkspaceRepositoryDiscoveryInvariantError",
  "WorkspaceRepositoryDiscoveryStaleAttemptError",
  "WorkspaceRepositoryImportStaleAttemptError",
]);
const observe = async (label, request, rejected = false) => {
  const results = [];
  for (let i = 0; i < pair.length; i++)
    results.push(
      await pair[i].request(
        typeof request === "function" ? request(i) : request,
      ),
    );
  report.cases.push({ label, results });
  for (const result of results)
    assert.equal(
      result.rejected,
      Boolean(rejected),
      label + ": " + result.diagnostic,
    );
  // Rust has no JS error constructors. Compare domain identities and exact
  // serialized validation messages, retaining every original diagnostic.
  const comparable = (r, i) =>
    rejected
      ? typeof rejected === "string"
        ? { databaseCode: r.databaseCode }
        : {
            diagnostic: r.diagnostic,
            errorType: errors.has(r.discoveryError)
              ? r.discoveryError
              : undefined,
          }
      : { value: normalize(r.value, i) };
  assert.deepEqual(comparable(results[1], 1), comparable(results[0], 0), label);
  if (typeof rejected === "string")
    for (const result of results)
      assert.equal(result.databaseCode, rejected, label);
  return results.map((r) => r.value);
};
const seed = async (statement) => {
  for (const f of pair) await f.seed(statement);
};
const snapshot = async (label) => {
  const rows = await observe(label, {
    op: "query-json",
    sql: "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY workspace_id) FROM workspace_repository_discovery_jobs j),'candidates',(SELECT jsonb_agg(to_jsonb(c) ORDER BY repository_fingerprint) FROM workspace_repository_candidates c),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY project_id,worker_id,created_at) FROM project_sources s),'trees',(SELECT jsonb_agg(to_jsonb(t) ORDER BY s.project_id,t.name) FROM project_worktrees t INNER JOIN project_sources s ON s.id=t.project_source_id),'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id) FROM project_workspace_memberships m),'workspaces',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_workspaces w),'storage',(SELECT jsonb_agg(to_jsonb(s) ORDER BY workspace_id) FROM project_workspace_storage_profiles s)) AS result",
  });
  for (const value of rows)
    for (const job of value.jobs ?? [])
      if (job.state === "running")
        assert.equal(
          Date.parse(job.lease_expires_at) - Date.parse(job.updated_at),
          120000,
        );
  report.snapshots.push({ label, rows });
  return rows;
};
const unchanged = async (label, operation, rejected = true) => {
  const before = await snapshot(label + " before");
  await observe(label, operation, rejected);
  const after = await snapshot(label + " after");
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      normalize(after[i], i),
      normalize(before[i], i),
      label + " rollback",
    );
};
const queue = (input = {}, id = workspace, account = owner) => ({
  op: "discovery-queue",
  owner: account,
  workspace: id,
  input,
});
const status = (account = owner) => ({
  op: "discovery-snapshot",
  owner: account,
  workspace,
});
const counts = (candidates) => ({
  candidates,
  collapsedRepositories: 0,
  rejectedRepositories: 0,
  scannedDirectories: 2,
  scannedEntries: 3,
  skippedSymlinks: 0,
  unreadableDirectories: 0,
});
let pg, failure;
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
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('alpha',${literal(owner)},'Discovery worker','linux','x64',now(),now())`,
  );
  await seed(
    `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision) VALUES(${literal(workspace)},${literal(owner)},${json(projectLabel.protectedLabel.envelope)},${literal(Buffer.alloc(32).toString("base64url"))},1,1),('portable',${literal(owner)},${json(projectLabel.protectedLabel.envelope)},${literal(Buffer.alloc(32, 1).toString("base64url"))},1,1)`,
  );
  await seed(
    `INSERT INTO project_workspace_storage_profiles(workspace_id,kind,worker_id,protected_root_path_handle,protected_display_handle) VALUES(${literal(workspace)},'attached','alpha',${literal(handle(1))},${literal(handle(2))}),('portable','managed',NULL,NULL,NULL)`,
  );
  await discoveryWorkspaceCases({
    observe,
    seed,
    snapshot,
    unchanged,
    owner,
    workspace,
    handle,
    projectLabel,
  });
  await observe("no snapshot before scan", status());
  for (const depth of [-2, 17, 1.5, "1", true])
    await observe("invalid depth " + depth, queue({ depth }), true);
  await observe("missing workspace", queue({}, "missing"), true);
  await observe("foreign workspace", queue({}, workspace, "foreign"), true);
  await observe("portable storage", queue({}, "portable"), true);
  await observe(
    "revision cannot create a missing job",
    queue({ expectedStateRevision: 1 }),
  );
  const queued = await observe("queue initial scan", queue());
  assert.equal(queued[0].stateRevision, 1);
  assert.equal(queued[0].depth, -1);
  assert.equal(queued[0].attempt, 0);
  await observe("stale queued revision", queue({ expectedStateRevision: 2 }));
  await observe(
    "requeue queued scan",
    queue({ expectedStateRevision: 1, depth: 4 }),
  );
  let claimed = await observe("claim scan", { op: "discovery-claim" });
  assert.equal(claimed[0].job.stateRevision, 3);
  assert.equal(claimed[0].job.attempt, 1);
  assert.equal(claimed[0].rootPathHandle, handle(1));
  await observe("no second running claim", { op: "discovery-claim" });
  await observe("running scan cannot be queued", queue());
  await observe("foreign snapshot is absent", status("foreign"));
  await observe("renew wrong command", (i) => ({
    op: "discovery-renew",
    job: claimed[i].job.id,
    command: "wrong",
    attempt: 1,
  }));
  await observe("renew wrong attempt", (i) => ({
    op: "discovery-renew",
    job: claimed[i].job.id,
    command: claimed[i].commandId,
    attempt: 2,
  }));
  await observe("renew current lease", (i) => ({
    op: "discovery-renew",
    job: claimed[i].job.id,
    command: claimed[i].commandId,
    attempt: 1,
  }));
  await snapshot("renewed scan state");
  await unchanged("stale block", (i) => ({
    op: "discovery-block",
    job: claimed[i].job.id,
    command: "wrong",
    error: { code: "worker-offline", retryable: true },
  }));
  await observe("block current scan", (i) => ({
    op: "discovery-block",
    job: claimed[i].job.id,
    command: claimed[i].commandId,
    error: { code: "worker-offline", retryable: true },
  }));
  await observe("other worker does not resume", {
    op: "discovery-requeue",
    worker: "other",
  });
  await observe("connected worker resumes", {
    op: "discovery-requeue",
    worker: "alpha",
  });
  claimed = await observe("claim resumed scan", { op: "discovery-claim" });
  const candidates = [
    {
      pathHandle: handle(3),
      displayHandle: handle(4),
      repositoryFingerprint: "a".repeat(64),
      classification: "local-git",
    },
    {
      pathHandle: handle(5),
      displayHandle: handle(6),
      repositoryFingerprint: "b".repeat(64),
      classification: "unsupported",
      diagnosticCode: " \ufeffbare-repository\ufeff ",
    },
  ];
  const completion =
    (changes = {}) =>
    (i) => ({
      op: "discovery-complete",
      job: claimed[i].job.id,
      command: claimed[i].commandId,
      input: {
        attempt: claimed[i].job.attempt,
        candidates,
        counts: counts(2),
        truncated: false,
        ...changes,
      },
    });
  await unchanged(
    "mismatched candidate count",
    completion({ counts: counts(1) }),
  );
  await unchanged(
    "duplicate fingerprints",
    completion({ candidates: [candidates[0], candidates[0]] }),
  );
  await unchanged(
    "invalid fingerprint",
    completion({
      candidates: [
        { ...candidates[0], repositoryFingerprint: "X".repeat(64) },
        candidates[1],
      ],
    }),
  );
  await unchanged(
    "invalid classification metadata",
    completion({
      candidates: [
        { ...candidates[0], classification: "github-accessible" },
        candidates[1],
      ],
    }),
  );
  await unchanged("stale completion attempt", completion({ attempt: 99 }));
  const completed = await observe("complete scan", completion());
  assert.equal(completed[0].candidates.length, 2);
  assert.equal(completed[0].candidates[1].diagnosticCode, "bare-repository");
  await observe("get complete snapshot", status());
  await snapshot("complete scan durable state");
  await observe(
    "queue rescan",
    queue({ expectedStateRevision: completed[0].job.stateRevision }),
  );
  claimed = await observe("claim rescan", { op: "discovery-claim" });
  const rescanned = await observe(
    "upsert retained candidate and remove stale pending",
    completion({
      candidates: [{ ...candidates[0], pathHandle: handle(7) }],
      counts: counts(1),
      truncated: true,
    }),
  );
  assert.equal(rescanned[0].candidates.length, 1);
  assert.equal(rescanned[0].candidates[0].id, completed[0].candidates[0].id);
  assert.equal(rescanned[0].job.diagnosticCode, "scan-truncated");
  await snapshot("rescan state");
  await observe("queue recovery scan", queue());
  claimed = await observe("claim recovery scan", { op: "discovery-claim" });
  await observe("unexpired lease is retained", {
    op: "discovery-recover",
    force: false,
    now: new Date().toISOString(),
  });
  await observe("force startup recovery", {
    op: "discovery-recover",
    force: true,
    now: new Date().toISOString(),
  });
  claimed = await observe("claim recovered scan", { op: "discovery-claim" });
  await observe("fail recovered scan", (i) => ({
    op: "discovery-fail",
    job: claimed[i].job.id,
    command: claimed[i].commandId,
    error: { code: "root-unavailable", retryable: false },
  }));
  await observe("nonretryable failure not resumed", {
    op: "discovery-requeue",
    worker: "alpha",
  });
  await observe("failed scan snapshot", status());
  await snapshot("final scan state");
  await discoveryImportCases({
    observe,
    seed,
    snapshot,
    unchanged,
    owner,
    workspace,
    handle,
    counts,
    projectLabel,
    queue,
    status,
  });
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  await Promise.allSettled(pair.map((f) => f.close()));
  await pg?.close();
  if (option("--report")) {
    await mkdir(path.dirname(path.resolve(option("--report"))), {
      recursive: true,
    });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: report.passed,
  }),
);
