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
const observe = async (name, operation, code = null, updatedWindow = null) => {
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
  if (updatedWindow)
    for (const result of [expected, actual]) {
      const timestamp = Date.parse(result.value.worktree.updatedAt);
      assert.ok(
        Number.isFinite(timestamp) &&
          timestamp >= updatedWindow[0] &&
          timestamp <= updatedWindow[1],
        name + " actual update clock",
      );
    }
  const normalize = (r) =>
    r.rejected
      ? {
          rejected: true,
          ...(code !== "generic"
            ? { code: r.code, diagnostic: r.diagnostic }
            : {}),
        }
      : {
          rejected: false,
          value: updatedWindow
            ? {
                ...r.value,
                worktree: {
                  ...r.value.worktree,
                  updatedAt: "verified-update-clock",
                },
              }
            : r.value,
        };
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
  for (const project of ["github", "folder", "local-git", "other", "missing"]) {
    await observe("worktree execution context " + project, {
      op: "worktree-context",
      project,
      worktree: project + "-alpha-main",
    });
    await observe("GitHub execution context absent metadata " + project, {
      op: "github-context",
      project,
    });
  }
  await observe("foreign worktree context", {
    op: "worktree-context",
    owner: other,
    worktree: "github-alpha-main",
  });
  await seed(
    "UPDATE projects SET github_repository_full_name='owner/repo',github_repository_url='https://github.com/owner/repo' WHERE id='github'",
  );
  for (const worker of [undefined, "", "alpha", "beta", "missing"])
    await observe("GitHub execution context worker " + worker, {
      op: "github-context",
      worker,
    });
  await observe("foreign GitHub context", {
    op: "github-context",
    owner: other,
  });
  await seed(
    `INSERT INTO project_replica_jobs(id,owner_id,project_id,project_replica_id,worker_id,kind,state,idempotency_key,payload_fingerprint,repository,progress,completed_at) VALUES ('context-provision',${literal(owner)},'github','github-alpha','alpha','provision','succeeded','context-provision','fingerprint','provisioned/repository','{"stage":"succeeded"}','2025-01-01T00:00:00Z')`,
  );
  const provisioned = await observe(
    "successful provision overrides GitHub name",
    { op: "github-context", worker: "alpha" },
  );
  assert.equal(provisioned.nameWithOwner, "provisioned/repository");
  await seed(
    "UPDATE project_replica_jobs SET state='failed' WHERE id='context-provision'",
  );
  const fallback = await observe(
    "failed provision does not override GitHub name",
    { op: "github-context", worker: "alpha" },
  );
  assert.equal(fallback.nameWithOwner, "owner/repo");
  await seed("DELETE FROM project_replica_jobs WHERE id='context-provision'");
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='removing' WHERE id='github-alpha-main'",
  );
  assert.equal(
    await observe("removing worktree context is absent", {
      op: "worktree-context",
      worktree: "github-alpha-main",
    }),
    null,
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-alpha'`,
  );
  assert.equal(
    await observe("removed source worktree context is absent", {
      op: "worktree-context",
      worktree: "github-alpha-main",
    }),
    null,
  );
  assert.equal(
    await observe("removed source GitHub context is absent", {
      op: "github-context",
      worker: "alpha",
    }),
    null,
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
  await seed(
    "UPDATE projects SET github_repository_full_name=NULL,github_repository_url=NULL WHERE id='github'",
  );
  const usageRequest = {
    op: "git-agent-usage",
    operation: "operation",
    worker: "alpha",
    runtime: {
      routeId: "unknown-route",
      provider: {},
      model: { reasoningEffort: "high" },
    },
    execution: {
      turnId: "git-turn",
      measuredUsage: {
        inputTokens: 12.6,
        outputTokens: 7.2,
        totalTokens: 20,
        cachedInputTokens: 2,
      },
    },
  };
  const usageSnapshot = async (label) =>
    observe(label, {
      op: "query-json",
      sql: "SELECT coalesce(jsonb_agg(to_jsonb(t)-'id'-'created_at'-'updated_at'-'started_at'-'completed_at'-'finalized_at' ORDER BY source_key),'[]') result FROM token_usage_records t",
    });
  await observe("Git agent usage insert", usageRequest);
  let records = await usageSnapshot("Git agent usage initial persistence");
  assert.equal(records.length, 1);
  assert.equal(records[0].input_tokens, 13);
  assert.equal(records[0].output_tokens, 7);
  await observe("Git agent usage repeat", usageRequest);
  records = await usageSnapshot("Git agent repeat does not duplicate usage");
  assert.equal(records.length, 1);
  await observe("Git agent missing usage retains counts", {
    ...usageRequest,
    execution: { turnId: "git-turn" },
  });
  records = await usageSnapshot("Git agent retained usage counters");
  assert.equal(records[0].input_tokens, 13);
  await observe(
    "Git agent different turn is rejected",
    {
      ...usageRequest,
      execution: { ...usageRequest.execution, turnId: "other-turn" },
    },
    "generic",
  );
  await seed(
    "UPDATE token_usage_records SET source_aliases='[\"git-agent:alias:unknown-route\"]'::jsonb",
  );
  await observe("Git agent existing source alias resolves", {
    ...usageRequest,
    operation: "alias",
  });
  records = await usageSnapshot("Git agent alias preserves one source record");
  assert.equal(records.length, 1);
  assert.equal(records[0].source_key, "git-agent:operation:unknown-route");
  await seed("DELETE FROM token_usage_records");
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
  for (const connected of [
    [],
    ["alpha"],
    ["beta"],
    ["missing"],
    ["alpha", "beta"],
  ])
    await observe(`observation source selection ${connected}`, {
      op: "observation-source",
      connected,
    });
  for (const input of [{ owner: other }, { project: "missing" }])
    assert.equal(
      await observe(`observation source isolation ${JSON.stringify(input)}`, {
        op: "observation-source",
        ...input,
      }),
      null,
    );
  for (const input of [
    {},
    { owner: other },
    { worker: "foreign" },
    { source: "/stale" },
    { worktreePath: "/stale" },
  ]) {
    const context = await observe(
      `filesystem observation context ${JSON.stringify(input)}`,
      {
        op: "observation-context",
        worker: "alpha",
        source: "/fixture/github-alpha",
        worktreePath: "/fixture/github-alpha",
        ...input,
      },
    );
    assert.equal(context !== null, Object.keys(input).length === 0);
  }
  const activeOperation = (name, input = {}) =>
    observe(name, {
      op: "observation-operation",
      worktree: "github-alpha-main",
      ...input,
    });
  assert.equal(await activeOperation("no active Git observation"), null);
  await seed(
    `INSERT INTO git_operations(id,owner_id,project_id,worktree_id,worker_id,type,state,original_head,current_head,target_revision,pending_commits,total_steps,created_at,updated_at) VALUES('observed-operation',${literal(owner)},'github','github-alpha-main','alpha','rebase','queued','original','current','target','["one","two"]',2,${literal(stamp)},${literal(stamp)})`,
  );
  for (const state of [
    "queued",
    "running",
    "conflicted",
    "awaiting-user-action",
    "completed",
    "failed",
    "aborted",
  ]) {
    await seed(
      `UPDATE git_operations SET state=${literal(state)} WHERE id='observed-operation'`,
    );
    const active = await activeOperation(`Git observation state ${state}`);
    assert.equal(
      active !== null,
      ["queued", "running", "conflicted", "awaiting-user-action"].includes(
        state,
      ),
    );
  }
  await seed(
    "UPDATE git_operations SET state='running',source_ref='source',source_revision='source-revision',target_ref='target-ref',checkpoint_ref='checkpoint' WHERE id='observed-operation'",
  );
  await activeOperation("Git observation non-null context");
  for (const input of [
    { owner: other },
    { project: "missing" },
    { worktree: "missing" },
  ])
    assert.equal(
      await activeOperation(
        `Git observation isolation ${JSON.stringify(input)}`,
        input,
      ),
      null,
    );
  await seed("DELETE FROM git_operations WHERE id='observed-operation'");
  for (const gitOnly of [true, false]) {
    for (const worker of ["alpha", "beta", "foreign", "missing"])
      await observe(`observation targets ${gitOnly} ${worker}`, {
        op: "observation-targets",
        worker,
        gitOnly,
      });
    for (const limit of [0, 1, 256])
      await observe(`observation bounded targets ${gitOnly} ${limit}`, {
        op: "observation-targets",
        worker: "alpha",
        gitOnly,
        limit,
      });
  }
  const observationStarted = Date.now();
  const paths = [
    {
      projectId: "github",
      worktreeId: "github-alpha-main",
      expectedSourcePath: "/fixture/github-alpha",
      expectedWorktreePath: "/fixture/github-alpha",
      sourcePath: "/resolved/source",
      worktreePath: "/resolved/worktree",
    },
  ];
  const reconcile = (name, values = paths, extra = {}) =>
    observe(name, {
      op: "observation-paths",
      worker: "alpha",
      paths: values,
      ...extra,
    });
  assert.equal(await reconcile("empty observation paths", []), 0);
  assert.equal(
    await reconcile("foreign owner observation paths", paths, { owner: other }),
    0,
  );
  assert.equal(
    await reconcile("foreign worker observation paths", paths, {
      worker: "foreign",
    }),
    0,
  );
  assert.equal(
    await reconcile("stale observation expected path", [
      { ...paths[0], expectedWorktreePath: "stale" },
    ]),
    0,
  );
  assert.equal(
    await reconcile("observation source and worktree paths update"),
    2,
  );
  assert.equal(await reconcile("observation stale retry cannot overwrite"), 0);
  await observe(
    "resolved observation context",
    {
      op: "worktree-context",
      worktree: "github-alpha-main",
    },
    null,
    [observationStarted, Date.now()],
  );
  const restore = {
    ...paths[0],
    expectedSourcePath: "/resolved/source",
    expectedWorktreePath: "/resolved/worktree",
    sourcePath: "/fixture/github-alpha",
    worktreePath: "/fixture/github-alpha",
  };
  assert.equal(await reconcile("observation restore", [restore]), 2);
  await seed(
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES('observation-peer','github-alpha','alpha','peer','/peer','/peer',false,'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
  );
  const peer = {
    ...paths[0],
    worktreeId: "observation-peer",
    expectedWorktreePath: "/peer",
    sourcePath: "/different/source",
    worktreePath: "/resolved/peer",
  };
  assert.equal(
    await reconcile(
      "inconsistent source retains source but updates worktrees",
      [paths[0], peer],
    ),
    2,
  );
  const observed = await observe(
    "conflicting source context",
    {
      op: "worktree-context",
      worktree: "github-alpha-main",
    },
    null,
    [observationStarted, Date.now()],
  );
  assert.equal(observed.sourcePath, "/fixture/github-alpha");
  assert.equal(observed.worktree.path, "/resolved/worktree");
  await (
    await import("./worktree-inventory-cases.mjs")
  ).inventoryCases({ pair, seed, report, owner, other, stamp });
  await (
    await import("./worktree-state-cases.mjs")
  ).worktreeStateCases({ pair, seed, report, owner, other, stamp });
  await (
    await import("./worktree-coordinator-cases.mjs")
  ).worktreeCoordinatorCases({ pair, seed, report, owner, other, stamp });
  await (
    await import("./run-runtime-cases.mjs")
  ).runRuntimeCases({ pair, seed, report, owner, other, stamp });
  await (
    await import("./run-runtime-contention-cases.mjs")
  ).runRuntimeContentionCases({ pair, seed, report, owner });
  await (
    await import("./run-secret-repository-cases.mjs")
  ).runSecretCases({ pair, seed, report, owner, other });
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
