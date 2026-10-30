// Record statements and parameter order by executing the actual repositories.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as protocol from "../../packages/protocol/dist/index.js";
import { WorkspaceLayoutRepository } from "../../cantrip_server/src/db/workspace-layouts.ts";
import { resolveEntitySurface } from "../../cantrip_server/src/db/tab-layouts.ts";
import { validateWorkspaceDocumentMigration } from "../../cantrip_server/src/db/workspace-document-migration.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
import { projectLabel } from "./security-fixtures.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns, getTableName } = require("drizzle-orm");
const tables = [
  "workspaceLayouts",
  "workspaceCommandReceipts",
  "projects",
  "tabGroups",
  "tabGroupMembers",
  "chats",
  "terminals",
  "explorers",
  "browsers",
  "codeTabs",
  "projectViews",
  "projectBuiltInSurfaceStates",
  "projectDockPresentationPreferences",
];
const manifest = {
  columns: Object.fromEntries(
    tables.map((key) => [key, Object.keys(getTableColumns(schema[key]))]),
  ),
  tableNames: Object.fromEntries(
    tables.map((key) => [key, getTableName(schema[key])]),
  ),
  surfaceDefinitions: protocol.PROJECT_SURFACE_DEFINITIONS.map((d) => ({
    id: d.id,
    supportedPlacements: d.supportedPlacements,
    tabKind: protocol.projectSurfaceTabKind({
      kind: "entity",
      definitionId: d.id,
      resourceId: "resource",
    }),
  })),
  queries: {},
};
const names = Object.fromEntries(
  Object.entries(manifest.tableNames).map(([key, value]) => [value, key]),
);
const base = () => ({ ...workspaceState(), projectId: "project" });
let phase,
  layout = base(),
  present = true,
  receipt,
  ids = [];
function fullRow(table, fields) {
  return manifest.columns[table].map((key) => fields[key] ?? null);
}
function bindings(source, parameters) {
  return parameters.map((value) => {
    if (ids.includes(value))
      return { document: ids.indexOf(value), kind: "text" };
    if (
      [
        "owner",
        "project",
        "workspace",
        "operation",
        "resource",
        "worker",
        "worktree",
      ].includes(value)
    )
      return { key: value, kind: "text" };
    if (typeof value === "string" && /^[{[]/u.test(value)) {
      const data = JSON.parse(value);
      if (data.version === 1 && data.windows)
        return { key: "layout", kind: "jsonb" };
      if (data.operationId) return { key: "command", kind: "jsonb" };
    }
    if (
      source.startsWith('insert into "workspace_command_receipts"') &&
      typeof value === "number"
    )
      return { key: "appliedRevision", kind: "bigint" };
    if (
      [
        "history",
        "graph",
        "issues",
        "prs",
        "actions",
        "remote-desktop",
      ].includes(value)
    )
      return { key: "tabKind", kind: "text" };
    return {
      constant: value,
      kind: typeof value === "number" ? "bigint" : "text",
    };
  });
}
const database = new Proxy(
  drizzle(async (source, parameters) => {
    let key, rows;
    const table = /\bfrom "([^"]+)"/u.exec(source)?.[1];
    if (source.startsWith('insert into "workspace_layouts"')) {
      key = "insert";
      layout = JSON.parse(
        parameters.find(
          (p) => typeof p === "string" && p.startsWith('{"version"'),
        ),
      );
      present = true;
      rows = [];
    } else if (source.startsWith('update "workspace_layouts"')) {
      key = "update";
      layout = JSON.parse(parameters[0]);
      rows = [];
    } else if (source.startsWith('insert into "workspace_command_receipts"')) {
      key = "receipt_insert";
      receipt = {
        ownerId: "owner",
        projectId: "project",
        workspaceId: "workspace",
        operationId: "operation",
        command: JSON.parse(
          parameters.find(
            (p) => typeof p === "string" && p.startsWith('{"operationId"'),
          ),
        ),
        appliedRevision: layout.revision,
      };
      rows = [];
    } else if (table === "projects" && source.endsWith("for share")) {
      key = "authority";
      rows = [["project"]];
    } else if (table === "workspace_layouts") {
      key = source.endsWith("for update") ? "locked" : "get";
      rows = present
        ? [
            fullRow("workspaceLayouts", {
              ownerId: "owner",
              projectId: "project",
              workspaceId: "workspace",
              layout,
            }),
          ]
        : [];
    } else if (table === "workspace_command_receipts") {
      key = "receipt_get";
      rows = receipt ? [fullRow("workspaceCommandReceipts", receipt)] : [];
    } else if (phase.startsWith("migration")) {
      if (table === "file_documents") {
        key = "migration_documents_" + ids.length;
        rows = ids.map((id) => [id, "worker", "worktree"]);
      } else {
        key = "migration_" + names[table];
        rows = [
          fullRow(names[table], {
            id: "resource",
            projectId: "project",
            activeWorkerId: "worker",
            worktreeId: "worktree",
            protectedState: {
              classification: { recordKind: "explorer-state" },
              protectedState: projectLabel.protectedLabel,
            },
          }),
        ];
      }
    } else if (table === "file_documents") {
      key = phase === "import" ? "import_document" : "resolve_document";
      rows = phase === "resolve_file_fallback" ? [] : [[parameters[0]]];
    } else if (phase.startsWith("resolve")) {
      key = "resolve_" + names[table];
      rows = [["resource", null]];
    } else if (table === "project_worktrees") {
      key = "builtin_worktree";
      rows = [["worktree"]];
    } else if (table === "projects") {
      key = "legacy_project";
      rows = [["project", 0, null]];
    } else {
      key =
        "legacy_" +
        names[table] +
        (table === "tab_groups" && parameters.includes("center")
          ? "_center"
          : "");
      assert.ok(names[table], "Known actual legacy table: " + source);
      rows = [];
    }
    const query = { source, bindings: bindings(source, parameters) };
    if (manifest.queries[key])
      assert.deepEqual(query, manifest.queries[key], key);
    manifest.queries[key] = query;
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
const repository = new WorkspaceLayoutRepository(database);
phase = "get";
await repository.get("owner", "project", "workspace");
phase = "seed_existing";
await repository.seed("owner", "project", "workspace", "main");
phase = "seed_fresh";
present = false;
await repository.seed("owner", "project", "workspace", "main");
function reset() {
  layout = base();
  present = true;
  receipt = undefined;
  ids = [];
}
reset();
phase = "execute";
const home = {
  operationId: "operation",
  workspaceId: "workspace",
  projectId: "project",
  windowId: "main",
  attachmentGeneration: 1,
  expectedRevision: 4,
  action: { type: "home" },
};
await repository.execute("owner", home);
phase = "execute_replay";
await repository.execute("owner", home);
for (const definition of manifest.surfaceDefinitions.filter((d) => d.tabKind)) {
  phase = "resolve";
  await resolveEntitySurface(database, "project", {
    kind: "entity",
    definitionId: definition.id,
    resourceId: "resource",
  });
}
phase = "resolve_file_fallback";
await resolveEntitySurface(database, "project", {
  kind: "entity",
  definitionId: "project.file",
  resourceId: "resource",
});
reset();
phase = "builtin";
await repository.execute("owner", {
  ...home,
  action: {
    type: "open",
    tab: {
      ...workspaceTab("new"),
      resource: { kind: "builtin", definitionId: "git.history" },
      builtInState: { definitionId: "git.history", worktreeId: "worktree" },
    },
    target: { kind: "pane", paneId: "center-a" },
  },
});
reset();
phase = "import";
ids = ["document-0"];
await repository.importLegacyFiles("owner", "project", "workspace", {
  windowId: "cantrip-editor-import",
  paneId: "import-pane",
  views: [{ tabId: "import-tab", documentId: ids[0], mode: "edit" }],
  expectedRevision: 4,
});
for (const kind of ["code", "explorer"])
  for (const count of [1, 2, 3, 11]) {
    phase = "migration_" + kind;
    ids = Array.from({ length: count }, (_, i) => "document-" + i);
    const common = {
      expectedWorkerId: "worker",
      expectedWorktreeId: "worktree",
      tabId: "tab",
    };
    const views = ids.map((documentId, i) => ({
      tabId: "view-" + i,
      documentId,
      mode: "edit",
    }));
    const action =
      kind === "code"
        ? { ...common, type: "migrate-code-files", codeId: "resource", views }
        : {
            ...common,
            type: "migrate-explorer-file",
            explorerId: "resource",
            expectedStateProtection: {
              classification: { recordKind: "explorer-state" },
              protectedState: projectLabel.protectedLabel,
            },
            documentId: ids[0],
            retainedViews: views.slice(1),
            mode: "edit",
          };
    await validateWorkspaceDocumentMigration(
      database,
      "owner",
      "project",
      action,
    );
  }
const destination = new URL(
  "../../cantrip_server_rs/src/workspace_layouts/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
