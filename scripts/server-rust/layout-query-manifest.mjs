// Capture the actual legacy repository's statements, including update order.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as protocol from "../../packages/protocol/dist/index.js";
import { ProjectTabLayoutRepository } from "../../cantrip_server/src/db/tab-layouts.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { projectLabel } from "./security-fixtures.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns } = require("drizzle-orm");
const manifest = {
  columns: Object.fromEntries(
    ["tabGroups", "tabGroupMembers", "projectSurfaceLauncherPreferences"].map(
      (key) => [key, Object.keys(getTableColumns(schema[key]))],
    ),
  ),
  definitions: protocol.PROJECT_SURFACE_DEFINITIONS.map((definition) => ({
    ...definition,
    tabKind: protocol.projectSurfaceTabKind({
      kind: "entity",
      definitionId: definition.id,
      resourceId: "resource",
    }),
    profiles: Object.fromEntries(
      protocol.workspaceLayoutProfileSchema.options.map((profile) => [
        profile,
        protocol.workspaceLayoutProfilePlacement(profile, definition.id),
      ]),
    ),
  })),
  queries: {},
};
let pending = [],
  stopEarly = false;
const captureStop = new Error("Completed requested Source statement prefix");
const kind = (value) =>
  value === null || (typeof value === "string" && /^[{[]/u.test(value))
    ? "jsonb"
    : typeof value === "number"
      ? Number.isInteger(value)
        ? "integer"
        : "double precision"
      : typeof value === "boolean"
        ? "boolean"
        : value instanceof Date ||
            (typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/u.test(value))
          ? "timestamptz"
          : "text";
const database = new Proxy(
  drizzle(async (source, parameters) => {
    const expected = pending.shift();
    assert.ok(expected, "Unexpected actual Source query: " + source);
    const [key, rows] = expected;
    const query = { source, types: parameters.map(kind) };
    if (manifest.queries[key])
      assert.deepEqual(query, manifest.queries[key], key);
    manifest.queries[key] = query;
    if (stopEarly && !pending.length) throw captureStop;
    return { rows };
  }),
  {
    get(target, key) {
      return key === "transaction"
        ? async (fn) => fn(database)
        : Reflect.get(target, key);
    },
  },
);
const repository = new ProjectTabLayoutRepository(database);
// Mutations' before/after get is independently covered by the real-store suite.
repository.get = async () => ({
  projectId: "project",
  revision: 4,
  centerRoot: null,
  panes: [],
});
const root = { kind: "pane", paneId: "pane" };
async function capture(fn, queries) {
  stopEarly = false;
  pending = queries;
  await fn();
  assert.equal(pending.length, 0, "Every expected query was executed");
}
async function prefix(fn, queries) {
  stopEarly = true;
  pending = queries;
  await assert.rejects(
    fn,
    (error) => error === captureStop || error.cause === captureStop,
  );
  assert.equal(pending.length, 0, "Actual Source prefix was executed");
  stopEarly = false;
}
const claim = ["claim", [["project"]]],
  pane = ["pane", [["pane"]]];
await capture(
  () =>
    repository.updatePane("owner", "project", "pane", {
      revision: 4,
      titleProtection: projectLabel,
    }),
  [claim, pane, ["title_members", [["a"], ["b"]]], ["pane_title", []]],
);
await capture(
  () =>
    repository.updateDockPresentation("owner", "project", {
      revision: 4,
      tabKey: "a",
      preferredMode: "split",
      splitFraction: 0.32,
      restoreFraction: 0.45,
    }),
  [claim, ["dock_region", [["right"]]], ["dock_write", []]],
);
await capture(
  () =>
    repository.reorderPanes("owner", "project", {
      revision: 4,
      region: "center",
      paneIds: ["pane"],
    }),
  [
    claim,
    ["center_panes", [["pane"]]],
    ["center_read", [[root]]],
    ["center_panes", [["pane"]]],
    ["center_panes", [["pane"]]],
    ["center_write", []],
    ["pane_position", []],
  ],
);
await capture(
  () =>
    repository.reorderLegacyPanes("owner", "project", {
      revision: 4,
      paneIds: ["left", "right", "pane"],
    }),
  [
    claim,
    [
      "all_panes",
      [
        ["pane", "center"],
        ["right", "right"],
        ["left", "left"],
      ],
    ],
    ["center_read", [[root]]],
    ["center_panes", [["pane"]]],
    ["center_panes", [["pane"]]],
    ["center_write", []],
    ["pane_position", []],
    ["pane_position", []],
    ["pane_position", []],
  ],
);
await capture(
  () =>
    repository.reorderMembers("owner", "project", "pane", {
      revision: 4,
      tabKeys: ["b", "a"],
    }),
  [
    claim,
    pane,
    ["member_order", [["a"], ["b"]]],
    ["member_position", []],
    ["member_position", []],
  ],
);
await capture(
  () => repository.listSurfaceLaunchers("owner", "project"),
  [
    ["owned", [["project"]]],
    ["launcher_preferences", []],
  ],
);
const definition = protocol.PROJECT_SURFACE_DEFINITIONS.find(
  (d) => d.launcherLocations.length,
);
await capture(
  () =>
    repository.setSurfaceLauncherPin("owner", "project", {
      definitionId: definition.id,
      location: definition.launcherLocations[0],
      pinned: true,
    }),
  [
    ["owned", [["project"]]],
    ["launcher_preferences", []],
    ["launcher_pin", []],
  ],
);
await capture(
  () =>
    repository.updateBuiltInSurfaceWorktree(
      "owner",
      "project",
      "git.history",
      "worktree",
    ),
  [
    ["builtin_worktree", [["worktree"]]],
    ["builtin_write", []],
  ],
);
const stamp = "2020-01-02T03:04:05.000Z";
const group = (id = "pane", anchor = "a", region = "center") => ({
  id,
  projectId: "project",
  region,
  position: 0,
  anchorTabKey: anchor,
  protectedLabel: null,
  createdAt: stamp,
  updatedAt: stamp,
});
const member = (key) => ({
  tabKey: key,
  projectId: "project",
  groupId: "pane",
  tabKind: "terminal",
  tabId: key,
  position: 0,
  createdAt: stamp,
  updatedAt: stamp,
});
const full = (table, fields) =>
  manifest.columns[table].map((k) => fields[k] ?? null);
const selected = (anchor = "a") => [
  "selected_member",
  [
    [
      ...full("tabGroupMembers", member("a")),
      ...full("tabGroups", group("pane", anchor)),
    ],
  ],
];
const region = ["region_panes", [full("tabGroups", group())]];
const members = (count) => [
  "source_members",
  ["a", "b", "c", "d"]
    .slice(0, count)
    .map((k) => full("tabGroupMembers", member(k))),
];
const move = (input) =>
  repository.moveMember("owner", "project", {
    revision: 4,
    tabKey: "a",
    targetPaneId: null,
    targetPanePosition: 0,
    targetMemberPosition: 0,
    ...input,
  });
await prefix(
  () => move({ targetRegion: "right" }),
  [
    claim,
    selected(),
    region,
    members(1),
    ["region_panes", []],
    ["pane_region", []],
  ],
);
for (const [count, anchor, key] of [
  [2, "a", "group_anchor_label"],
  [3, "a", "group_anchor"],
  [2, "b", "group_label"],
]) {
  await prefix(
    () => move({}),
    [
      claim,
      selected(anchor),
      region,
      members(count),
      ["delete_member", []],
      ...Array.from({ length: count - 1 }, () => ["member_position", []]),
      [key, []],
    ],
  );
}
await prefix(
  () => move({}),
  [
    claim,
    selected("b"),
    region,
    members(4),
    ["delete_member", []],
    ["member_position", []],
    ["member_position", []],
    ["member_position", []],
    ["insert_pane", []],
    ["insert_member_copy", []],
  ],
);
await prefix(
  () => move({ targetPaneId: "target" }),
  [
    claim,
    selected(),
    region,
    members(1),
    ["target_pane", [full("tabGroups", group("target", "b"))]],
    ["delete_member", []],
    ["delete_pane", []],
  ],
);
await prefix(
  () =>
    repository.splitMember("owner", "project", {
      revision: 4,
      tabKey: "a",
      targetPaneId: "pane",
      edge: "right",
      fraction: 0.5,
    }),
  [
    claim,
    selected("b"),
    ["target_pane", [full("tabGroups", group())]],
    ["center_read", [[root]]],
    ["center_panes", [["pane"]]],
    members(3),
    ["delete_member", []],
    ["member_position", []],
    ["member_position", []],
    ["group_touch", []],
  ],
);
repository.get = async () => ({
  projectId: "project",
  revision: 4,
  centerRoot: root,
  panes: [{ id: "pane", members: [{ tabKey: "a" }] }],
});
await prefix(
  () =>
    repository.closeSurfaceView("owner", "project", {
      revision: 4,
      viewId: "a",
    }),
  [
    claim,
    selected(),
    ["delete_member", []],
    ["remaining_member_keys", []],
    ["delete_pane", []],
    ["center_read", [[root]]],
    ["center_panes", []],
    ["center_write", []],
    ["groups_remaining", []],
  ],
);
repository.get = async () => ({
  projectId: "project",
  revision: 4,
  centerRoot: null,
  panes: [],
});
await prefix(
  () =>
    repository.openSurfaceView("owner", "project", {
      revision: 4,
      surfaceRef: { kind: "builtin", definitionId: "project.tasks" },
      targetPaneId: "pane",
    }),
  [
    claim,
    ["builtin_create", []],
    ["attach_pane", [["pane", "center"]]],
    ["last_member_position", [[2]]],
    ["insert_member", []],
  ],
);
await prefix(
  () =>
    repository.openSurfaceView("owner", "project", {
      revision: 4,
      surfaceRef: { kind: "builtin", definitionId: "project.tasks" },
    }),
  [
    claim,
    ["builtin_create", []],
    ["placement_profile", [["hybrid"]]],
    ["region_panes", []],
    ["insert_pane", []],
    ["insert_member", []],
  ],
);
const destination = new URL(
  "../../cantrip_server_rs/src/pane_layouts/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
