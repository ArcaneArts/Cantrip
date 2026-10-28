import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  label,
  state,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-target-repository-"));
const pair = [],
  urls = [],
  report = {
    suite: "actual-project-target-repositories",
    databaseMode,
    completeReplacement: false,
    cases: [],
  };
let executable, pg, failure;
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
const negativeSeed = async (name, sql) => {
  const expected = await pair[0].request({ op: "sql", sql }),
    actual = await pair[1].request({ op: "sql", sql });
  report.databaseCases ??= [];
  report.databaseCases.push({ label: name, expected, actual });
  assert.equal(
    actual.rejected,
    expected.rejected,
    name + " actual constraint behavior",
  );
  return !expected.rejected;
};
const observe = async (name, operation, code = null) => {
  const input = {
    owner,
    project: "github",
    connected: ["alpha", "beta", "�"],
    ...operation,
  };
  const expected = await pair[0].request(input),
    actual = await pair[1].request(input);
  report.cases.push({ label: name, input, expected, actual });
  assert.equal(
    expected.rejected,
    code !== null,
    "Actual source outcome: " + name,
  );
  if (code !== null && code !== "generic")
    assert.equal(expected.code, code, "Actual source code: " + name);
  const normalize = (r) =>
    r.rejected
      ? {
          rejected: true,
          ...(code !== "generic"
            ? { code: r.code, diagnostic: r.diagnostic }
            : {}),
        }
      : { rejected: false, value: r.value };
  assert.deepEqual(normalize(actual), normalize(expected), name);
  return expected.value;
};
const catalog = (name, input = {}, code = null) =>
  observe(name, { op: "catalog-repository", ...input }, code);
const resolve = (name, target, input = {}, code = null) =>
  observe(name, { op: "target-resolve", target, ...input }, code);
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
  for (const sql of targetStateSql()) await seed(sql);
  const base = await catalog("complete protected resource graph");
  assert.deepEqual(
    new Set(base.targets.map((t) => t.resourceKind)),
    new Set([
      "worker",
      "replica",
      "worktree",
      "chat",
      "terminal",
      "explorer",
      "code",
      "browser",
      "remote-desktop",
      "remote-surface",
    ]),
  );
  for (const project of ["github", "folder", "local-git", "other", "missing"])
    await catalog("catalog ownership/type " + project, { project });
  await catalog("other owner cannot see local catalog", { owner: other });
  for (const kind of ["project", "worker", "replica", "worktree"]) {
    const target = {
      kind,
      projectId: "github",
      ...(kind === "worker"
        ? { workerId: "alpha" }
        : kind === "replica"
          ? { projectReplicaId: "github-alpha" }
          : kind === "worktree"
            ? { worktreeId: "github-alpha-main" }
            : {}),
    };
    await resolve("resolve " + kind, target);
  }
  const surfaces = [
    ["chat", "chat"],
    ["terminal", "terminal"],
    ["explorer", "explorer"],
    ["code", "code"],
    ["browser", "browser"],
    ["remote-desktop", "desktop"],
    ["remote-surface", "remote"],
  ];
  for (const [surfaceKind, surfaceId] of surfaces) {
    const target = {
      kind: "surface",
      projectId: "github",
      surfaceKind,
      surfaceId,
    };
    await resolve("resolve surface " + surfaceKind, target);
    await resolve(
      "missing surface " + surfaceKind,
      { ...target, surfaceId: "missing" },
      {},
      "target-not-found",
    );
    await resolve(
      "foreign surface " + surfaceKind,
      { ...target, surfaceId: "other-" + surfaceId },
      {},
      "target-not-found",
    );
    await resolve(
      "offline surface " + surfaceKind,
      target,
      { connected: [] },
      "worker-offline",
    );
    await resolve("offline opt-in " + surfaceKind, target, {
      connected: [],
      allowUnavailable: true,
    });
  }
  await resolve("UTF-16 worker ID uses actual SQL replacement", {
    kind: "worker",
    projectId: "github",
    workerId: "\ud800",
  });
  await resolve("UTF-16 surface ID uses actual SQL replacement", {
    kind: "surface",
    projectId: "github",
    surfaceKind: "terminal",
    surfaceId: "\ud800",
  });
  await resolve(
    "UTF-16 replica key is compared in memory",
    { kind: "replica", projectId: "github", projectReplicaId: "\ud800" },
    {},
    "target-not-found",
  );
  await resolve(
    "mismatch precedes missing project",
    { kind: "project", projectId: "other" },
    { project: "missing" },
    "target-mismatch",
  );
  await resolve(
    "foreign project denied",
    { kind: "project", projectId: "other" },
    { project: "other" },
    "project-not-found",
  );
  await resolve(
    "folder bound to own worker",
    { kind: "worker", projectId: "folder", workerId: "beta" },
    { project: "folder" },
    "target-mismatch",
  );
  await resolve(
    "local Git forbids unrepresented worker",
    { kind: "worker", projectId: "local-git", workerId: "�" },
    { project: "local-git" },
    "target-mismatch",
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
  );
  await catalog("catalog resources on unready root");
  for (const target of [
    { kind: "replica", projectId: "github", projectReplicaId: "github-alpha" },
    { kind: "worktree", projectId: "github", worktreeId: "github-alpha-main" },
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "terminal",
      surfaceId: "terminal",
    },
  ]) {
    await resolve(
      "unready " + target.kind,
      target,
      {},
      target.kind === "replica"
        ? "replica-unavailable"
        : "worktree-unavailable",
    );
    await resolve("unready opt-in " + target.kind, target, {
      allowUnavailable: true,
    });
  }
  await resolve("worker target can retain no ready primary", {
    kind: "worker",
    projectId: "github",
    workerId: "alpha",
  });
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  await seed("UPDATE chats SET active_worker_id='beta' WHERE id='chat'");
  await catalog("catalog chat affinity mismatch suppresses descriptor");
  await resolve("chat context uses worktree worker", {
    kind: "surface",
    projectId: "github",
    surfaceKind: "chat",
    surfaceId: "chat",
  });
  await seed("UPDATE chats SET active_worker_id='alpha' WHERE id='chat'");
  await seed(
    "UPDATE terminals SET active_worker_id='beta' WHERE id='terminal'",
  );
  await resolve(
    "terminal context affinity mismatch",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "terminal",
      surfaceId: "terminal",
    },
    {},
    "target-mismatch",
  );
  await seed(
    "UPDATE terminals SET active_worker_id='alpha' WHERE id='terminal'",
  );
  await seed(
    "UPDATE workers SET remote_surface_capabilities='{\"browser\":false,\"desktop\":false}' WHERE id='alpha'",
  );
  await catalog("unavailable capabilities in catalog");
  await resolve(
    "browser capability denied",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "browser",
      surfaceId: "browser",
    },
    {},
    "capability-unavailable",
  );
  await resolve(
    "browser capability opt-in",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "browser",
      surfaceId: "browser",
    },
    { allowUnavailable: true },
  );
  await seed(
    "UPDATE workers SET remote_surface_capabilities='{\"browser\":true,\"desktop\":true}' WHERE id='alpha'",
  );
  await seed(
    "UPDATE workers SET remote_surface_capabilities='null'::jsonb WHERE id='alpha'",
  );
  await catalog(
    "online null capabilities preserve mapper failure",
    {},
    "generic",
  );
  await catalog("offline availability short-circuits null capabilities", {
    connected: [],
  });
  await resolve(
    "online null browser capabilities fail even with opt-in",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "browser",
      surfaceId: "browser",
    },
    { allowUnavailable: true },
    "generic",
  );
  await resolve(
    "offline null browser capabilities permit opt-in",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "browser",
      surfaceId: "browser",
    },
    { connected: [], allowUnavailable: true },
  );
  await seed(
    "UPDATE workers SET remote_surface_capabilities='{\"browser\":true,\"desktop\":true}' WHERE id='alpha'",
  );
  await seed(`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='chat'`);
  await catalog("archived chat is excluded");
  await resolve(
    "archived chat cannot resolve",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "chat",
      surfaceId: "chat",
    },
    {},
    "target-not-found",
  );
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat'");
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-alpha'`,
  );
  await catalog("removed source excludes attached worktree resources");
  await resolve(
    "removed source cannot supply surface worktree",
    {
      kind: "surface",
      projectId: "github",
      surfaceKind: "terminal",
      surfaceId: "terminal",
    },
    {},
    "target-not-found",
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
  await seed(
    `UPDATE chats SET protected_label=${json(label("project"))} WHERE id='chat'`,
  );
  await catalog("full chat mapper rejects title classification", {}, "generic");
  await seed(
    `UPDATE chats SET protected_label=${json(label("chat"))} WHERE id='chat'`,
  );
  if (
    await negativeSeed(
      "GitHub context rejects an invalid workflow combination",
      "UPDATE chats SET github_item_kind='issue',github_item_number=1,github_agent_intent='fix-checks',github_head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id='chat'",
    )
  ) {
    await catalog(
      "full chat mapper rejects GitHub workflow context",
      {},
      "generic",
    );
    await seed(
      "UPDATE chats SET github_item_kind=NULL,github_item_number=NULL,github_agent_intent=NULL,github_head_sha=NULL WHERE id='chat'",
    );
  }
  await seed("UPDATE workers SET started_at='infinity' WHERE id='�'");
  await catalog(
    "unrelated worker mapper error precedes missing project",
    { project: "missing" },
    "generic",
  );
  await seed(`UPDATE workers SET started_at=${literal(stamp)} WHERE id='�'`);
  await seed(
    "UPDATE remote_surfaces SET protected_state=NULL,state_revision=NULL WHERE id='raw-browser'",
  );
  await catalog("remote canonical state is required", {}, "generic");
  await seed(
    `UPDATE remote_surfaces SET protected_state=${json(state("browser-state"))},state_revision=1 WHERE id='raw-browser'`,
  );
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await catalog("retained complete resource catalog");
  for (const [surfaceKind, surfaceId] of surfaces)
    await resolve("retained " + surfaceKind, {
      kind: "surface",
      projectId: "github",
      surfaceKind,
      surfaceId,
    });
} catch (e) {
  failure = e;
  report.failure = { message: e.message, stack: e.stack };
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
