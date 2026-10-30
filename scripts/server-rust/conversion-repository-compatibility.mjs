// Execute the actual repositories on isolated data; compare state and rollback.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-conversion-repository-"),
);
const report = {
    root,
    databaseMode,
    completeReplacement: false,
    cases: [],
    snapshots: [],
  },
  pair = [];
const owner = "00000000-0000-0000-0000-000000000001",
  foreign = "11111111-1111-4111-8111-111111111111";
const folder = "33333333-3333-4333-8333-000000000001",
  local = "33333333-3333-4333-8333-000000000002",
  other = "33333333-3333-4333-8333-000000000003";
const source = "44444444-4444-4444-8444-000000000001",
  external = "44444444-4444-4444-8444-000000000002";
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
    ![owner, foreign, folder, local, other, source, external].includes(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `generated-${aliases[i].size}`);
    return aliases[i].get(v);
  }
  return v;
};
const seed = async (statement) => {
  for (const repo of pair) await repo.seed(statement);
};
const observe = async (label, request, rejected = false) => {
  const outcomes = [];
  for (let i = 0; i < pair.length; i++)
    outcomes.push(
      await pair[i].request(
        typeof request === "function" ? request(i) : request,
      ),
    );
  report.cases.push({ label, outcomes });
  for (const outcome of outcomes)
    assert.equal(outcome.rejected, rejected, `${label}: ${outcome.diagnostic}`);
  const comparable = (outcome, i) =>
    rejected
      ? {
          diagnostic: outcome.diagnostic,
          conversionError: outcome.conversionError,
        }
      : { value: normalize(outcome.value, i) };
  assert.deepEqual(
    comparable(outcomes[1], 1),
    comparable(outcomes[0], 0),
    label,
  );
  return outcomes.map((r) => r.value);
};
const snapshot = async (label) => {
  const values = await observe(label, {
    op: "query-json",
    sql: `SELECT jsonb_build_object('projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM project_sources s),'trees',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM project_worktrees t),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM project_github_conversion_jobs j)) AS result`,
  });
  for (const value of values)
    for (const row of value.jobs ?? [])
      if (row.state === "running")
        assert.equal(
          Date.parse(row.lease_expires_at) - Date.parse(row.updated_at),
          120000,
        );
  report.snapshots.push({ label, values });
  return values;
};
const input = {
  repository: {
    repositoryId: "repo-id",
    nameWithOwner: "Owner/Repo",
    url: "https://github.invalid/Owner/Repo",
  },
  repositoryBlindIndex: "blind-conversion",
  confirmationToken: "a".repeat(64),
  initialCommit: { message: "opaque-initial-message" },
};
const create = (
  changes = {},
  project = folder,
  account = owner,
  worker = "alpha",
  projectSource = source,
) => ({
  op: "conversion-create",
  owner: account,
  project,
  worker,
  source: projectSource,
  input: { ...input, ...changes },
});
const get = (project = folder, account = owner) => ({
  op: "conversion-get",
  owner: account,
  project,
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
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('alpha',${literal(owner)},'Conversion worker','linux','x64',now(),now()),('beta',${literal(owner)},'Other worker','linux','x64',now(),now())`,
  );
  for (const [id, management, git, s, kind, ownership, rootKind] of [
    [folder, "managed", false, source, "folder", "cantrip", "folder-root"],
    [local, "external", true, external, "git", "user", "git-worktree"],
  ]) {
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,setup_status,worktree_policy) VALUES(${literal(id)},${literal(owner)},${json(projectLabel)},'managed-folder',${literal(management)},${git},false,'ready','direct')`,
    );
    await seed(
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,ownership_kind,absolute_path,display_path) VALUES(${literal(s)},${literal(id)},'alpha',${literal(kind)},${literal(ownership)},${literal("/private/" + id)},'Original display')`,
    );
    await seed(
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,root_kind) VALUES(${literal(s + "-main")},${literal(s)},'alpha','Primary',${literal("/private/" + id)},'Original display',true,true,'cantrip','ready',${literal(rootKind)})`,
    );
  }
  await seed(
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,github_repository_blind_index,setup_status) VALUES(${literal(other)},${literal(owner)},${json(projectLabel)},'github',NULL,'other-blind','ready')`,
  );
  await observe("missing latest", get());
  await observe("no active conversion", {
    op: "conversion-active",
    project: folder,
  });
  await observe("no converted source", {
    op: "conversion-source",
    owner,
    project: folder,
  });
  await observe("not converted source", {
    op: "conversion-is-source",
    owner,
    project: folder,
    source,
  });
  await observe("missing project", create({}, "missing"), true);
  await observe("foreign project", create({}, folder, foreign), true);
  for (const [label, statement] of [
    ["not ready", "setup_status='failed'"],
    [
      "already GitHub",
      "origin_kind='github',folder_management=NULL,github_repository_blind_index='wrong-origin'",
    ],
  ]) {
    await seed(`UPDATE projects SET ${statement} WHERE id=${literal(folder)}`);
    await observe(label, create(), true);
    await seed(
      `UPDATE projects SET setup_status='ready',origin_kind='managed-folder',folder_management='managed',github_repository_blind_index=NULL WHERE id=${literal(folder)}`,
    );
  }
  await observe(
    "missing source",
    create({}, folder, owner, "alpha", "missing"),
    true,
  );
  await observe("wrong source worker", create({}, folder, owner, "beta"), true);
  await seed(
    `UPDATE project_sources SET ownership_kind='user' WHERE id=${literal(source)}`,
  );
  await observe("user folder source ineligible", create(), true);
  await seed(
    `UPDATE project_sources SET ownership_kind='cantrip' WHERE id=${literal(source)}`,
  );
  await seed(
    `UPDATE project_worktrees SET lifecycle_state='missing' WHERE project_source_id=${literal(source)}`,
  );
  await observe("missing ready Primary", create(), true);
  await seed(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE project_source_id=${literal(source)}`,
  );
  await seed(
    `UPDATE projects SET github_repository_blind_index='blind-conversion' WHERE id=${literal(other)}`,
  );
  await observe("existing repository collision", create(), true);
  await seed(
    `UPDATE projects SET github_repository_blind_index='other-blind' WHERE id=${literal(other)}`,
  );
  const admitted = await observe("admit managed folder", create());
  for (const j of admitted) {
    assert.equal(j.state, "queued");
    assert.equal(j.attempt, 0);
    assert.equal(j.stateRevision, 1);
    assert.equal(j.initialCommitRequested, true);
  }
  await observe("latest retained", get());
  await observe("foreign latest", get(folder, foreign));
  await observe("active conversion", {
    op: "conversion-active",
    project: folder,
  });
  await observe("active project rejects second admission", create(), true);
  const claimed = await observe("claim attempt one", {
    op: "conversion-claim",
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(claimed[i].job.id, admitted[i].id);
    assert.equal(claimed[i].job.attempt, 1);
    assert.equal(claimed[i].job.stateRevision, 2);
    assert.equal(claimed[i].confirmationToken, input.confirmationToken);
    assert.deepEqual(claimed[i].initialCommit, input.initialCommit);
  }
  await observe("nothing else dispatchable", { op: "conversion-claim" });
  const operation =
    (op, extra = {}) =>
    (i) => ({
      op,
      job: claimed[i].job.id,
      command: claimed[i].commandId,
      ...extra,
    });
  await observe(
    "renew wrong command",
    operation("conversion-renew", { command: "wrong", attempt: 1 }),
  );
  await observe(
    "renew wrong attempt",
    operation("conversion-renew", { attempt: 2 }),
  );
  await observe(
    "renew current lease",
    operation("conversion-renew", { attempt: 1 }),
  );
  await snapshot("renewed two-minute lease");
  await observe(
    "stale block rejected",
    operation("conversion-block", {
      command: "wrong",
      error: { code: "worker-offline", retryable: true },
    }),
    true,
  );
  let blocked = await observe(
    "retryable block",
    operation("conversion-block", {
      error: { code: "worker-offline", retryable: true },
    }),
  );
  await observe("foreign retry", {
    op: "conversion-retry",
    owner: foreign,
    project: folder,
    revision: 3,
  });
  await observe("stale revision retry", {
    op: "conversion-retry",
    owner,
    project: folder,
    revision: 2,
  });
  await observe("retry current block", {
    op: "conversion-retry",
    owner,
    project: folder,
    revision: 3,
  });
  let next = await observe("claim second attempt", { op: "conversion-claim" });
  for (const c of next) {
    assert.equal(c.job.attempt, 2);
    assert.equal(c.job.stateRevision, 5);
  }
  await observe("unexpired lease retained", {
    op: "conversion-recover",
    force: false,
    now: new Date().toISOString(),
  });
  await observe("force startup recovery", {
    op: "conversion-recover",
    force: true,
    now: new Date().toISOString(),
  });
  next = await observe("claim after startup recovery", {
    op: "conversion-claim",
  });
  for (const c of next) assert.equal(c.job.attempt, 3);
  await seed(
    "UPDATE project_github_conversion_jobs SET lease_expires_at=NULL WHERE state='running'",
  );
  await observe("null lease recovered", {
    op: "conversion-recover",
    force: false,
    now: new Date().toISOString(),
  });
  next = await observe("claim recovered null lease", {
    op: "conversion-claim",
  });
  await seed(
    "UPDATE project_github_conversion_jobs SET lease_expires_at=now()-interval '1 second' WHERE state='running'",
  );
  await observe("expired lease recovered", {
    op: "conversion-recover",
    force: false,
    now: new Date().toISOString(),
  });
  next = await observe("claim recovered expiry", { op: "conversion-claim" });
  for (const c of next) assert.equal(c.job.attempt, 5);
  await observe(
    "old command is fenced",
    operation("conversion-fail", {
      error: { code: "push-failed", retryable: false },
    }),
    true,
  );
  blocked = await observe("nonretryable block", (i) => ({
    op: "conversion-block",
    job: next[i].job.id,
    command: next[i].commandId,
    error: { code: "preflight-changed", retryable: false },
  }));
  await observe("nonretryable block cannot retry", {
    op: "conversion-retry",
    owner,
    project: folder,
    revision: blocked[0].stateRevision,
  });
  await observe("worker reconnect leaves nonretryable block", {
    op: "conversion-requeue",
    worker: "alpha",
  });
  await seed("UPDATE project_github_conversion_jobs SET error_retryable=true");
  await observe("other worker cannot resume", {
    op: "conversion-requeue",
    worker: "beta",
  });
  await observe("owner worker resumes retryable block", {
    op: "conversion-requeue",
    worker: "alpha",
  });
  next = await observe("claim reconnect recovery", { op: "conversion-claim" });
  await observe("terminal failure", (i) => ({
    op: "conversion-fail",
    job: next[i].job.id,
    command: next[i].commandId,
    error: { code: "push-failed", retryable: true },
  }));
  await observe("failed job cannot retry", {
    op: "conversion-retry",
    owner,
    project: folder,
    revision: next[0].job.stateRevision + 1,
  });
  await observe("failed job no longer active", {
    op: "conversion-active",
    project: folder,
  });
  await snapshot("terminal failure retained without catalog conversion");
  await seed("DELETE FROM project_github_conversion_jobs");
  for (const [project, s, management] of [
    [folder, source, "managed"],
    [local, external, "external"],
  ]) {
    await observe(
      management + " admit",
      create({ initialCommit: null }, project, owner, "alpha", s),
    );
    const claim = await observe(management + " claim", {
      op: "conversion-claim",
    });
    const result = (i) => ({
      status: "ready",
      jobId: claim[i].job.id,
      attempt: claim[i].job.attempt,
      repository: { ...input.repository, nameWithOwner: "owner/repo" },
      path: "/private/" + project,
      displayPath: "Converted display",
      repositoryFingerprint: "f".repeat(64),
      branch: "main",
      head: "b".repeat(40),
      worktreePolicy: "agent-managed",
    });
    const complete = (changes) => (i) => ({
      op: "conversion-complete",
      job: claim[i].job.id,
      command: claim[i].commandId,
      result: { ...result(i), ...changes },
    });
    for (const [label, changes] of [
      ["wrong job", { jobId: "22222222-2222-4222-8222-222222222222" }],
      ["wrong attempt", { attempt: 2 }],
      [
        "wrong repository",
        { repository: { ...input.repository, repositoryId: "different" } },
      ],
      ["wrong path", { path: "/changed/path" }],
    ]) {
      const before = await snapshot(management + " before " + label);
      await observe(management + " " + label, complete(changes), true);
      assert.deepEqual(
        await snapshot(management + " after " + label),
        before,
        "conflicted completion rolls back every field",
      );
    }
    const driftCases = [
      [
        "source ownership changes",
        `UPDATE project_sources SET ownership_kind=${literal(management === "managed" ? "user" : "cantrip")} WHERE id=${literal(s)}`,
        `UPDATE project_sources SET ownership_kind=${literal(management === "managed" ? "cantrip" : "user")} WHERE id=${literal(s)}`,
      ],
      [
        "Primary kind changes",
        `UPDATE project_worktrees SET root_kind=${literal(management === "managed" ? "git-worktree" : "folder-root")} WHERE project_source_id=${literal(s)}`,
        `UPDATE project_worktrees SET root_kind=${literal(management === "managed" ? "folder-root" : "git-worktree")} WHERE project_source_id=${literal(s)}`,
      ],
      [
        "source path changes",
        `UPDATE project_sources SET absolute_path='/changed/source' WHERE id=${literal(s)}`,
        `UPDATE project_sources SET absolute_path=${literal("/private/" + project)} WHERE id=${literal(s)}`,
      ],
      [
        "Primary disappears",
        `UPDATE project_worktrees SET lifecycle_state='missing' WHERE project_source_id=${literal(s)}`,
        `UPDATE project_worktrees SET lifecycle_state='ready' WHERE project_source_id=${literal(s)}`,
      ],
      [
        "repository becomes bound elsewhere",
        `UPDATE projects SET github_repository_blind_index='blind-conversion' WHERE id=${literal(other)}`,
        `UPDATE projects SET github_repository_blind_index='other-blind' WHERE id=${literal(other)}`,
      ],
    ];
    for (const [label, prepare, restore] of driftCases) {
      await seed(prepare);
      const before = await snapshot(management + " before " + label);
      await observe(management + " " + label, complete({}), true);
      assert.deepEqual(
        await snapshot(management + " after " + label),
        before,
        "completion preserves drifted catalog on conflict",
      );
      await seed(restore);
    }
    await seed(
      `ALTER TABLE project_github_conversion_jobs ADD CONSTRAINT conversion_test_rollback CHECK(state<>'succeeded' OR project_id<>${literal(project)})`,
    );
    const before = await snapshot(
      management + " before forced final-write failure",
    );
    const outcomes = [];
    for (let i = 0; i < 2; i++) {
      const rejected = await pair[i].request(complete({})(i));
      outcomes.push(rejected);
      assert.equal(rejected.rejected, true);
    }
    report.cases.push({
      label: management + " actual final-write constraint rejects",
      outcomes,
    });
    assert.deepEqual(
      await snapshot(management + " after forced final-write failure"),
      before,
      "source, Primary, project and job changes roll back together",
    );
    await seed(
      "ALTER TABLE project_github_conversion_jobs DROP CONSTRAINT conversion_test_rollback",
    );
    const done = await observe(management + " complete", complete({}));
    for (const j of done) {
      assert.equal(j.state, "succeeded");
      assert.equal(j.stateRevision, 3);
      assert.equal(j.initialCommitRequested, false);
    }
    await observe(management + " stale completion", complete({}), true);
    const state = await snapshot(management + " committed conversion");
    for (const v of state) {
      const p = v.projects.find((p) => p.id === project),
        tree = v.trees.find((t) => t.project_source_id === s),
        src = v.sources.find((x) => x.id === s);
      assert.equal(p.origin_kind, "github");
      assert.equal(p.folder_management, null);
      assert.equal(src.source_kind, "git");
      assert.equal(
        src.ownership_kind,
        management === "managed" ? "cantrip" : "user",
      );
      assert.equal(tree.root_kind, "git-worktree");
      assert.equal(tree.absolute_path, "/private/" + project);
      assert.equal(tree.head, "b".repeat(40));
      assert.equal(tree.detached, false);
    }
    await observe(management + " converted managed-source lookup", {
      op: "conversion-source",
      owner,
      project,
    });
    await observe(management + " is converted managed source", {
      op: "conversion-is-source",
      owner,
      project,
      source: s,
    });
    await seed(
      `UPDATE projects SET github_repository_blind_index='converted-'||id WHERE id=${literal(project)}`,
    );
  }
  await seed(
    `UPDATE project_github_conversion_jobs SET local_files_deleted_at=now() WHERE project_id=${literal(folder)}`,
  );
  await observe("converted folder deletion retained", {
    op: "conversion-source",
    owner,
    project: folder,
  });
  await seed(
    `UPDATE project_sources SET removed_at=now() WHERE id=${literal(source)}`,
  );
  await observe("retired source no longer selected", {
    op: "conversion-source",
    owner,
    project: folder,
  });
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  for (const repo of pair) await repo.close();
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
  }),
);
