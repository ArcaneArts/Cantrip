// Execute the existing deletion helper against recorded transaction results.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyWorkspaceCommand } from "../../packages/protocol/dist/index.js";
import { removeResourceWorkspaceViews } from "../../cantrip_server/src/db/workspace-resource-removal.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { workspaceState } from "./workspace-wire-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy"),
  { getTableColumns } = require("drizzle-orm");
const columns = Object.keys(getTableColumns(schema.workspaceLayouts)),
  cases = [];
let sequence = 0;
function step(initial, action, windowId = "main") {
  return applyWorkspaceCommand(initial, {
    operationId: "oracle-" + sequence++,
    projectId: "github",
    workspaceId: initial.id,
    windowId,
    attachmentGeneration: initial.windows.find((w) => w.id === windowId)
      .attachmentGeneration,
    expectedRevision: initial.revision,
    action,
  }).layout;
}
const base = workspaceState();
const preparing = step(base, {
  type: "prepare-detach",
  transferId: "transfer",
  paneId: "center-a",
  tabId: "a",
  destinationWindowId: "destination",
  destinationPaneId: "destination-pane",
});
const ready = step(
  preparing,
  { type: "transfer-ready", transferId: "transfer" },
  "destination",
);
const restored = step(
  ready,
  { type: "transfer-state-ready", transferId: "transfer" },
  "destination",
);
const committed = step(restored, {
  type: "commit-transfer",
  transferId: "transfer",
});
const returning = step(
  committed,
  {
    type: "prepare-return",
    transferId: "return",
    paneId: "destination-pane",
    splitId: "return-split",
  },
  "destination",
);
const layouts = [
  base,
  preparing,
  ready,
  restored,
  committed,
  returning,
  { ...base, revision: Number.MAX_SAFE_INTEGER },
];
for (const [index, original] of layouts.entries())
  for (const definition of [
    "project.terminal",
    "project.browser",
    "project.explorer",
    "project.file",
    "project.agent",
    "project.code",
    "project.remote-desktop",
  ])
    for (const resource of ["terminal", "retained-terminal", "missing"]) {
      const initial = structuredClone(original);
      for (const window of initial.windows)
        for (const pane of window.panes)
          for (const tab of pane.tabs) {
            tab.resource.definitionId = definition;
            if (definition === "project.file") tab.fileMode = "edit";
          }
      const before = structuredClone(initial);
      let current = initial,
        outcome;
      const database = drizzle(async (source, parameters) => {
        if (source.startsWith('update "workspace_layouts"')) {
          current = JSON.parse(parameters[0]);
          return { rows: [] };
        }
        if (source.includes('from "projects"')) return { rows: [["github"]] };
        assert.ok(source.includes('from "workspace_layouts"'), source);
        return {
          rows: [
            columns.map(
              (key) =>
                ({
                  ownerId: "owner",
                  projectId: "github",
                  workspaceId: initial.id,
                  layout: initial,
                })[key] ?? null,
            ),
          ],
        };
      });
      try {
        await removeResourceWorkspaceViews(
          database,
          "owner",
          "github",
          definition,
          resource,
        );
        outcome = { value: current };
      } catch (error) {
        outcome = {
          error: {
            name: error.name,
            ...(error.code ? { code: error.code } : {}),
            message: error.message,
          },
        };
      }
      assert.deepEqual(
        initial,
        before,
        "cleanup does not mutate its query input",
      );
      cases.push({
        name: `layout ${index} ${definition} ${resource}`,
        initial,
        project: "github",
        definition,
        resource,
        outcome,
      });
    }
console.log(JSON.stringify({ cases }));
