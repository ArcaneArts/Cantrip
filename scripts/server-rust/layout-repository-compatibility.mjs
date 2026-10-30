// Real standalone legacy reads, including their transaction-only lazy cleanup.
import assert from "node:assert/strict";
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
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-layout-repository-")),
  started = Date.now();
const report = {
  suite: "legacy-layout-repository",
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
    op: "layout-get",
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
        sql: "SELECT jsonb_build_object('revision',tab_layout_revision,'root',center_layout_root,'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY region,position,id) FROM tab_groups g),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY tab_key) FROM tab_group_members m),'builtins',(SELECT jsonb_agg(to_jsonb(s) ORDER BY project_id,definition_id) FROM project_builtin_surface_states s),'launchers',(SELECT jsonb_agg(to_jsonb(s) ORDER BY project_id,definition_id,location) FROM project_surface_launcher_preferences s),'docks',(SELECT jsonb_agg(to_jsonb(s) ORDER BY project_id,tab_key,region) FROM project_dock_presentation_preferences s)) result FROM projects WHERE id='github'",
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
  await observe("missing project", { project: "missing" }, { expected: null });
  await observe("foreign owner", { owner: otherOwner }, { expected: null });
  await observe(
    "empty project",
    {},
    {
      expected: {
        projectId: "github",
        revision: 0,
        centerRoot: null,
        panes: [],
      },
    },
  );
  await seed(
    `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label,created_at,updated_at) VALUES('center','github','center',0,'terminal:terminal',${json(label("tab-group"))},${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES('terminal:terminal','center','github','terminal','terminal',0,${literal(stamp)},${literal(stamp)}),('chat:chat','center','github','chat','chat',1,${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `UPDATE projects SET center_layout_root=${json({ kind: "pane", paneId: "center" })},tab_layout_revision=8 WHERE id='github'`,
  );
  const initial = await observe("standalone pane/resource read");
  assert.equal(initial.panes[0].members.length, 2);
  await seed(
    `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES('builtin:github:project.overview','center','github','builtin','project.overview',2,${literal(stamp)},${literal(stamp)})`,
  );
  const before = await snapshot("before standalone Overview cleanup");
  await seed(
    "CREATE FUNCTION layout_cleanup_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.tab_id='project.overview' THEN RAISE EXCEPTION 'controlled standalone cleanup failure'; END IF; RETURN OLD; END $$",
  );
  await seed(
    "CREATE TRIGGER layout_cleanup_reject BEFORE DELETE ON tab_group_members FOR EACH ROW EXECUTE FUNCTION layout_cleanup_reject()",
  );
  try {
    await observe(
      "standalone cleanup transaction rolls back",
      {},
      { rejected: true },
    );
    assert.deepEqual(
      await snapshot("failed standalone cleanup retains state"),
      before,
    );
  } finally {
    await seed("DROP TRIGGER layout_cleanup_reject ON tab_group_members");
    await seed("DROP FUNCTION layout_cleanup_reject()");
  }
  const cleaned = await observe("standalone cleanup commits once and rereads");
  assert.equal(cleaned.revision, 9);
  assert.equal(cleaned.panes[0].members.length, 2);
  await observe(
    "ordinary read does not bump legacy revision",
    {},
    { expected: cleaned },
  );
  let revision = 9;
  async function mutate(
    name,
    action,
    input = {},
    subject = "center",
    options = {},
  ) {
    const value = await observe(
      name,
      { op: "layout-" + action, subject, input: { revision, ...input } },
      options,
    );
    if (!options.rejected && value?.revision !== undefined)
      revision = value.revision;
    if (!options.rejected && value?.layout?.revision !== undefined)
      revision = value.layout.revision;
    return value;
  }
  await observe(
    "missing mutation project remains null",
    {
      op: "layout-title",
      project: "missing",
      subject: "center",
      input: { revision, titleProtection: label("tab-group") },
    },
    { expected: null },
  );
  await observe(
    "foreign mutation project remains null",
    {
      op: "layout-title",
      owner: otherOwner,
      subject: "center",
      input: { revision, titleProtection: label("tab-group") },
    },
    { expected: null },
  );
  await mutate(
    "stale revision retains conflict type",
    "title",
    { revision: revision - 1, titleProtection: label("tab-group") },
    "center",
    { rejected: true },
  );
  await mutate(
    "missing pane rolls back revision claim",
    "title",
    { titleProtection: label("tab-group") },
    "missing",
    { rejected: true },
  );
  const renamed = await mutate("rename multi-member pane", "title", {
    titleProtection: label("tab-group"),
  });
  assert.equal(renamed.revision, 10);
  await mutate(
    "member order rejects wrong set",
    "member-order",
    { tabKeys: ["chat:chat", "missing"] },
    "center",
    { rejected: true },
  );
  await mutate("member order updates all positions", "member-order", {
    tabKeys: ["chat:chat", "terminal:terminal"],
  });
  await mutate(
    "pane order rejects wrong region set",
    "pane-order",
    { region: "center", paneIds: ["missing"] },
    "center",
    { rejected: true },
  );
  await mutate("center pane order retains topology", "pane-order", {
    region: "center",
    paneIds: ["center"],
  });
  await mutate(
    "legacy order rejects missing pane",
    "legacy-order",
    { paneIds: [] },
    "center",
    { rejected: true },
  );
  await mutate("legacy order retains region subsequences", "legacy-order", {
    paneIds: ["center"],
  });
  await mutate(
    "center placement rejects dock preferences",
    "dock",
    {
      tabKey: "terminal:terminal",
      preferredMode: "split",
      splitFraction: 0.4,
      restoreFraction: 0.5,
    },
    "center",
    { rejected: true },
  );
  await seed(
    `INSERT INTO project_builtin_surface_states(project_id,definition_id,created_at,updated_at) VALUES('github','project.tasks',${literal(stamp)},${literal(stamp)}),('github','git.history',${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,created_at,updated_at) VALUES('second','github','center',1,'builtin:github:project.tasks',${literal(stamp)},${literal(stamp)}),('right','github','right',0,'browser:browser',${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES('builtin:github:project.tasks','second','github','builtin','project.tasks',0,${literal(stamp)},${literal(stamp)}),('browser:browser','right','github','browser','browser',0,${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `UPDATE projects SET center_layout_root=${json({ kind: "split", id: "split", direction: "horizontal", fraction: 0.5, first: { kind: "pane", paneId: "center" }, second: { kind: "pane", paneId: "second" } })} WHERE id='github'`,
  );
  await mutate(
    "single-member pane rejects independent title",
    "title",
    { titleProtection: label("tab-group") },
    "second",
    { rejected: true },
  );
  await mutate("two center panes reorder leaves and positions", "pane-order", {
    region: "center",
    paneIds: ["second", "center"],
  });
  await mutate("dock region order uses one pane", "pane-order", {
    region: "right",
    paneIds: ["right"],
  });
  await mutate("legacy mixed order preserves each region", "legacy-order", {
    paneIds: ["center", "right", "second"],
  });
  await mutate(
    "resize rejects absent split",
    "resize",
    { fraction: 0.6 },
    "missing",
    { rejected: true },
  );
  const resized = await mutate(
    "resize preserves split identity and leaves",
    "resize",
    { fraction: 0.65 },
    "split",
  );
  assert.equal(resized.centerRoot.fraction, 0.65);
  await mutate("write dock presentation", "dock", {
    tabKey: "browser:browser",
    preferredMode: "full",
    splitFraction: 0.43,
    restoreFraction: 0.61,
  });
  await mutate("upsert dock presentation retains original creation", "dock", {
    tabKey: "browser:browser",
    preferredMode: "split",
    splitFraction: 0.37,
    restoreFraction: 0.47,
  });
  const launchers = await observe("all definition launcher defaults", {
    op: "layout-launchers",
  });
  assert.ok(launchers.length > 20);
  await observe(
    "foreign owner cannot list launchers",
    { op: "layout-launchers", owner: otherOwner },
    { expected: null },
  );
  const launcher = launchers.find(
    (l) => l.target.definitionId === "git.history",
  );
  assert.ok(launcher);
  const pin = {
    location: launcher.location,
    definitionId: "git.history",
    pinned: !launcher.pinned,
  };
  const pinned = await observe("pin supported built-in launcher", {
    op: "layout-pin",
    input: pin,
  });
  assert.equal(pinned.pinned, pin.pinned);
  await observe("pin upsert returns requested value", {
    op: "layout-pin",
    input: { ...pin, pinned: launcher.pinned },
  });
  await observe(
    "unsupported launcher location retains invariant",
    { op: "layout-pin", input: { ...pin, location: "not-a-location" } },
    { rejected: true },
  );
  await observe(
    "missing launcher project remains null",
    { op: "layout-pin", project: "missing", input: pin },
    { expected: null },
  );
  await observe(
    "tasks refuses worktree before project lookup",
    {
      op: "layout-builtin-worktree",
      project: "missing",
      subject: "project.tasks",
      input: { worktreeId: "github-alpha-main" },
    },
    { rejected: true },
  );
  await observe(
    "missing worktree remains null",
    {
      op: "layout-builtin-worktree",
      subject: "git.history",
      input: { worktreeId: "missing" },
    },
    { expected: null },
  );
  const bound = await observe("bind ready owned built-in worktree", {
    op: "layout-builtin-worktree",
    subject: "git.history",
    input: { worktreeId: "github-alpha-main" },
  });
  assert.equal(bound.revision, revision);
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='removing' WHERE id='github-alpha-main'",
  );
  await observe(
    "non-ready built-in worktree remains unavailable",
    {
      op: "layout-builtin-worktree",
      subject: "git.history",
      input: { worktreeId: "github-alpha-main" },
    },
    { expected: null },
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  const beforeFailedWrite = await snapshot("before failed pane title write");
  await seed(
    "CREATE FUNCTION layout_title_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled title write failure'; END $$",
  );
  await seed(
    "CREATE TRIGGER layout_title_reject BEFORE UPDATE OF protected_label ON tab_groups FOR EACH ROW EXECUTE FUNCTION layout_title_reject()",
  );
  try {
    await mutate(
      "actual title write failure rolls back claim",
      "title",
      { titleProtection: label("tab-group") },
      "center",
      { rejected: true },
    );
    assert.deepEqual(
      await snapshot("failed title write retains committed layout"),
      beforeFailedWrite,
    );
  } finally {
    await seed("DROP TRIGGER layout_title_reject ON tab_groups");
    await seed("DROP FUNCTION layout_title_reject()");
  }
  await mutate("title write succeeds after trigger removal", "title", {
    titleProtection: null,
  });
  await snapshot("committed pane mutations");
  const moveInput = {
    tabKey: "chat:chat",
    targetPaneId: "center",
    targetMemberPosition: 0,
  };
  await mutate(
    "move rejects missing member",
    "move",
    { ...moveInput, tabKey: "missing" },
    "center",
    { rejected: true },
  );
  await mutate(
    "move rejects foreign destination",
    "move",
    { ...moveInput, targetPaneId: "missing" },
    "center",
    { rejected: true },
  );
  await mutate(
    "move rejects pane and region together",
    "move",
    { ...moveInput, targetRegion: "right" },
    "center",
    { rejected: true },
  );
  await mutate("move within same pane clamps position", "move", {
    ...moveInput,
    targetMemberPosition: 100,
  });
  const dockMoved = await mutate(
    "final dock member relocates its existing pane",
    "move",
    {
      tabKey: "browser:browser",
      targetPaneId: null,
      targetRegion: "bottom",
      targetMemberPosition: 0,
    },
  );
  assert.equal(dockMoved.panes.find((p) => p.id === "right").region, "bottom");
  await mutate(
    "final tab cannot split its own pane",
    "split",
    {
      tabKey: "builtin:github:project.tasks",
      targetPaneId: "second",
      edge: "right",
      fraction: 0.5,
    },
    "center",
    { rejected: true },
  );
  let split = await mutate(
    "split tab into new horizontal center pane",
    "split",
    {
      tabKey: "chat:chat",
      targetPaneId: "second",
      edge: "left",
      fraction: 0.4,
    },
  );
  let chatPane = split.panes.find((p) =>
    p.members.some((m) => m.tabKey === "chat:chat"),
  );
  assert.notEqual(chatPane.id, "center");
  split = await mutate(
    "split final source tab and collapse old branch",
    "split",
    {
      tabKey: "chat:chat",
      targetPaneId: "center",
      edge: "bottom",
      fraction: 0.6,
    },
  );
  chatPane = split.panes.find((p) =>
    p.members.some((m) => m.tabKey === "chat:chat"),
  );
  await mutate("move final center pane reorders existing leaves", "move", {
    tabKey: "terminal:terminal",
    targetPaneId: null,
    targetPanePosition: 100,
    targetMemberPosition: 0,
  });
  await mutate("move final tab into another pane collapses source", "move", {
    ...moveInput,
    targetPaneId: "center",
    targetMemberPosition: 0,
  });
  const newPane = await mutate(
    "move one grouped tab creates and orders a center pane",
    "move",
    {
      ...moveInput,
      targetPaneId: null,
      targetRegion: "center",
      targetPanePosition: 0,
    },
  );
  chatPane = newPane.panes.find((p) =>
    p.members.some((m) => m.tabKey === "chat:chat"),
  );
  await mutate("move final dock member into existing center group", "move", {
    tabKey: "browser:browser",
    targetPaneId: chatPane.id,
    targetMemberPosition: 0,
  });
  await mutate(
    "browser cannot move into left region",
    "move",
    {
      tabKey: "browser:browser",
      targetPaneId: null,
      targetRegion: "left",
      targetPanePosition: 0,
      targetMemberPosition: 0,
    },
    "center",
    { rejected: true },
  );
  await mutate("move grouped member creates a single-pane right dock", "move", {
    ...moveInput,
    targetPaneId: null,
    targetRegion: "right",
  });
  await mutate("move final right member removes source dock", "move", {
    ...moveInput,
    targetPaneId: "center",
  });
  await snapshot("committed move and split topology");
  const entity = (definitionId, resourceId) => ({
    kind: "entity",
    definitionId,
    resourceId,
  });
  const builtin = (definitionId) => ({ kind: "builtin", definitionId });
  await observe(
    "Overview rejection precedes ownership lookup",
    {
      op: "layout-open",
      project: "missing",
      input: { revision, surfaceRef: builtin("project.overview") },
    },
    { rejected: true },
  );
  await observe(
    "foreign project cannot open a view",
    {
      op: "layout-open",
      owner: otherOwner,
      input: { revision, surfaceRef: builtin("project.tasks") },
    },
    { expected: null },
  );
  await mutate(
    "unavailable entity rolls back revision claim",
    "open",
    { surfaceRef: entity("project.terminal", "missing") },
    "center",
    { rejected: true },
  );
  await mutate(
    "open rejects foreign explicit pane",
    "open",
    {
      surfaceRef: entity("project.explorer", "explorer"),
      targetPaneId: "missing",
    },
    "center",
    { rejected: true },
  );
  const leftExplorer = await mutate(
    "Explorer opens in supported left region",
    "open",
    {
      surfaceRef: entity("project.explorer", "explorer"),
      targetRegion: "left",
    },
  );
  assert.equal(
    leftExplorer.layout.panes.find((p) => p.id === leftExplorer.paneId).region,
    "left",
  );
  const focused = await mutate(
    "existing view ignores stale revision and placement",
    "open",
    {
      revision: 0,
      surfaceRef: entity("project.explorer", "explorer"),
      targetPaneId: "missing",
    },
  );
  assert.equal(focused.disposition, "focused");
  await mutate(
    "legacy file fallback resolves existing Explorer placement",
    "open",
    { revision: 0, surfaceRef: entity("project.file", "explorer") },
  );
  await mutate("close final left placement retains resource", "close", {
    viewId: "explorer:explorer",
  });
  const closed = await mutate(
    "already closed ignores stale revision",
    "close",
    { revision: 0, viewId: "explorer:explorer" },
  );
  assert.equal(closed.disposition, "already-closed");
  await mutate("focused builtin ignores stale revision", "open", {
    revision: 0,
    surfaceRef: builtin("project.tasks"),
  });
  await mutate("open built-in preserves existing worktree binding", "open", {
    surfaceRef: builtin("git.history"),
    targetPaneId: "center",
  });
  await mutate("close built-in retains its persistent state", "close", {
    viewId: "builtin:github:git.history",
  });
  const beforeOpenFailure = await snapshot("before failed surface placement");
  await seed(
    "CREATE FUNCTION layout_open_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tab_id='git.graph' THEN RAISE EXCEPTION 'controlled surface placement failure'; END IF; RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER layout_open_reject BEFORE INSERT ON tab_group_members FOR EACH ROW EXECUTE FUNCTION layout_open_reject()",
  );
  try {
    await mutate(
      "failed placement rolls back builtin pane and revision",
      "open",
      { surfaceRef: builtin("git.graph"), targetRegion: "center" },
      "center",
      { rejected: true },
    );
    assert.deepEqual(
      await snapshot("failed surface placement retains complete state"),
      beforeOpenFailure,
    );
  } finally {
    await seed("DROP TRIGGER layout_open_reject ON tab_group_members");
    await seed("DROP FUNCTION layout_open_reject()");
  }
  await mutate("close grouped chat repairs remaining title", "close", {
    viewId: "chat:chat",
  });
  await mutate("reopen existing chat through profile placement", "open", {
    surfaceRef: entity("project.agent", "chat"),
  });
  await mutate("close final center chat collapses branch", "close", {
    viewId: "chat:chat",
  });
  await seed(
    `INSERT INTO user_settings(user_id,workspace_layout_profile) VALUES(${literal(localOwner)},'ide') ON CONFLICT(user_id) DO UPDATE SET workspace_layout_profile='ide'`,
  );
  const ideChat = await mutate(
    "IDE profile opens agent in right region",
    "open",
    { surfaceRef: entity("project.agent", "chat") },
  );
  assert.equal(
    ideChat.layout.panes.find((p) => p.id === ideChat.paneId).region,
    "right",
  );
  await mutate("close right profile placement", "close", {
    viewId: "chat:chat",
  });
  for (const id of [
    "git.graph",
    "github.issues",
    "github.pull-requests",
    "github.actions",
  ]) {
    await mutate("open builtin " + id, "open", { surfaceRef: builtin(id) });
  }
  for (const [id, kind] of [
    ["history", "history"],
    ["graph", "graph"],
    ["issues", "issues"],
    ["prs", "prs"],
    ["actions", "actions"],
  ]) {
    await seed(
      `INSERT INTO project_views(id,project_id,kind,protected_label,created_at,updated_at) VALUES(${literal(id)},'github',${literal(kind)},${json(label("project-view"))},${literal(stamp)},${literal(stamp)})`,
    );
  }
  for (const [definition, id] of [
    ["project.agent", "chat"],
    ["project.terminal", "terminal"],
    ["project.explorer", "explorer"],
    ["project.browser", "browser"],
    ["project.code", "code"],
    ["project.remote-desktop", "desktop"],
    ["project.git-history", "history"],
    ["project.git-graph", "graph"],
    ["project.github-issues", "issues"],
    ["project.github-pull-requests", "prs"],
    ["project.github-actions", "actions"],
  ]) {
    await mutate("open or focus entity " + definition, "open", {
      surfaceRef: entity(definition, id),
      targetPaneId: "center",
    });
  }
  const beforeCloseAll = await observe("read all open surface placements");
  for (const pane of beforeCloseAll.panes)
    for (const member of pane.members) {
      await mutate("close surface " + member.tabKey, "close", {
        viewId: member.tabKey,
      });
    }
  const empty = await observe("last closed center pane clears root");
  assert.equal(empty.centerRoot, null);
  assert.equal(empty.panes.length, 0);
  await snapshot("surface close retains resource and preference records");
  await mutate("reopen task before invariant failure", "open", {
    surfaceRef: builtin("project.tasks"),
    targetRegion: "center",
  });
  await seed("UPDATE projects SET center_layout_root=NULL WHERE id='github'");
  await observe(
    "standalone reader keeps center invariant error",
    {},
    { rejected: true },
  );
  await snapshot("standalone cleanup and invariant state");
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
