// Actual source/native repositories, SQL transitions and retained state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
import { managedFolderMaterializeReadySchema } from "../../packages/protocol/dist/index.js";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-folder-repository-"));
const owner = "00000000-0000-0000-0000-000000000001",
  other = "11111111-1111-4111-8111-111111111111";
const ids = Array.from(
  { length: 10 },
  (_, i) => `22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`,
);
const fixed = new Set([owner, other, ...ids]);
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const report = {
  suite: "actual-folder-setup-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let pg, executable, failure;
const literal = (v) =>
  v === null ? "NULL" : "'" + String(v).replaceAll("'", "''") + "'";
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const normalize = (value, i, key = "") => {
  if (Array.isArray(value)) return value.map((v) => normalize(v, i));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, i, k)]),
    );
  if (typeof value !== "string") return value;
  if (/(?:At|_at)$/.test(key)) {
    assert.ok(
      Number.isFinite(Date.parse(value)),
      "valid actual stored/DTO timestamp",
    );
    return "<timestamp>";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) &&
    !fixed.has(value)
  ) {
    if (!aliases[i].has(value))
      aliases[i].set(value, "<generated:" + aliases[i].size + ">");
    return aliases[i].get(value);
  }
  return value;
};
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
const observe = async (label, operation, error = null) => {
  const outcomes = [];
  for (let i = 0; i < pair.length; i++)
    outcomes.push(
      await pair[i].request(
        typeof operation === "function" ? operation(i) : operation,
      ),
    );
  report.cases.push({
    label,
    operation:
      typeof operation === "function" ? "runtime identities" : operation,
    outcomes,
  });
  for (const r of outcomes)
    assert.equal(
      r.rejected,
      error !== null,
      label + ": actual intended outcome",
    );
  const view = (r, i) =>
    r.rejected
      ? {
          rejected: true,
          ...(error !== "generic"
            ? { kind: r.folderError, message: r.diagnostic }
            : {}),
        }
      : { rejected: false, value: normalize(r.value, i) };
  if (error && error !== "generic")
    assert.equal(
      outcomes[0].folderError,
      error,
      label + ": actual source error type",
    );
  assert.deepEqual(view(outcomes[1], 1), view(outcomes[0], 0), label);
  return outcomes.map((r) => r.value);
};
const snapshot = async (label) => {
  const sql = `SELECT jsonb_build_object(
 'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM project_workspaces t),
 'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY workspace_id),'[]') FROM project_workspace_storage_profiles t),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id),'[]') FROM project_workspace_memberships t),
 'projects',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM projects t),
 'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id),'[]') FROM project_folder_setup_jobs t),
 'sources',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id,id),'[]') FROM project_sources t),
 'worktrees',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY s.project_id,w.name,w.id),'[]') FROM project_worktrees w JOIN project_sources s ON s.id=w.project_source_id)
 ) AS result`;
  const values = [];
  for (const repo of pair) {
    const r = await repo.request({ op: "query-json", sql });
    assert.equal(r.rejected, false, r.diagnostic);
    values.push(r.value);
  }
  report.snapshots.push({ label, values });
  assert.deepEqual(normalize(values[1], 1), normalize(values[0], 0), label);
  return values;
};
const stable = async (label, operation, error) => {
  const before = await snapshot("before " + label);
  await observe(label, operation, error);
  const after = await snapshot("after " + label);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      after[i],
      before[i],
      label + ": exact rollback in runtime " + i,
    );
};
const create = async (index, extra = {}) =>
  observe("create " + index, {
    op: "folder-create",
    owner,
    input: {
      id: ids[index],
      workerId: "alpha",
      nameProtection: projectLabel,
      ...extra,
    },
  });
const claim = () => observe("claim available job", { op: "folder-claim" });
const completion = (claims, i, extra = {}) =>
  managedFolderMaterializeReadySchema.parse({
    status: "ready",
    jobId: claims[i].job.id,
    attempt: claims[i].job.attempt,
    path: handle(10 + claims[i].job.attempt),
    displayPath: handle(20 + claims[i].job.attempt),
    reused: false,
    ...extra,
  });
const apply =
  (op, claims, extra = {}) =>
  (i) => ({
    op,
    job: claims[i].job.id,
    command: claims[i].commandId,
    ...(typeof extra === "function" ? extra(i) : extra),
  });
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  await seed(
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES(${literal(other)},'account','Other','member','active','folder-other@example.invalid','folder-other@example.invalid')`,
  );
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('alpha',${literal(owner)},'Folder worker','linux','x64',now(),now()),('foreign',${literal(other)},'Foreign worker','linux','x64',now(),now())`,
  );
  await observe("empty job", { op: "folder-get", owner, project: ids[0] });
  await observe("empty queue", { op: "folder-claim" });
  await observe("default workspace bootstrap", { op: "folder-default", owner });
  await snapshot("bootstrap state");
  await observe("idempotent workspace bootstrap", {
    op: "folder-default",
    owner,
  });
  await snapshot("retained default and storage");
  await stable(
    "missing requested workspace",
    {
      op: "folder-create",
      owner,
      input: {
        id: ids[0],
        workerId: "alpha",
        nameProtection: projectLabel,
        workspaceId: "missing",
      },
    },
    "ProjectWorkspaceInvariantError",
  );
  await stable(
    "foreign worker",
    {
      op: "folder-create",
      owner,
      input: { id: ids[0], workerId: "foreign", nameProtection: projectLabel },
    },
    "ProjectWorkspaceInvariantError",
  );
  const created = await create(0);
  await snapshot("queued creation transaction");
  await observe("owned status", { op: "folder-get", owner, project: ids[0] });
  await observe("foreign status hidden", {
    op: "folder-get",
    owner: other,
    project: ids[0],
  });
  await observe("system workspace context", {
    op: "folder-storage",
    owner,
    project: ids[0],
  });
  await stable(
    "duplicate project",
    {
      op: "folder-create",
      owner,
      input: { id: ids[0], workerId: "alpha", nameProtection: projectLabel },
    },
    "generic",
  );
  let claims = await claim();
  assert.ok(claims[0]);
  await snapshot("claimed attempt");
  await observe(
    "wrong attempt cannot renew",
    apply("folder-renew", claims, { attempt: 999 }),
  );
  await observe(
    "current attempt renews",
    apply("folder-renew", claims, (i) => ({ attempt: claims[i].job.attempt })),
  );
  const leased = await snapshot("renewed lease");
  for (const r of leased)
    assert.equal(
      Date.parse(r.jobs[0].lease_expires_at) - Date.parse(r.jobs[0].updated_at),
      120000,
    );
  await stable(
    "stale completion token",
    (i) => ({
      op: "folder-complete",
      job: claims[i].job.id,
      command: "stale",
      input: completion(claims, i),
    }),
    "ProjectFolderSetupJobStaleAttemptError",
  );
  await stable(
    "stale completion attempt",
    apply("folder-complete", claims, (i) => ({
      input: completion(claims, i, { attempt: 999 }),
    })),
    "ProjectFolderSetupJobStaleAttemptError",
  );
  await observe(
    "block offline",
    apply("folder-settle", claims, {
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
    }),
  );
  await snapshot("blocked job and preparing project");
  await observe("foreign worker cannot resume", {
    op: "folder-requeue",
    worker: "foreign",
  });
  await observe("matching worker resumes", {
    op: "folder-requeue",
    worker: "alpha",
  });
  claims = await claim();
  await observe(
    "permanent failure",
    apply("folder-settle", claims, {
      state: "failed",
      error: { code: "materialization-failed", retryable: false },
    }),
  );
  await snapshot("failed job and project");
  await observe("worker reconnect cannot retry permanent failure", {
    op: "folder-requeue",
    worker: "alpha",
  });
  await observe("stale retry version", {
    op: "folder-retry",
    owner,
    project: ids[0],
    revision: 1,
  });
  const status = await observe("failed status", {
    op: "folder-get",
    owner,
    project: ids[0],
  });
  await observe("foreign retry denied", {
    op: "folder-retry",
    owner: other,
    project: ids[0],
    revision: status[0].stateRevision,
  });
  await observe("explicit retry", (i) => ({
    op: "folder-retry",
    owner,
    project: ids[0],
    revision: status[i].stateRevision,
  }));
  claims = await claim();
  await seed(
    "CREATE FUNCTION folder_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.setup_status='ready' THEN RAISE EXCEPTION 'folder fixture abort'; END IF; RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER folder_abort BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION folder_abort()",
  );
  await stable(
    "later project update rolls back source and worktree inserts",
    apply("folder-complete", claims, (i) => ({ input: completion(claims, i) })),
    "generic",
  );
  await seed("DROP TRIGGER folder_abort ON projects");
  await seed("DROP FUNCTION folder_abort()");
  await observe(
    "complete managed folder",
    apply("folder-complete", claims, (i) => ({ input: completion(claims, i) })),
  );
  await snapshot("ready project, source and primary root");
  await stable(
    "duplicate completion fenced",
    apply("folder-complete", claims, (i) => ({ input: completion(claims, i) })),
    "ProjectFolderSetupJobStaleAttemptError",
  );
  await observe("completed job cannot retry", {
    op: "folder-retry",
    owner,
    project: ids[0],
    revision: 999,
  });
  await create(1, { existingPath: handle(2) });
  claims = await claim();
  await observe(
    "complete existing Git folder",
    apply("folder-complete", claims, (i) => ({
      input: completion(claims, i, {
        path: handle(42),
        displayPath: handle(43),
        repositoryFingerprint: "a".repeat(64),
      }),
    })),
  );
  await snapshot("existing Git source capabilities and external root");
  await create(2);
  claims = await claim();
  await seed(
    `UPDATE project_folder_setup_jobs SET lease_expires_at='2100-01-01T00:00:00.000Z' WHERE project_id=${literal(ids[2])}`,
  );
  assert.deepEqual(
    await observe("unexpired lease is retained", {
      op: "folder-recover",
      force: false,
      at: "2099-12-31T23:59:59.999Z",
    }),
    [0, 0],
  );
  assert.deepEqual(
    await observe("lease expires at inclusive boundary", {
      op: "folder-recover",
      force: false,
      at: "2100-01-01T00:00:00.000Z",
    }),
    [1, 1],
  );
  await snapshot("expired lease requeued");
  assert.deepEqual(
    await observe("future availability is not claimed", { op: "folder-claim" }),
    [null, null],
  );
  await seed(
    `UPDATE project_folder_setup_jobs SET available_at='2000-01-01' WHERE project_id=${literal(ids[2])}`,
  );
  const firstStarted = claims.map((c) => c.job.startedAt);
  claims = await claim();
  for (let i = 0; i < 2; i++)
    assert.equal(claims[i].job.startedAt, firstStarted[i]);
  await observe("forced restart recovers active lease", {
    op: "folder-recover",
    force: true,
    at: "2026-10-25T00:00:00.000Z",
  });
  claims = await claim();
  await observe(
    "final recovery block",
    apply("folder-settle", claims, {
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
    }),
  );
  await snapshot("restartable blocked state");
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await snapshot("reopened durable graph");
  await observe("reopened successful status", {
    op: "folder-get",
    owner,
    project: ids[0],
  });
  await observe("reopened blocked status", {
    op: "folder-get",
    owner,
    project: ids[2],
  });
  await observe(
    "default bootstrap commits before rejected project creation",
    {
      op: "folder-create",
      owner: other,
      input: {
        id: ids[3],
        workerId: "foreign",
        nameProtection: projectLabel,
        workspaceId: "missing",
      },
    },
    "ProjectWorkspaceInvariantError",
  );
  const canonical = "workspace:default:" + other;
  let graph = await snapshot(
    "failed creation retains only default workspace bootstrap",
  );
  for (const state of graph) {
    assert.equal(
      state.workspaces.find((workspace) => workspace.id === canonical)
        .is_default,
      true,
    );
    assert.equal(
      state.profiles.find((profile) => profile.workspace_id === canonical).kind,
      "system",
    );
    assert.equal(
      state.projects.some((project) => project.id === ids[3]),
      false,
    );
  }
  await seed(
    `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision,position) VALUES(${literal(ids[4])},${literal(other)},${literal(JSON.stringify(projectLabel.protectedLabel.envelope))}::jsonb,'fixture-protected-workspace',1,1,2)`,
  );
  await observe("missing custom workspace storage gets legacy profile", {
    op: "folder-default",
    owner: other,
  });
  graph = await snapshot("custom legacy storage backfill");
  for (const state of graph)
    assert.equal(
      state.profiles.find((profile) => profile.workspace_id === ids[4]).kind,
      "legacy",
    );
  for (const index of [5, 6])
    await seed(
      `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision,position) VALUES(${literal(ids[index])},${literal(other)},${literal(JSON.stringify(projectLabel.protectedLabel.envelope))}::jsonb,${literal("protected-workspace-" + index)},1,1,${index})`,
    );
  await seed(
    `INSERT INTO project_workspace_storage_profiles(workspace_id,kind) VALUES(${literal(ids[5])},'managed')`,
  );
  await seed(
    `INSERT INTO project_workspace_storage_profiles(workspace_id,kind,worker_id,protected_root_path_handle,protected_display_handle) VALUES(${literal(ids[6])},'attached','foreign',${literal(handle(50))},${literal(handle(51))})`,
  );
  await seed(
    `UPDATE project_workspaces SET is_default=false WHERE id=${literal(canonical)}`,
  );
  await seed(
    `UPDATE project_workspaces SET is_default=true WHERE id=${literal(ids[5])}`,
  );
  const defaults = await observe("managed custom default is retained", {
    op: "folder-default",
    owner: other,
  });
  for (const workspace of defaults) assert.equal(workspace.id, ids[5]);
  await snapshot("managed default is not replaced");
  await observe("folder creation selects owned managed default", {
    op: "folder-create",
    owner: other,
    input: { id: ids[3], workerId: "foreign", nameProtection: projectLabel },
  });
  const managed = await observe("managed workspace context", {
    op: "folder-storage",
    owner: other,
    project: ids[3],
  });
  for (const context of managed)
    assert.deepEqual(context, { kind: "managed", workspaceId: ids[5] });
  graph = await snapshot("managed project membership");
  for (const state of graph)
    assert.equal(
      state.memberships.find((membership) => membership.project_id === ids[3])
        .workspace_id,
      ids[5],
    );
  await seed(
    `UPDATE project_workspaces SET is_default=false WHERE id=${literal(ids[5])}`,
  );
  await seed(
    `UPDATE project_workspaces SET is_default=true WHERE id=${literal(ids[6])}`,
  );
  const repaired = await observe(
    "attached default restores canonical workspace",
    { op: "folder-default", owner: other },
  );
  for (const workspace of repaired) assert.equal(workspace.id, canonical);
  graph = await snapshot("attached default revisions repaired atomically");
  for (const state of graph) {
    const original = state.workspaces.find(
      (workspace) => workspace.id === ids[6],
    );
    const restored = state.workspaces.find(
      (workspace) => workspace.id === canonical,
    );
    assert.equal(original.is_default, false);
    assert.equal(original.revision, 2);
    assert.equal(restored.is_default, true);
    assert.equal(restored.revision, 2);
  }
  await observe("folder creation selects explicit attached workspace", {
    op: "folder-create",
    owner: other,
    input: {
      id: ids[7],
      workspaceId: ids[6],
      workerId: "foreign",
      nameProtection: projectLabel,
    },
  });
  const attached = await observe("attached workspace context", {
    op: "folder-storage",
    owner: other,
    project: ids[7],
  });
  for (const context of attached)
    assert.deepEqual(context, {
      kind: "attached",
      workspaceId: ids[6],
      workerId: "foreign",
    });
  assert.deepEqual(
    await observe("foreign workspace storage is hidden", {
      op: "folder-storage",
      owner,
      project: ids[3],
    }),
    [null, null],
  );
  await observe("folder creation selects explicit legacy workspace", {
    op: "folder-create",
    owner: other,
    input: {
      id: ids[8],
      workspaceId: ids[4],
      workerId: "foreign",
      nameProtection: projectLabel,
    },
  });
  const legacy = await observe("legacy workspace context", {
    op: "folder-storage",
    owner: other,
    project: ids[8],
  });
  for (const context of legacy) assert.deepEqual(context, { kind: "legacy" });
  await snapshot("all workspace storage contexts retained");
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await snapshot("reopened workspace repair graph");
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const repo of pair) await repo.close();
  await pg?.close();
  await rm(root, { recursive: true, force: true });
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
    cases: report.cases.length,
    snapshots: report.snapshots.length,
  }),
);
