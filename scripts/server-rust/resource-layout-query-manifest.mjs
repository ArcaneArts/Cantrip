// Execute the actual shared helpers against an ORM transport that records SQL.
// Row stubs select branches; they do not generate SQL or implement transitions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { detachProjectTab } from "../../cantrip_server/src/db/tab-layouts.ts";
import { removeResourceWorkspaceViews } from "../../cantrip_server/src/db/workspace-resource-removal.ts";
import {
  workspaceState,
  workspaceSplit,
  workspaceLeaf,
} from "./workspace-wire-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy"),
  { getTableColumns } = require("drizzle-orm");
const manifest = {};
function record(key, query) {
  if (manifest[key])
    assert.equal(query, manifest[key], key + " has one source statement shape");
  manifest[key] = query;
}
const row = (table, values) =>
  Object.keys(getTableColumns(table)).map((key) => values[key] ?? null);
let phase,
  remaining,
  anchor,
  region,
  deleted = false;
const pane = "fixture-pane",
  project = "fixture-project",
  tab = "terminal:fixture-terminal";
const root = workspaceSplit(
  "fixture-split",
  workspaceLeaf(pane),
  workspaceLeaf("fixture-other"),
);
const database = drizzle(async (query, params) => {
  const select = query.startsWith("select ");
  if (select && query.includes('from "workspace_layouts"')) {
    record("workspace_rows", query);
    const layout = workspaceState("fixture-workspace", "fixture-terminal");
    layout.projectId = project;
    return {
      rows: [
        row(schema.workspaceLayouts, {
          ownerId: "fixture-owner",
          projectId: project,
          workspaceId: layout.id,
          layout,
        }),
      ],
    };
  }
  if (query.startsWith('update "workspace_layouts"')) {
    record("workspace_update", query);
    return { rows: [] };
  }
  if (select && query.includes('from "projects"')) {
    if (query.includes('"center_layout_root"')) {
      record("center_read", query);
      return { rows: [[root]] };
    }
    record(
      phase === "workspace" ? "workspace_project_lock" : "layout_project_lock",
      query,
    );
    return { rows: [[project]] };
  }
  if (select && query.includes('from "tab_group_members"')) {
    if (query.includes("inner join")) {
      record("member_select", query);
      return {
        rows: [
          [
            ...row(schema.tabGroupMembers, {
              tabKey: tab,
              groupId: pane,
              projectId: project,
              tabKind: "terminal",
              tabId: "fixture-terminal",
              position: 0,
            }),
            ...row(schema.tabGroups, {
              id: pane,
              projectId: project,
              region,
              position: 0,
              anchorTabKey: anchor,
            }),
          ],
        ],
      };
    }
    record("members_remaining", query);
    return { rows: remaining.map((key) => [key]) };
  }
  if (query.startsWith('delete from "tab_group_members"')) {
    record("member_delete", query);
    return { rows: [] };
  }
  if (query.startsWith('delete from "tab_groups"')) {
    record("group_delete", query);
    deleted = true;
    return { rows: [] };
  }
  if (select && query.includes('from "tab_groups"')) {
    record(
      query.includes("order by") ? "groups_remaining" : "center_panes",
      query,
    );
    return {
      rows: deleted ? [["fixture-other"]] : [[pane], ["fixture-other"]],
    };
  }
  if (query.startsWith('update "tab_groups"')) {
    record(
      query.includes('"position" =')
        ? "group_position"
        : query.includes('"protected_label" =')
          ? query.includes('"anchor_tab_key" =')
            ? "group_anchor_label"
            : "group_label"
          : "group_anchor",
      query,
    );
    return { rows: [] };
  }
  if (query.startsWith('update "tab_group_members"')) {
    record("member_position", query);
    return { rows: [] };
  }
  if (query.startsWith('update "projects"')) {
    record(
      query.includes('"center_layout_root" =')
        ? "center_update"
        : "project_revision",
      query,
    );
    return { rows: [] };
  }
  throw new Error(
    "Unexpected actual helper query: " +
      query +
      " params: " +
      JSON.stringify(params),
  );
});
phase = "workspace";
await removeResourceWorkspaceViews(
  database,
  "fixture-owner",
  project,
  "project.terminal",
  "fixture-terminal",
);
phase = "detach";
for (const scenario of [
  { region: "bottom", remaining: [], anchor: tab },
  { region: "center", remaining: [], anchor: tab },
  { region: "bottom", remaining: ["terminal:one"], anchor: tab },
  {
    region: "bottom",
    remaining: ["terminal:one", "terminal:two"],
    anchor: tab,
  },
  { region: "bottom", remaining: ["terminal:one"], anchor: "terminal:one" },
]) {
  ({ region, remaining, anchor } = scenario);
  deleted = false;
  await detachProjectTab(database, project, tab);
}
const memberColumns = Object.keys(getTableColumns(schema.tabGroupMembers)),
  groupColumns = Object.keys(getTableColumns(schema.tabGroups)),
  workspaceColumns = Object.keys(getTableColumns(schema.workspaceLayouts));
const captured = {
  queries: manifest,
  columns: {
    group_id: memberColumns.length + groupColumns.indexOf("id"),
    group_region: memberColumns.length + groupColumns.indexOf("region"),
    group_anchor: memberColumns.length + groupColumns.indexOf("anchorTabKey"),
    workspace_id: workspaceColumns.indexOf("workspaceId"),
    workspace_layout: workspaceColumns.indexOf("layout"),
  },
};
const destination = new URL(
  "../../cantrip_server_rs/src/database/resource_layout_queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(captured, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(captured, JSON.parse(await readFile(destination, "utf8")));
else console.log(JSON.stringify(captured, null, 2));
