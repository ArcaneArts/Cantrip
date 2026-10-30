// Direct production repository comparisons for opaque project surface state.
import assert from "node:assert/strict";
import { workspaceState } from "./workspace-wire-fixtures.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  label,
  state,
  stamp,
} from "./project-target-state.mjs";
// Distinct valid opaque envelopes make writes observable, without decrypting.
function changedLabel(record) {
  const value = structuredClone(label(record));
  value.protectedLabel.envelope.nonce = "BBBBBBBBBBBBBBBB";
  return value;
}
function changedState() {
  const value = structuredClone(state("explorer-state"));
  value.protectedState.envelope.nonce = "CCCCCCCCCCCCCCCC";
  return value;
}
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-surfaces-")),
  started = Date.now();
const report = {
  suite: "project-surfaces-repository",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let pg, failure;
const pair = [];
const identities = [new Map(), new Map()],
  uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function identity(value, runtime) {
  const map = identities[runtime];
  if (!map.has(value)) map.set(value, `<generated-${map.size}>`);
  return map.get(value);
}
function nativeInput(value) {
  if (Array.isArray(value)) return value.map(nativeInput);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, nativeInput(v)]),
    );
  if (typeof value === "string" && identities[0].has(value))
    return (
      [...identities[1]].find(
        ([, alias]) => alias === identities[0].get(value),
      )?.[0] ?? value
    );
  return value;
}
const normalize = (value, runtime = 0) => {
  if (Array.isArray(value)) return value.map((v) => normalize(v, runtime));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (typeof v === "string" && /(?:At|_at)$/.test(key)) {
          const time = Date.parse(v);
          assert.ok(Number.isFinite(time));
          if (v === stamp || time === Date.parse(stamp))
            return [key, "<fixture-time>"];
          assert.ok(
            time >= started - 1000 && time <= Date.now() + 1000,
            "actual mutation time",
          );
          return [key, "<operation-time>"];
        }
        if (key === "diagnostic" && typeof v === "string")
          return [
            key,
            v
              .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/gu, (at) => {
                const time = Date.parse(at);
                assert.ok(
                  at === stamp ||
                    (time >= started - 1000 && time <= Date.now() + 1000),
                  "actual SQL diagnostic timestamp",
                );
                return at === stamp ? "<fixture-time>" : "<operation-time>";
              })
              .replace(
                /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/gu,
                (id) => identity(id, runtime),
              ),
          ];
        return [key, normalize(v, runtime)];
      }),
    );
  return typeof value === "string" && uuid.test(value)
    ? identity(value, runtime)
    : value;
};
const seed = async (sql) => {
  for (const repository of pair) await repository.seed(sql);
};
async function observe(name, changes = {}, options = {}) {
  const request = {
    op: "project-surface-list",
    kind: "explorer",
    owner: localOwner,
    project: "github",
    ...changes,
  };
  const values = await Promise.all(
    pair.map((repository, runtime) =>
      repository.request(runtime ? nativeInput(request) : request),
    ),
  );
  report.cases.push({ name, values });
  for (const v of values)
    assert.equal(
      v.rejected,
      options.rejected ?? false,
      name + ": " + v.diagnostic,
    );
  const source = normalize({ ...values[0], id: 0 }, 0),
    native = normalize({ ...values[1], id: 0 }, 1);
  assert.deepEqual(native, source, name);
  if ("expected" in options)
    assert.deepEqual(values[0].value, options.expected);
  return values[0].value;
}
async function snapshot(name) {
  const values = await Promise.all(
    pair.map((repository) =>
      repository.request({
        op: "query-json",
        sql: "SELECT jsonb_build_object('explorers',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM explorers r),'code',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM code_tabs r),'views',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM project_views r),'remote',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM remote_surfaces r),'projects',(SELECT jsonb_agg(jsonb_build_object('id',id,'revision',tab_layout_revision,'root',center_layout_root) ORDER BY id) FROM projects),'groups',(SELECT jsonb_agg(to_jsonb(r) ORDER BY region,position,id) FROM tab_groups r),'members',(SELECT jsonb_agg(to_jsonb(r) ORDER BY tab_key) FROM tab_group_members r),'workspaces',(SELECT jsonb_agg(to_jsonb(r) ORDER BY owner_id,workspace_id) FROM workspace_layouts r)) result",
      }),
    ),
  );
  for (const v of values) assert.equal(v.rejected, false, v.diagnostic);
  const source = normalize(values[0].value, 0),
    native = normalize(values[1].value, 1);
  assert.deepEqual(native, source, name);
  report.snapshots.push({ name, values });
  return values[0].value;
}
async function savedViews(subject, definition) {
  const layouts = [];
  for (const owner of [localOwner, otherOwner]) {
    const id = `${subject}-${owner === localOwner ? "owned" : "foreign"}`;
    const layout = workspaceState(id, subject);
    for (const window of layout.windows)
      for (const pane of window.panes)
        for (const tab of pane.tabs)
          if (tab.resource.resourceId === subject)
            tab.resource.definitionId =
              definition === "project.explorer" && tab.id === "detached-tab"
                ? "project.file"
                : definition;
    await seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github',${literal(id)},${json(layout)})`,
    );
    layouts.push({ owner, id, layout });
  }
  return (snapshot) => {
    for (const { owner, id, layout } of layouts) {
      const stored = snapshot.workspaces.find(
        (row) => row.owner_id === owner && row.workspace_id === id,
      ).layout;
      if (owner === otherOwner)
        assert.deepEqual(stored, layout, "foreign workspace remains unchanged");
      else {
        assert.equal(
          stored.revision,
          layout.revision + 3,
          "one revision per removed view",
        );
        assert.equal(stored.windows[0].panes.length, 1);
        assert.equal(
          stored.windows[1].panes.length,
          0,
          "detached view removed",
        );
        assert.deepEqual(
          stored.windows[0].panes[0].tabs.map((tab) => tab.id),
          ["b"],
        );
      }
    }
  };
}
async function deletionRollback(kind, subject) {
  const table = {
    explorer: "explorers",
    code: "code_tabs",
    view: "project_views",
  }[kind];
  await seed(
    "CREATE FUNCTION surface_fixture_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture surface deletion refused' USING ERRCODE='P0001'; END $$",
  );
  await seed(
    `CREATE TRIGGER surface_fixture_reject_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION surface_fixture_reject_delete()`,
  );
  try {
    const before = await snapshot(`${subject}: before rejected final delete`);
    await observe(
      `${subject}: final delete failure rolls back all cleanup`,
      {
        op: "project-surface-delete",
        kind,
        subject,
      },
      { rejected: true },
    );
    assert.deepEqual(
      await snapshot(`${subject}: after rejected final delete`),
      before,
      "workspace views, legacy panes, layout revisions and remote surface survive failed resource deletion",
    );
  } finally {
    await seed(`DROP TRIGGER surface_fixture_reject_delete ON ${table}`);
    await seed("DROP FUNCTION surface_fixture_reject_delete()");
  }
}

try {
  const executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode,
        databaseUrl,
      }),
    );
  }
  for (const sql of targetStateSql()) await seed(sql);
  for (const [kind, subject, record] of [
    ["explorer", "explorer", "explorer"],
    ["code", "code", "code-tab"],
    ["view", "desktop", "project-view"],
  ]) {
    const run = (name, op, changes = {}, options = {}) =>
      observe(
        `${kind}: ${name}`,
        {
          kind,
          subject,
          op: `project-surface-${op}`,
          ...changes,
        },
        options,
      );
    await run("owned list", "list");
    await run(
      "foreign project list",
      "list",
      { project: "other" },
      { expected: [] },
    );
    await run(
      "foreign owner list",
      "list",
      { owner: otherOwner },
      { expected: [] },
    );
    await run(
      "missing project list",
      "list",
      { project: "missing" },
      { expected: [] },
    );
    if (kind !== "view") {
      await run("owned context", "context");
      await run(
        "foreign context",
        "context",
        { owner: otherOwner },
        { expected: null },
      );
      await run(
        "missing context",
        "context",
        { subject: "missing" },
        { expected: null },
      );
    } else {
      await run("owned project", "project", {}, { expected: "github" });
      await run(
        "foreign project",
        "project",
        { owner: otherOwner },
        { expected: null },
      );
    }
    const input = { titleProtection: changedLabel(record) };
    await run(
      "foreign title update",
      "update",
      { owner: otherOwner, input },
      { expected: null },
    );
    await run(
      "missing title update",
      "update",
      { subject: "missing", input },
      { expected: null },
    );
    const updated = await run("opaque title update", "update", { input });
    assert.deepEqual(updated.titleProtection, input.titleProtection);
    if (kind === "code") {
      await run("empty title update", "update", { input: {} });
      await run("null title update", "update", {
        input: { titleProtection: null },
      });
    }
    if (kind === "explorer") {
      const input = {
        stateProtection: changedState(),
        fileMode: "edit",
      };
      const updated = await run("opaque state update", "state", { input });
      assert.deepEqual(updated.stateProtection, input.stateProtection);
      await run(
        "foreign state update",
        "state",
        { owner: otherOwner, input },
        { expected: null },
      );
    }
    if (kind === "explorer") {
      const input = {
        titleProtection: label("explorer"),
        stateProtection: changedState(),
        fileMode: "edit",
        targetRegion: "right",
      };
      await run(
        "foreign pin",
        "pin",
        { owner: otherOwner, input },
        { expected: null },
      );
      await run(
        "missing pin",
        "pin",
        { subject: "missing", input },
        { expected: null },
      );
      await run(
        "file pin rejects left placement",
        "pin",
        { input: { ...input, targetRegion: "left" } },
        { rejected: true },
      );
      await snapshot("pin failure rolls back resource and revision");
      const pinned = await run("pin file into dock", "pin", { input });
      await run(
        "retry keeps original state and ignores invalid destination",
        "pin",
        {
          input: {
            ...input,
            titleProtection: { changed: true },
            stateProtection: { changed: true },
            paneId: "missing",
          },
        },
        { expected: pinned },
      );
      await snapshot("pin retry remains idempotent");
    }
    const treeInput = {
      worktreeId: "github-beta-main",
      ...(kind === "explorer"
        ? { stateProtection: state("explorer-state") }
        : {}),
    };
    await run(
      "foreign worktree update",
      "worktree",
      { owner: otherOwner, input: treeInput },
      { expected: null },
    );
    await run(
      "worktree update",
      "worktree",
      { input: treeInput },
      { rejected: kind === "view" },
    );
    if (kind !== "view") {
      await run("new execution context", "context");
      await run(
        "foreign target",
        "worktree",
        { input: { ...treeInput, worktreeId: "other-foreign-main" } },
        { expected: null },
      );
      await seed(
        "UPDATE project_worktrees SET lifecycle_state='failed' WHERE id='github-alpha-main'",
      );
      await run(
        "unready target",
        "worktree",
        { input: { ...treeInput, worktreeId: "github-alpha-main" } },
        { expected: null },
      );
      await seed(
        "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
      );
    }
    await snapshot(`${kind}: mutations preserve opaque data and ownership`);
    await run(
      "foreign deletion",
      "delete",
      { owner: otherOwner },
      { expected: kind === "code" ? null : false },
    );
    const checkViews = await savedViews(
      subject,
      {
        explorer: "project.explorer",
        code: "project.code",
        view: "project.remote-desktop",
      }[kind],
    );
    await deletionRollback(kind, subject);
    await run("owned deletion", "delete");
    await run(
      "repeated deletion",
      "delete",
      {},
      { expected: kind === "code" ? null : false },
    );
    checkViews(await snapshot(`${kind}: deletion and remote resource cleanup`));
  }
  for (const kind of ["history", "graph", "issues", "prs", "actions"]) {
    await seed(
      `INSERT INTO project_views(id,project_id,kind,worktree_id,protected_label,created_at,updated_at) VALUES(${literal(kind)},'github',${literal(kind)},'github-alpha-main',${json(label("project-view"))},${literal(stamp)},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,created_at,updated_at) VALUES(${literal(kind + "-pane")},'github','right',0,${literal("view:" + kind)},${literal(stamp)},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES(${literal("view:" + kind)},${literal(kind + "-pane")},'github',${literal(kind)},${literal(kind)},0,${literal(stamp)},${literal(stamp)})`,
    );
    await observe(`${kind}: retarget`, {
      op: "project-surface-worktree",
      kind: "view",
      subject: kind,
      input: { worktreeId: "github-beta-main" },
    });
    const checkViews = await savedViews(
      kind,
      {
        history: "project.git-history",
        graph: "project.git-graph",
        issues: "project.github-issues",
        prs: "project.github-pull-requests",
        actions: "project.github-actions",
      }[kind],
    );
    await deletionRollback("view", kind);
    await observe(
      `${kind}: delete`,
      { op: "project-surface-delete", kind: "view", subject: kind },
      { expected: true },
    );
    checkViews(await snapshot(`${kind}: persisted views removed`));
  }
  await snapshot("all project view kinds removed");
  for (const [kind, record] of [
    ["explorer", "explorer"],
    ["code", "code-tab"],
    ["view", "project-view"],
  ]) {
    for (const profile of ["agent", "hybrid", "ide"]) {
      await seed(
        `UPDATE user_settings SET workspace_layout_profile=${literal(profile)} WHERE user_id=${literal(localOwner)}`,
      );
      const id = `${kind}-${profile}`;
      const input = {
        id,
        titleProtection: label(record),
        ...(kind === "explorer"
          ? { stateProtection: state("explorer-state") }
          : {}),
        ...(kind === "view" ? { kind: "history" } : {}),
      };
      const run = (name, op, changes = {}, options = {}) =>
        observe(
          `${id}: ${name}`,
          { kind, subject: id, op: `project-surface-${op}`, input, ...changes },
          options,
        );
      await run("create with profile default", "create");
      await snapshot(`${id}: persisted placement`);
      await run("duplicate creation rejects", "create", {}, { rejected: true });
      await snapshot(`${id}: duplicate rollback`);
      await run("delete created surface", "delete");
      await snapshot(`${id}: placement cleanup`);
      await run(
        "invalid destination rolls back",
        "create",
        { input: { ...input, paneId: "missing" } },
        { rejected: true },
      );
      await snapshot(`${id}: placement failure rollback`);
      await run("explicit worktree and region", "create", {
        input: {
          ...input,
          worktreeId: "github-beta-main",
          targetRegion: "bottom",
        },
      });
      await run("delete explicit surface", "delete");
    }
  }
  const detachedInput = {
    id: "detached",
    titleProtection: label("explorer"),
    stateProtection: state("explorer-state"),
    attachToTabLayout: false,
    paneId: "missing",
  };
  await observe("unattached Explorer ignores destination", {
    op: "project-surface-create",
    kind: "explorer",
    input: detachedInput,
  });
  await snapshot("unattached Explorer does not mutate layout");
  await observe("unattached Explorer can be pinned", {
    op: "project-surface-pin",
    kind: "explorer",
    subject: "detached",
    input: {
      ...detachedInput,
      paneId: undefined,
      targetRegion: "center",
      fileMode: "edit",
    },
  });
  await snapshot("unattached Explorer becomes a file tab");
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
  report.diagnostics = pair.map((p) => p.diagnostics());
} finally {
  for (const p of pair)
    try {
      await p.close();
    } catch (error) {
      failure ??= error;
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
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
