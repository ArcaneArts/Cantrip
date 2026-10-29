// Disposable terminal, pane and ownership records for actual deletion comparisons.
import { json, literal, label, state, stamp } from "./project-target-state.mjs";
import {
  workspaceState,
  workspaceLeaf,
  workspaceSplit,
} from "./workspace-wire-fixtures.mjs";

export function terminalDeletionFixture({ seed, owner }) {
  const clean = async () => {
    await seed(
      "DELETE FROM tab_group_members WHERE group_id IN ('sql-pane','sql-other')",
    );
    await seed("DELETE FROM tab_groups WHERE id IN ('sql-pane','sql-other')");
    await seed(
      "DELETE FROM workspace_layouts WHERE workspace_id='sql-workspace'",
    );
    await seed(
      "DELETE FROM terminals WHERE id IN ('sql-terminal','sql-retained-one','sql-retained-two')",
    );
    await seed("UPDATE projects SET center_layout_root=NULL WHERE id='github'");
  };
  const prepare = async ({
    remaining = 2,
    anchor = true,
    center = false,
  } = {}) => {
    await clean();
    for (const id of ["sql-terminal", "sql-retained-one", "sql-retained-two"])
      await seed(
        `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state,created_at,updated_at) VALUES(${literal(id)},'github','alpha','github-alpha-main',${json(label("terminal"))},${json(state("terminal-state"))},${literal(stamp)},${literal(stamp)})`,
      );
    const layout = workspaceState("sql-workspace", "sql-terminal");
    layout.windows[0].panes[0].tabs[1].resource.resourceId = "sql-retained-one";
    await seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github','sql-workspace',${json(layout)})`,
    );
    const region = center ? "center" : "bottom";
    for (const [id, position] of [
      ["sql-pane", 0],
      ["sql-other", 1],
    ])
      await seed(
        `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label,created_at,updated_at) VALUES(${literal(id)},'github',${literal(region)},${position},${literal(id === "sql-pane" ? (anchor ? "terminal:sql-terminal" : "terminal:sql-retained-one") : "terminal:sql-retained-two")},${json(label("project-pane"))},${literal(stamp)},${literal(stamp)})`,
      );
    for (const [position, id] of [
      "sql-terminal",
      "sql-retained-one",
      "sql-retained-two",
    ]
      .slice(0, remaining + 1)
      .entries())
      await seed(
        `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES(${literal("terminal:" + id)},'sql-pane','github','terminal',${literal(id)},${position},${literal(stamp)},${literal(stamp)})`,
      );
    if (center)
      await seed(
        `UPDATE projects SET center_layout_root=${json(workspaceSplit("sql-split", workspaceLeaf("sql-pane"), workspaceLeaf("sql-other")))} WHERE id='github'`,
      );
  };
  return { clean, prepare };
}
