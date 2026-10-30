// Actual source/native repositories, SQL state and explicit presence callbacks.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-placement-"));
const owner = "00000000-0000-0000-0000-000000000001",
  other = "11111111-1111-4111-8111-111111111111";
const literal = (v) =>
  v === null
    ? "NULL"
    : typeof v === "boolean" || typeof v === "number"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
const json = (v) => literal(JSON.stringify(v)) + "::jsonb";
const stamp = "2026-10-25T00:00:00.123Z";
const surfaces = [
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "remote-desktop",
  "remote-surface",
];
const pair = [],
  urls = [];
const report = {
  suite: "project-placement-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
};
let pg, failure, executable;
const open = (kind, index) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[index],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
const check = async (label, input = {}, expectedCode = null, selected) => {
  const operation = {
    op: "placement",
    owner,
    project: "github",
    surface: "terminal",
    connected: ["alpha", "beta"],
    ...input,
  };
  const expected = await pair[0].request(operation),
    actual = await pair[1].request(operation);
  const observation = (r) =>
    r.rejected
      ? { rejected: true, code: r.code, diagnostic: r.diagnostic }
      : { rejected: false, value: r.value };
  report.cases.push({
    label,
    operation,
    expected: observation(expected),
    actual: observation(actual),
  });
  assert.equal(
    expected.rejected,
    expectedCode !== null,
    `Actual source scenario: ${label}`,
  );
  if (expectedCode !== null)
    assert.equal(expected.code, expectedCode, `Actual source code: ${label}`);
  if (selected)
    assert.deepEqual(
      expected.value,
      selected,
      `Actual source selection: ${label}`,
    );
  assert.deepEqual(observation(actual), observation(expected), label);
};
const catalog = async (label, input = {}, rejected = false) => {
  const operation = {
    op: "catalog-repository",
    owner,
    project: "github",
    connected: ["alpha", "beta"],
    ...input,
  };
  const expected = await pair[0].request(operation),
    actual = await pair[1].request(operation);
  report.catalogCases ??= [];
  report.catalogCases.push({ label, operation, expected, actual });
  assert.equal(
    expected.rejected,
    rejected,
    "Actual source catalog outcome: " + label,
  );
  assert.deepEqual(
    actual.rejected
      ? { rejected: true }
      : { rejected: false, value: actual.value },
    expected.rejected
      ? { rejected: true }
      : { rejected: false, value: expected.value },
    label,
  );
};
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "reference-postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  await check("missing project", {}, "project-not-found");
  await catalog("missing project with empty owner");
  await seed(
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES(${literal(other)},'account','Other owner','member','active','placement@example.invalid','placement@example.invalid')`,
  );
  for (const [id, user] of [
    ["alpha", owner],
    ["beta", owner],
    ["foreign", other],
  ])
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,remote_surface_capabilities,started_at,last_seen_at,created_at,updated_at) VALUES(${literal(id)},${literal(user)},${literal(id + " worker")},'linux','x64','{"browser":true,"desktop":true}',${literal(stamp)},'2099-01-01',${literal(stamp)},${literal(stamp)})`,
    );
  await seed(
    `INSERT INTO user_settings(user_id,default_worker_id) VALUES(${literal(owner)},'beta') ON CONFLICT(user_id) DO UPDATE SET default_worker_id='beta'`,
  );
  for (const [id, origin, git, folder, user] of [
    ["github", "github", true, null, owner],
    ["folder", "managed-folder", false, "external", owner],
    ["local-git", "managed-folder", true, "managed", owner],
    ["foreign-project", "github", true, null, other],
  ]) {
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,github_repository_blind_index,created_at,updated_at) VALUES(${literal(id)},${literal(user)},${json(projectLabel)},${literal(origin)},${literal(folder)},${git},${origin === "github"},${literal(origin === "github" ? "agent-managed" : "direct")},${literal(origin === "github" ? "placement-blind-index" : null)},${literal(stamp)},${literal(stamp)})`,
    );
    if (user !== owner) continue;
    for (const worker of ["alpha", "beta"]) {
      await seed(
        `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,created_at,updated_at) VALUES(${literal(id + "-" + worker)},${literal(id)},${literal(worker)},${literal(id === "folder" ? "folder" : "git")},${literal("/fixture/source-" + id + "-" + worker)},${literal("/fixture/source-" + id + "-" + worker)},${literal(stamp)},${literal(stamp)})`,
      );
      await seed(
        `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES(${literal(id + "-" + worker + "-main")},${literal(id + "-" + worker)},${literal(worker)},'main',${literal("/fixture/source-" + id + "-" + worker)},${literal("/fixture/source-" + id + "-" + worker)},true,'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
      );
    }
  }
  await check(
    "foreign project",
    { project: "foreign-project" },
    "project-not-found",
  );
  await check(
    "foreign owner cannot resolve local project",
    { owner: other },
    "project-not-found",
  );
  await check(
    "unpaired UTF-16 worker identifier remains an unmatched key",
    {
      target: { kind: "worker", projectId: "github", workerId: "\ud800" },
    },
    "target-not-found",
  );
  await check(
    "bound folder rejects an unmatched UTF-16 worker before lookup",
    {
      project: "folder",
      target: { kind: "worker", projectId: "folder", workerId: "\ud800" },
    },
    "target-mismatch",
  );
  await check(
    "target project mismatch precedes worker lookup",
    {
      target: {
        kind: "worker",
        projectId: "foreign-project",
        workerId: "missing",
      },
    },
    "target-mismatch",
  );
  for (const project of ["github", "folder", "local-git"]) {
    await seed(
      `UPDATE projects SET preferred_worker_id='alpha' WHERE id=${literal(project)}`,
    );
    for (const surface of surfaces) {
      await check(`${project}/${surface}/project preference`, {
        project,
        surface,
      });
      for (const target of [
        { kind: "project", projectId: project },
        { kind: "worker", projectId: project, workerId: "alpha" },
        {
          kind: "replica",
          projectId: project,
          projectReplicaId: project + "-alpha",
        },
        {
          kind: "worktree",
          projectId: project,
          worktreeId: project + "-alpha-main",
        },
      ])
        await check(`${project}/${surface}/${target.kind}`, {
          project,
          surface,
          target,
        });
      await check(
        `${project}/${surface}/surface rejected for new placement`,
        {
          project,
          surface,
          target: {
            kind: "surface",
            projectId: project,
            surfaceKind: surface,
            surfaceId: "surface",
          },
        },
        "target-mismatch",
      );
    }
  }
  await check(
    "managed folder cannot move to another worker",
    {
      project: "folder",
      target: { kind: "worker", projectId: "folder", workerId: "beta" },
    },
    "target-mismatch",
  );
  await check(
    "explicit unknown worker",
    { target: { kind: "worker", projectId: "github", workerId: "missing" } },
    "target-not-found",
  );
  await check(
    "explicit foreign worker",
    {
      connected: ["foreign"],
      target: { kind: "worker", projectId: "github", workerId: "foreign" },
    },
    "target-not-found",
  );
  for (const [kind, field] of [
    ["replica", "projectReplicaId"],
    ["worktree", "worktreeId"],
  ])
    await check(
      `unknown ${kind}`,
      { target: { kind, projectId: "github", [field]: "missing" } },
      "target-not-found",
    );
  for (const project of [
    "github",
    "folder",
    "local-git",
    "missing",
    "foreign-project",
  ])
    await catalog("catalog " + project, { project });
  await seed("UPDATE projects SET preferred_worker_id=NULL WHERE id='github'");
  await check("account default before fallback", {}, null, {
    placement: {
      projectId: "github",
      workerId: "beta",
      projectReplicaId: "github-beta",
      worktreeId: "github-beta-main",
      surface: null,
    },
    selection: "default-worker",
  });
  await seed(
    `UPDATE user_settings SET default_worker_id=NULL WHERE user_id=${literal(owner)}`,
  );
  await check("worker fallback order", {}, null, {
    placement: {
      projectId: "github",
      workerId: "alpha",
      projectReplicaId: "github-alpha",
      worktreeId: "github-alpha-main",
      surface: null,
    },
    selection: "fallback",
  });
  await check(
    "presence overrides fresh heartbeat",
    { connected: [] },
    "no-compatible-placement",
  );
  await check("no callback uses fresh persisted heartbeat", {
    connected: undefined,
  });
  await seed("UPDATE workers SET last_seen_at='2000-01-01' WHERE id='alpha'");
  await check("connected worker survives stale heartbeat", {
    connected: ["alpha"],
  });
  await check("persisted offline worker falls back without callback", {
    connected: undefined,
  });
  await check(
    "explicit offline worker",
    {
      connected: [],
      target: { kind: "worker", projectId: "github", workerId: "alpha" },
    },
    "worker-offline",
  );
  await check("offline explicit opt-in", {
    connected: [],
    allowOffline: true,
    target: { kind: "worker", projectId: "github", workerId: "alpha" },
  });
  await seed(
    "UPDATE workers SET remote_surface_capabilities='{" +
      '"browser":false,"desktop":false' +
      "}' WHERE id='alpha'",
  );
  await check("capability fallback", { surface: "browser" });
  await check(
    "strict capability rejection",
    {
      surface: "remote-desktop",
      target: { kind: "worker", projectId: "github", workerId: "alpha" },
    },
    "capability-unavailable",
  );
  await check(
    "offline opt-in still checks capabilities",
    {
      surface: "browser",
      connected: [],
      allowOffline: true,
      target: { kind: "worker", projectId: "github", workerId: "alpha" },
    },
    "capability-unavailable",
  );
  await seed(
    "UPDATE workers SET remote_surface_capabilities='{\"browser\":true,\"desktop\":true}',last_seen_at='2099-01-01',started_at='infinity' WHERE id='alpha'",
  );
  await check("placement does not serialize unused startedAt");
  await catalog("catalog still serializes unused startedAt", {}, true);
  await seed(
    `UPDATE workers SET started_at=${literal(stamp)} WHERE id='alpha'`,
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
  );
  await check("not ready preferred replica falls back");
  await check(
    "explicit non-ready worktree precedes presence",
    {
      connected: [],
      target: {
        kind: "worktree",
        projectId: "github",
        worktreeId: "github-alpha-main",
      },
    },
    "worktree-unavailable",
  );
  await check(
    "explicit replica without ready worktree",
    {
      target: {
        kind: "replica",
        projectId: "github",
        projectReplicaId: "github-alpha",
      },
    },
    "worktree-unavailable",
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready',worker_id='beta' WHERE id='github-alpha-main'",
  );
  await check(
    "mismatched worktree/source worker",
    {
      target: {
        kind: "worktree",
        projectId: "github",
        worktreeId: "github-alpha-main",
      },
    },
    "target-mismatch",
  );
  await seed(
    "UPDATE project_worktrees SET worker_id='alpha' WHERE id='github-alpha-main'",
  );
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-alpha'`,
  );
  await check("removed replica excluded");
  await check(
    "explicit removed replica",
    {
      target: {
        kind: "replica",
        projectId: "github",
        projectReplicaId: "github-alpha",
      },
    },
    "target-not-found",
  );
  await check("rootless remote surface on worker without source", {
    surface: "browser",
    target: { kind: "worker", projectId: "github", workerId: "alpha" },
  });
  await check(
    "rooted surface requires source",
    { target: { kind: "worker", projectId: "github", workerId: "alpha" } },
    "replica-unavailable",
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
  for (const id of ["secondary-Z", "secondary-a", "secondary-é"])
    await seed(
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,created_at,updated_at) VALUES(${literal(id)},'github-alpha','alpha','secondary',${literal("/fixture/source-github-alpha/" + id)},${literal("/fixture/source-github-alpha/" + id)},false,${id === "secondary-Z"},'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
    );
  await check("default worktree precedes primary");
  await seed(
    "UPDATE project_worktrees SET is_default=false WHERE id='secondary-Z'",
  );
  await check("primary precedes secondary");
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
  );
  await check("locale ordering of equal secondary timestamps");
  await seed(
    "UPDATE project_worktrees SET created_at='infinity' WHERE id='secondary-Z'",
  );
  await check("invalid date comparator uses locale tie-break");
  await catalog("catalog serializes secondary worktree dates", {}, true);
  await seed(
    `UPDATE project_worktrees SET created_at=${literal(stamp)} WHERE id='secondary-Z'`,
  );
  await seed("UPDATE workers SET unlinked_at='2026-10-25' WHERE id='alpha'");
  await check("unlinked workers excluded");
  await check(
    "explicit unlinked worker",
    { target: { kind: "worker", projectId: "github", workerId: "alpha" } },
    "target-not-found",
  );
  await check(
    "bound owner offline is strict",
    { project: "folder", connected: [] },
    "target-not-found",
  );
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await check("retained placement after reopen");
  await catalog("retained catalog after reopen");
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
  }),
);
