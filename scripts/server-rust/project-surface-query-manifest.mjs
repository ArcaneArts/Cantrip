// Export actual repository SQL; controlled rows only select recorder branches.
// Real database comparisons separately establish behavior and transaction scope.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { ExplorerRepository } from "../../cantrip_server/src/db/repository/explorers.ts";
import { CodeSurfaceRepository } from "../../cantrip_server/src/db/repository/code-surfaces.ts";
import { ProjectRepository } from "../../cantrip_server/src/db/repository/projects.ts";
import { ProjectViewRepository } from "../../cantrip_server/src/db/repository/project-views.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { label, state } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns } = require("drizzle-orm");
const tables = ["explorers", "codeTabs", "projectViews", "projectWorktrees"];
const manifest = {
  columns: Object.fromEntries(
    tables.map((key) => [key, Object.keys(getTableColumns(schema[key]))]),
  ),
  queries: {},
};
const values = {
  id: "resource",
  projectId: "project",
  protectedLabel: label("surface"),
  protectedState: state("explorer-state"),
  position: 0,
  activeWorkerId: "worker",
  worktreeId: "tree",
  fileMode: "preview",
  kind: "history",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const row = (table) =>
  manifest.columns[table].map((key) => values[key] ?? null);
let pending = [],
  stopEarly = false;
const stop = new Error("Captured actual Source query prefix");
const type = (value) =>
  value === null || (typeof value === "string" && /^[{[]/u.test(value))
    ? "jsonb"
    : typeof value === "number"
      ? "integer"
      : typeof value === "boolean"
        ? "boolean"
        : typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/u.test(value)
          ? "timestamptz"
          : "text";
const database = new Proxy(
  drizzle(async (source, parameters) => {
    const next = pending.shift();
    assert.ok(next, "Unexpected Source SQL: " + source);
    const [key, rows] = next;
    const query = { source, types: parameters.map(type) };
    if (manifest.queries[key])
      assert.deepEqual(query, manifest.queries[key], key);
    manifest.queries[key] = query;
    if (stopEarly && !pending.length) throw stop;
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
const context = {
  explorerId: "resource",
  projectId: "project",
  workerId: "worker",
  worktreeId: "tree",
  root: ".",
  codeTab: { projectId: "project" },
};
const collaborators = {
  getExplorerExecutionContext: async () => context,
  getCodeTabExecutionContext: async () => context,
  getProjectWorktreeContext: async () => ({
    workerId: "worker",
    worktree: { id: "tree", lifecycleState: "ready" },
  }),
  getProjectSource: async () => ({ worktreeId: "tree" }),
  resolveProjectExecutionPlacement: async () => ({
    placement: { workerId: "worker", worktreeId: "tree" },
  }),
  nextProjectTabPosition: async () => 0,
  toExplorerWireSummary: (value) => value,
};
const explorer = new ExplorerRepository(database, collaborators),
  code = new CodeSurfaceRepository(database, collaborators),
  view = new ProjectViewRepository(database, collaborators);
async function capture(fn, queries, prefix = false) {
  pending = queries;
  stopEarly = prefix;
  if (prefix) await assert.rejects(fn, (e) => e === stop || e.cause === stop);
  else await fn();
  assert.equal(pending.length, 0, "Expected queries actually executed");
}
for (const [key, repo, table, list, create, update, worktree] of [
  [
    "explorer",
    explorer,
    "explorers",
    "listExplorers",
    "createExplorer",
    "updateExplorer",
    "updateExplorerWorktree",
  ],
  [
    "code",
    code,
    "codeTabs",
    "listCodeTabs",
    "createCodeTab",
    "updateCodeTab",
    "updateCodeTabWorktree",
  ],
  [
    "view",
    view,
    "projectViews",
    "listProjectViews",
    "createProjectView",
    "updateProjectView",
    "updateProjectViewWorktree",
  ],
]) {
  await capture(() => repo[list]("owner", "project"), [[key + "_list", []]]);
  await capture(
    () =>
      repo[create]("owner", "project", {
        id: "resource",
        titleProtection: values.protectedLabel,
        stateProtection: values.protectedState,
        kind: "history",
      }),
    [[key + "_create", []]],
    true,
  );
  const owned = key === "view" ? [["view_owned", [["resource"]]]] : [];
  await capture(
    () =>
      repo[update]("owner", "resource", {
        titleProtection: values.protectedLabel,
      }),
    [...owned, [key + "_update", [row(table)]]],
  );
  const selected = key === "code" ? [] : [[key + "_selected", [row(table)]]];
  await capture(
    () =>
      repo[worktree]("owner", "resource", {
        worktreeId: "tree",
        stateProtection: values.protectedState,
      }),
    [...selected, [key + "_worktree", [row(table)]]],
  );
}
await capture(
  () => code.updateCodeTab("owner", "resource", {}),
  [["code_update_empty", [row("codeTabs")]]],
);
await capture(
  () => explorer.getExplorerExecutionContext("owner", "resource"),
  [["explorer_context", []]],
);
await capture(
  () => code.getCodeTabExecutionContext("owner", "resource"),
  [["code_context", []]],
);
await capture(
  () => view.getProjectViewProjectId("owner", "resource"),
  [["view_project", []]],
);
await capture(
  () =>
    explorer.updateExplorerViewState("owner", "resource", {
      stateProtection: values.protectedState,
      fileMode: "pinned",
    }),
  [["explorer_state", [row("explorers")]]],
);
await capture(
  () =>
    explorer.pinExplorer("owner", "resource", {
      titleProtection: values.protectedLabel,
      stateProtection: values.protectedState,
      fileMode: "pinned",
    }),
  [
    ["explorer_pin_select", [row("explorers")]],
    ["explorer_members", []],
    ["explorer_pin", []],
  ],
  true,
);
// Deletion cleanup is shared with the already exported resource-layout queries.
// Drive its actual empty-layout branches rather than replacing those helpers.
for (const [key, repo, method, table] of [
  ["explorer", explorer, "deleteExplorer", "explorers"],
  ["code", code, "deleteCodeTab", "codeTabs"],
  ["view", view, "deleteProjectView", "projectViews"],
]) {
  await capture(
    () => repo[method]("owner", "resource"),
    [
      ...(key === "view" ? [["view_selected", [row(table)]]] : []),
      ["cleanup_project", []],
      ["detach_project", [["project"]]],
      ["detach_member", []],
      ...(key === "view" ? [["view_surface_delete", []]] : []),
      [
        key + "_delete",
        key === "explorer" || key === "view" ? [["resource"]] : [],
      ],
    ],
  );
}
await capture(
  () =>
    new ProjectRepository(database, {}).getProjectSource("owner", "project"),
  [["view_source", [["replica", "worker", ".", "tree"]]]],
);
const destination = new URL(
  "../../cantrip_server_rs/src/project_surfaces/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
