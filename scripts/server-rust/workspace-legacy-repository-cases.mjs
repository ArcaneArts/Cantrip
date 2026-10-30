import assert from "node:assert/strict";
import { label, literal, json, stamp } from "./project-target-state.mjs";

export async function workspaceLegacyRepositoryCases({
  observe,
  seed,
  snapshot,
}) {
  const centre = "legacy-centre",
    right = "legacy-right",
    bottom = "legacy-bottom";
  const leaf = (paneId) => ({ kind: "pane", paneId });
  const group = async (id, region, position, anchor, title = null) =>
    seed(
      `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label,created_at,updated_at) VALUES(${literal(id)},'github',${literal(region)},${position},${literal(anchor)},${json(title)},${literal(stamp)},${literal(stamp)})`,
    );
  const member = async (groupId, kind, id, key, position) =>
    seed(
      `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES(${literal(key)},${literal(groupId)},'github',${literal(kind)},${literal(id)},${position},${literal(stamp)},${literal(stamp)})`,
    );
  const seeding = (
    name,
    workspace = "seeded",
    input = { mainWindowId: "seed-main" },
    options = {},
  ) => observe(name, { op: "workspace-seed", workspace, input }, options);
  await observe(
    "missing project cannot seed ownership",
    {
      op: "workspace-seed",
      project: "missing",
      workspace: "missing",
      input: { mainWindowId: "seed-main" },
    },
    { expected: null },
  );
  await observe(
    "foreign owner cannot seed ownership",
    {
      op: "workspace-seed",
      owner: "11111111-1111-4111-8111-111111111111",
      workspace: "foreign",
      input: { mainWindowId: "seed-main" },
    },
    { expected: null },
  );
  const empty = await observe(
    "empty legacy project seeds a real empty window",
    {
      op: "workspace-seed",
      project: "folder",
      workspace: "empty",
      input: { mainWindowId: "empty-main" },
    },
  );
  assert.deepEqual(empty.windows[0].panes, []);
  assert.equal(empty.windows[0].centerRoot, null);
  await group(centre, "center", 0, "chat:chat", label("tab-group"));
  const entities = [
    ["chat", "chat", "chat:chat"],
    ["terminal", "terminal", "terminal:terminal"],
    ["explorer", "explorer", "explorer:explorer"],
    ["browser", "browser", "browser:browser"],
    ["code", "code", "code:code"],
    ["remote-desktop", "desktop", "view:desktop"],
    ["builtin", "git.history", "builtin:github:git.history"],
  ];
  for (const [position, [kind, id, key]] of entities.entries())
    await member(centre, kind, id, key, position);
  await group(right, "right", 0, "terminal:�");
  await member(right, "terminal", "�", "terminal:�", 0);
  await group(bottom, "bottom", 0, "builtin:github:git.graph");
  await member(bottom, "builtin", "git.graph", "builtin:github:git.graph", 0);
  for (const [definition, tree] of [
    ["git.history", "github-alpha-main"],
    ["git.graph", null],
  ])
    await seed(
      `INSERT INTO project_builtin_surface_states(project_id,definition_id,worktree_id,created_at,updated_at) VALUES('github',${literal(definition)},${literal(tree)},${literal(stamp)},${literal(stamp)})`,
    );
  await seed(
    `INSERT INTO project_dock_presentation_preferences(project_id,tab_key,region,preferred_mode,split_fraction,restore_fraction,created_at,updated_at) VALUES('github','terminal:�','right','split',0.45,0.41,${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `UPDATE projects SET tab_layout_revision=17,center_layout_root=${json(leaf(centre))} WHERE id='github'`,
  );
  const input = {
    mainWindowId: "seed-main",
    activeTabByPane: { [centre]: "browser:browser" },
    focusedPaneId: centre,
    detachedPanes: [{ paneId: right, windowId: "legacy-detached" }],
  };
  const first = await seeding(
    "server-owned legacy resources, labels, focus and detached panes",
    "seeded",
    input,
  );
  assert.deepEqual(
    first.windows[0].panes[0].tabs.map((t) => t.resource.definitionId),
    [
      "project.agent",
      "project.terminal",
      "project.explorer",
      "project.browser",
      "project.code",
      "project.remote-desktop",
      "git.history",
    ],
  );
  assert.equal(
    first.windows[0].panes[0].activeTabId,
    "tab:seeded:browser%3Abrowser",
  );
  assert.deepEqual(first.windows[1].panes[0].tabs[0].dockPresentation, {
    preferredMode: "split",
    splitFraction: 0.45,
    restoreFraction: 0.41,
  });
  await seeding(
    "existing ownership ignores new legacy observations",
    "seeded",
    {
      mainWindowId: "seed-main",
      focusedPaneId: "missing",
      detachedPanes: [{ paneId: "missing", windowId: "other" }],
    },
    { expected: first },
  );
  await seeding(
    "seed cannot replace committed main-window identity",
    "seeded",
    { mainWindowId: "other" },
    { rejected: true, code: "scope" },
  );
  await snapshot("legacy seed retains original placement and revision");

  const overview = "builtin:github:project.overview";
  await member(centre, "builtin", "project.overview", overview, 7);
  await seed(
    `UPDATE tab_groups SET anchor_tab_key=${literal(overview)} WHERE id=${literal(centre)}`,
  );
  await seeding(
    "legacy Overview anchor retires before schema validation",
    "overview-anchor",
    { mainWindowId: "overview-main" },
  );
  const anchor = await snapshot(
    "Overview cleanup repairs anchor and bumps exactly once",
  );
  assert.equal(anchor.legacyProject.revision, 18);
  assert.equal(
    anchor.groups.find((g) => g.id === centre).anchor_tab_key,
    "chat:chat",
  );
  assert.deepEqual(
    anchor.groups.find((g) => g.id === centre).protected_label,
    label("tab-group"),
  );

  const retired = "legacy-overview-pane";
  await group(retired, "center", 1, overview);
  await member(retired, "builtin", "project.overview", overview, 0);
  await seed(
    `UPDATE projects SET center_layout_root=${json({ kind: "split", id: "legacy-overview-split", direction: "horizontal", fraction: 0.4, first: leaf(centre), second: leaf(retired) })} WHERE id='github'`,
  );
  await seeding(
    "empty Overview pane is removed with its topology",
    "overview-empty",
    { mainWindowId: "overview-empty-main" },
  );
  const removed = await snapshot(
    "Overview empty-pane removal retains other panes",
  );
  assert.equal(removed.legacyProject.revision, 19);
  assert.deepEqual(removed.legacyProject.root, leaf(centre));
  assert.equal(
    removed.groups.some((g) => g.id === retired),
    false,
  );

  await seed(
    `DELETE FROM tab_group_members WHERE group_id=${literal(centre)} AND tab_key!='terminal:terminal'`,
  );
  await seed(
    `UPDATE tab_group_members SET position=0 WHERE tab_key='terminal:terminal'`,
  );
  await seed(
    `UPDATE tab_groups SET anchor_tab_key='terminal:terminal' WHERE id=${literal(centre)}`,
  );
  await member(centre, "builtin", "project.overview", overview, 1);
  await seeding(
    "single remaining member derives its own title",
    "overview-single",
    { mainWindowId: "overview-single-main" },
  );
  const single = await snapshot(
    "Overview single-member repair clears only group title",
  );
  assert.equal(single.legacyProject.revision, 20);
  assert.equal(
    single.groups.find((g) => g.id === centre).protected_label,
    null,
  );
  await seed(`UPDATE projects SET center_layout_root=null WHERE id='github'`);
  await seeding(
    "existing workspace survives invalid legacy topology",
    "seeded",
    { mainWindowId: "seed-main" },
    { expected: first },
  );
  await seeding(
    "fresh seed checks actual legacy topology",
    "invalid-legacy",
    { mainWindowId: "invalid-main" },
    {
      rejected: true,
      message:
        "The center layout tree does not exactly match its center panes.",
    },
  );
  await seed(
    `UPDATE projects SET center_layout_root=${json(leaf(centre))} WHERE id='github'`,
  );
  await member(centre, "builtin", "project.overview", overview, 1);
  const beforeFailure = await snapshot(
    "Overview before injected cleanup failure",
  );
  await seed(
    "CREATE FUNCTION workspace_overview_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.tab_id='project.overview' THEN RAISE EXCEPTION 'controlled workspace Overview cleanup failure'; END IF; RETURN OLD; END $$",
  );
  await seed(
    "CREATE TRIGGER workspace_overview_reject BEFORE DELETE ON tab_group_members FOR EACH ROW EXECUTE FUNCTION workspace_overview_reject()",
  );
  try {
    await seeding(
      "Overview cleanup failure rolls back its nested transaction",
      "overview-failure",
      { mainWindowId: "overview-failure-main" },
      { rejected: true },
    );
    const afterFailure = await snapshot(
      "Overview cleanup rollback retains revision and members",
    );
    assert.deepEqual(afterFailure, beforeFailure);
  } finally {
    await seed("DROP TRIGGER workspace_overview_reject ON tab_group_members");
    await seed("DROP FUNCTION workspace_overview_reject()");
  }
  await seeding(
    "Overview cleanup succeeds after its actual failure is removed",
    "overview-retry",
    { mainWindowId: "overview-retry-main" },
  );
  const retried = await snapshot(
    "Overview retry bumps only its committed cleanup",
  );
  assert.equal(retried.legacyProject.revision, 21);
}
