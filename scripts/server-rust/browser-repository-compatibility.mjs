// Run the actual two repositories and compare returned and committed state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { workspaceState } from "./workspace-wire-fixtures.mjs";
import { browserRepositoryLocks } from "./browser-repository-locks.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  label,
  state,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-browser-repository-")),
  pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const report = {
  suite: "actual-browser-resource-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const ids = Array.from(
    { length: 30 },
    (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i + 1).padStart(12, "0")}`,
  ),
  fixed = new Set([owner, other, ...ids]);
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
  for (const r of pair) await r.seed(sql);
};
function normalize(v, i, key = "") {
  if (Array.isArray(v)) return v.map((x) => normalize(x, i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x, i, k)]),
    );
  if (typeof v !== "string") return v;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    ) &&
    !fixed.has(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `<layout-id:${aliases[i].size}>`);
    return aliases[i].get(v);
  }
  if (["createdAt", "updatedAt", "created_at", "updated_at"].includes(key)) {
    const at = Date.parse(v);
    assert.ok(Number.isFinite(at), "actual database date");
    if (at === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(
      at >= started - 1000 && at <= Date.now() + 1000,
      "actual operation date",
    );
    return "<operation-time>";
  }
  return v;
}
const snapshotSql = `SELECT json_build_object(
 'browsers',(SELECT coalesce(json_agg(t ORDER BY t.id),'[]') FROM browsers t),
 'surfaces',(SELECT coalesce(json_agg(t ORDER BY t.id),'[]') FROM remote_surfaces t),
 'projects',(SELECT coalesce(json_agg(t ORDER BY t.id),'[]') FROM (SELECT id,tab_layout_revision,center_layout_root,updated_at FROM projects) t),
 'panes',(SELECT coalesce(json_agg(t ORDER BY t.project_id,t.region,t.position,t.id),'[]') FROM tab_groups t),
 'members',(SELECT coalesce(json_agg(t ORDER BY t.project_id,t.tab_key),'[]') FROM tab_group_members t),
 'workspaces',(SELECT coalesce(json_agg(t ORDER BY t.owner_id,t.project_id,t.workspace_id),'[]') FROM workspace_layouts t)
 ) result`;
async function snapshot(name) {
  const raw = await Promise.all(
    pair.map((r) => r.request({ op: "query-json", sql: snapshotSql })),
  );
  report.snapshots.push({ name, raw });
  for (const r of raw) assert.equal(r.rejected, false, r.diagnostic);
  assert.deepEqual(
    normalize(raw[1].value, 1),
    normalize(raw[0].value, 0),
    name + " full durable state",
  );
  return raw.map((r) => r.value);
}
async function observe(
  name,
  request,
  rejected = false,
  { databaseCode, diagnostic = true } = {},
) {
  const requests = [0, 1].map((i) => ({
    owner,
    project: "github",
    browser: "browser",
    connected: ["alpha", "beta"],
    ...(typeof request === "function" ? request(i) : request),
  }));
  const values = await Promise.all(pair.map((r, i) => r.request(requests[i])));
  report.cases.push({ name, requests, values });
  assert.equal(values[0].rejected, rejected, "actual Source outcome: " + name);
  if (databaseCode)
    for (const v of values)
      assert.equal(v.databaseCode, databaseCode, name + " actual SQLSTATE");
  const diagnosticText = (v) =>
    v.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (t) =>
      t === stamp ? t : "<operation-time>",
    );
  const observable = (v, i) =>
    v.rejected
      ? {
          rejected: true,
          ...(v.code ? { code: v.code } : {}),
          ...(diagnostic ? { diagnostic: diagnosticText(v.diagnostic) } : {}),
        }
      : { rejected: false, value: normalize(v.value, i) };
  assert.deepEqual(observable(values[1], 1), observable(values[0], 0), name);
  return values.map((v) => v.value);
}
const create = (name, index, input = {}, options = {}) =>
  observe(
    name,
    {
      op: "browser-create",
      input: {
        id: ids[index],
        titleProtection: label("browser"),
        stateProtection: state("browser-state"),
        ...input,
      },
      ...(options.request ?? {}),
    },
    options.rejected ?? false,
    options,
  );
async function rollback(name, operation) {
  const before = await snapshot(name + " before");
  await operation();
  const after = await snapshot(name + " after");
  for (let i = 0; i < 2; i++)
    assert.deepEqual(after[i], before[i], name + " exact rollback");
}
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
  await seed(
    `UPDATE user_settings SET workspace_layout_profile='hybrid' WHERE user_id=${literal(owner)}`,
  );
  await observe("owned browser list", { op: "browser-list" });
  await observe("foreign project list empty", {
    op: "browser-list",
    project: "other",
  });
  await observe("missing project list empty", {
    op: "browser-list",
    project: "missing",
  });
  for (const [name, who, id] of [
    ["owned", owner, "browser"],
    ["foreign", other, "browser"],
    ["missing", owner, "missing"],
    ["foreign own", other, "other-browser"],
  ])
    await observe(name + " ownership", {
      op: "browser-owned",
      owner: who,
      browser: id,
    });
  const created = await create("hybrid profile defaults to right dock", 0);
  assert.equal(created[0].stateRevision, 1);
  assert.equal(created[0].workerId, "alpha");
  let snap = await snapshot("first browser and default dock");
  assert.equal(
    snap[0].panes.find((p) => p.project_id === "github").region,
    "right",
  );
  await create("reuse existing right dock", 1);
  await create("explicit bottom dock", 2, { targetRegion: "bottom" });
  await create("explicit center pane", 3, { targetRegion: "center" });
  await seed(
    `UPDATE user_settings SET workspace_layout_profile='agent' WHERE user_id=${literal(owner)}`,
  );
  await create("agent profile appends center pane", 4);
  await snapshot("center split and all dock members");
  await observe("explicit current pane", (i) => ({
    op: "browser-create",
    input: {
      id: ids[5],
      titleProtection: label("browser"),
      stateProtection: state("browser-state"),
      paneId: snap[i].panes.find((p) => p.region === "right").id,
    },
  }));
  await rollback("foreign pane ownership", () =>
    create(
      "foreign pane rejected",
      6,
      { paneId: "missing-pane" },
      { rejected: true },
    ),
  );
  await create("explicit worker target", 7, {
    target: { kind: "worker", projectId: "github", workerId: "beta" },
  });
  await create(
    "missing project placement",
    8,
    {},
    { rejected: true, request: { project: "missing" } },
  );
  await create(
    "foreign project placement",
    8,
    {},
    { rejected: true, request: { project: "other" } },
  );
  await rollback("duplicate browser identity", () =>
    create(
      "actual duplicate insert",
      0,
      {},
      { rejected: true, databaseCode: "23505" },
    ),
  );
  const update = (name, input, extra = {}, rejected = false, options = {}) =>
    observe(
      name,
      { op: "browser-update", browser: ids[0], input, ...extra },
      rejected,
      options,
    );
  await update("title-only preserves state revision", {
    titleProtection: { ...label("browser"), opaqueExtra: "retained" },
  });
  const revision = await update("opaque state advances revision", {
    expectedStateRevision: 1,
    stateProtection: { ...state("browser-state"), opaqueExtra: "retained" },
  });
  assert.equal(revision[0].stateRevision, 2);
  await rollback("stale state update", () =>
    update(
      "stale revision rejected",
      { expectedStateRevision: 1, stateProtection: state("browser-state") },
      {},
      true,
    ),
  );
  await update("title and state in one transaction", {
    titleProtection: label("browser"),
    expectedStateRevision: 2,
    stateProtection: state("browser-state"),
  });
  await update(
    "foreign owner update is null",
    { titleProtection: label("browser") },
    { owner: other },
  );
  await update(
    "missing browser update is null",
    { titleProtection: label("browser") },
    { browser: "missing" },
  );
  await seed(`DELETE FROM remote_surfaces WHERE id=${literal(ids[1])}`);
  const orphan = await update(
    "repository update keeps absent worker null",
    { titleProtection: label("browser") },
    { browser: ids[1] },
  );
  assert.equal(orphan[0].workerId, null);
  await observe("orphan cannot be deleted without context", {
    op: "browser-delete",
    browser: ids[1],
  });
  await seed(
    `UPDATE remote_surfaces SET protected_state=NULL WHERE id=${literal(ids[0])}`,
  );
  await snapshot("opaque state and canonical worker after updates");
  // A surface UPDATE failure must roll back the earlier browser-row write.
  await seed(
    "CREATE FUNCTION browser_fixture_reject_surface() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture surface update refused' USING ERRCODE='P0001'; END $$",
  );
  await seed(
    "CREATE TRIGGER browser_fixture_reject_surface BEFORE UPDATE ON remote_surfaces FOR EACH ROW EXECUTE FUNCTION browser_fixture_reject_surface()",
  );
  await rollback("second write failure", () =>
    update(
      "surface write fails after browser update",
      { expectedStateRevision: 3, stateProtection: state("browser-state") },
      {},
      true,
      { databaseCode: "P0001" },
    ),
  );
  await seed("DROP TRIGGER browser_fixture_reject_surface ON remote_surfaces");
  await seed("DROP FUNCTION browser_fixture_reject_surface()");
  // A projection failure happens inside creation's transaction.
  await seed(
    "ALTER TABLE browsers RENAME COLUMN updated_at TO browser_test_updated_at",
  );
  await create(
    "actual missing browser projection column",
    9,
    {},
    { rejected: true, databaseCode: "42703" },
  );
  await seed(
    "ALTER TABLE browsers RENAME COLUMN browser_test_updated_at TO updated_at",
  );
  await seed("UPDATE project_views SET position=2147483647 WHERE id='desktop'");
  await rollback("next position overflow", () =>
    create(
      "actual integer overflow",
      9,
      {},
      { rejected: true, databaseCode: "22003" },
    ),
  );
  await seed("UPDATE project_views SET position=0 WHERE id='desktop'");
  for (const [who, name] of [
    [owner, "browser-workspace"],
    [other, "foreign-browser-workspace"],
  ]) {
    const layout = workspaceState(name, ids[0]);
    for (const window of layout.windows)
      for (const pane of window.panes)
        for (const tab of pane.tabs) {
          if (tab.resource.resourceId === ids[0])
            tab.resource.definitionId = "project.browser";
        }
    await seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(who)},'github',${literal(name)},${json(layout)})`,
    );
  }
  await snapshot("browser views in primary and detached workspaces");
  for (const index of [3, 4, 0, 2, 5, 7]) {
    await observe("delete browser " + index, {
      op: "browser-delete",
      browser: ids[index],
    });
    await snapshot("layout cleanup " + index);
  }
  await observe("already deleted browser false", {
    op: "browser-delete",
    browser: ids[0],
  });
  await observe("foreign browser delete false", {
    op: "browser-delete",
    browser: "other-browser",
  });
  await observe("non-browser remote kind false", {
    op: "browser-delete",
    browser: "desktop",
  });
  await observe(
    "browser-kind surface without browser row returns false after cleanup",
    { op: "browser-delete", browser: "raw-browser" },
  );
  await snapshot("final state before reopen");
  if (databaseMode === "postgres")
    await browserRepositoryLocks({
      pair,
      urls,
      owner,
      report,
      normalize,
      snapshotSql,
    });
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await observe("retained browser list after process reopen", {
    op: "browser-list",
  });
  await snapshot("retained complete layout after reopen");
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const r of pair) await r.close().catch(() => {});
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
  else report.fixtureRoot = root;
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
