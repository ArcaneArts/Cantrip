// Execute the real shared transforms; never reconstruct expected ownership here.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  seedWorkspaceOwnership,
  importWorkspaceLegacyFiles,
  applyWorkspaceCommand,
} from "../../packages/protocol/dist/index.js";
import { workspaceCommandModelCases } from "./workspace-command-model-cases.mjs";
import { projectLabel } from "./security-fixtures.mjs";
import { workspaceLegacyLayout } from "./workspace-layout-wire-fixtures.mjs";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";

const cases = [];
function add(name, operation, data) {
  const before = structuredClone(data);
  let outcome;
  try {
    const value =
      operation === "seed"
        ? seedWorkspaceOwnership(data.input)
        : operation === "strict"
          ? isDeepStrictEqual(JSON.parse(data.left), JSON.parse(data.right))
          : operation === "apply"
            ? applyWorkspaceCommand(data.initial, data.input)
            : importWorkspaceLegacyFiles(
                data.initial,
                data.input,
                new Map(Object.entries(data.titles)),
              );
    outcome = { value };
  } catch (error) {
    outcome = {
      error: {
        name: error.name,
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      },
    };
  }
  assert.deepEqual(data, before, name + " leaves its input intact");
  cases.push({ name, operation, ...data, outcome });
}
const input = {
  workspaceId: "workspace",
  mainWindowId: "main",
  legacy: workspaceLegacyLayout(projectLabel),
};
const seed = (name, edit = () => {}) => {
  const value = structuredClone(input);
  edit(value);
  add(name, "seed", { input: value });
};
seed("all legacy resources and dock state");
seed("selected tab and pane", (v) => {
  v.activeTabByPane = { "center-a": "terminal:second" };
  v.focusedPaneId = "center-a";
});
seed("unavailable selection falls back", (v) => {
  v.activeTabByPane = { "center-a": "missing" };
  v.focusedPaneId = "missing";
});
for (const paneId of ["center-a", "right-pane", "bottom-pane", "missing"])
  seed("detached " + paneId, (v) => {
    v.focusedPaneId = paneId;
    v.detachedPanes = [{ paneId, windowId: "detached" }];
  });
seed("all panes detached", (v) => {
  v.detachedPanes = v.legacy.panes.map((p, i) => ({
    paneId: p.id,
    windowId: "detached-" + i,
  }));
});
seed("duplicate detached pane", (v) => {
  v.detachedPanes = [
    { paneId: "center-a", windowId: "one" },
    { paneId: "center-a", windowId: "two" },
  ];
});
seed("duplicate detached window", (v) => {
  v.detachedPanes = [
    { paneId: "center-a", windowId: "same" },
    { paneId: "right-pane", windowId: "same" },
  ];
});
seed("main window cannot be detached destination", (v) => {
  v.detachedPanes = [{ paneId: "center-a", windowId: "main" }];
});
seed("empty detached destination", (v) => {
  v.detachedPanes = [{ paneId: "center-a", windowId: "" }];
});
for (const identity of [
  "colon:slash/percent%",
  "emoji😀é",
  "-_.!~*'()",
  "\u0000",
  "\ud800",
])
  seed("encoded identity " + JSON.stringify(identity), (v) => {
    v.workspaceId = identity;
    v.legacy.panes[0].members[0].tabKey = identity;
    v.legacy.panes[0].anchorTabKey = identity;
  });
seed("no panes", (v) => {
  v.legacy.panes = [];
  v.legacy.centerRoot = null;
});
seed("omitted topology is checked by ownership", (v) => {
  delete v.legacy.centerRoot;
});
seed("invalid containing pane", (v) => {
  v.legacy.panes[0].members[0].paneId = "other";
});
seed("invalid member project", (v) => {
  v.legacy.panes[0].members[0].projectId = "other";
});
seed("duplicate surface view", (v) => {
  v.legacy.panes[0].members[1].tabKey = v.legacy.panes[0].members[0].tabKey;
});
seed("wrong encrypted title classification", (v) => {
  v.legacy.panes[1].members[0].titleProtection.classification.recordKind =
    "terminal";
});
seed("optional member presentation", (v) => {
  delete v.legacy.panes[0].members[0].builtInState;
  delete v.legacy.panes[0].members[0].dockPresentation;
});
const existing = seedWorkspaceOwnership(input);
seed("existing snapshot is retained", (v) => {
  v.existing = existing;
  v.activeTabByPane = { "center-a": "terminal:second" };
});
for (const key of ["workspaceId", "mainWindowId"])
  seed("existing scope " + key, (v) => {
    v.existing = existing;
    v[key] = "different";
  });
seed("existing project scope", (v) => {
  v.existing = existing;
  v.legacy.projectId = "other";
});

const initial = workspaceState();
const request = {
  windowId: "cantrip-editor-import",
  paneId: "imported-pane",
  views: [{ tabId: "imported-tab", documentId: "document", mode: "edit" }],
};
const imported = importWorkspaceLegacyFiles(
  initial,
  request,
  new Map([["document", null]]),
).layout;
function importing(name, edit = () => {}) {
  const data = structuredClone({
    initial,
    input: request,
    titles: { document: null },
  });
  edit(data);
  add(name, "import", data);
}
importing("import immutable document");
importing("import several document modes and labels", (v) => {
  v.input.views.push({
    tabId: "second-import",
    documentId: "second",
    mode: "visual",
  });
  v.titles.second = projectLabel;
});
importing("missing document authorization", (v) => {
  v.titles = {};
});
importing("duplicate document", (v) => {
  v.input.views.push({
    tabId: "other-tab",
    documentId: "document",
    mode: "preview",
  });
});
importing("exact replay needs no current documents", (v) => {
  v.initial = imported;
  v.titles = {};
});
importing("replay after imported window closes", (v) => {
  v.initial = structuredClone(imported);
  v.initial.windows = v.initial.windows.filter(
    (w) => w.id !== request.windowId,
  );
  v.titles = {};
});
importing("replay cannot change mode", (v) => {
  v.initial = imported;
  v.input.views[0].mode = "preview";
});
importing("replay cannot change pane identity", (v) => {
  v.initial = imported;
  v.input.paneId = "another";
});
importing("window already belongs to workspace", (v) => {
  v.initial.windows[1].id = request.windowId;
});
importing("document already has a view", (v) => {
  v.initial.windows[0].panes[0].tabs[0] = workspaceTab(
    "a",
    "document",
    "project.file",
  );
});
importing("tab identity already in use", (v) => {
  v.input.views[0].tabId = "a";
});
importing("pane identity already in use", (v) => {
  v.input.paneId = "center-a";
});
importing("revision exhaustion", (v) => {
  v.initial.revision = Number.MAX_SAFE_INTEGER;
});
importing("pure import rejects a transport-only revision", (v) => {
  v.input.expectedRevision = 4;
});
importing("unpaired UTF16 identities survive", (v) => {
  v.input.views[0].documentId = "\ud800";
  v.input.views[0].tabId = "\udfff";
  v.titles = { "\ud800": null };
});
for (const [left, right] of [
  ['{"a":-0}', '{"a":0}'],
  ["[-0]", "[0]"],
  ['{"b":1,"a":2}', '{"a":2,"b":1}'],
  ['{"a":null}', "{}"],
  ["[1,2]", "[2,1]"],
  ['{"a":[-0]}', '{"a":[-0]}'],
  ["9007199254740993", "9007199254740992"],
  ["1e999", "null"],
  ["1e999", "1e999"],
])
  add("strict JSON " + left + " / " + right, "strict", { left, right });
workspaceCommandModelCases(add);
console.log(JSON.stringify({ cases }));
