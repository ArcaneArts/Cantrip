// Stored metadata only; no plaintext document, terminal or browser contents.
export const workspaceTab = (
  id,
  resourceId = "terminal",
  definitionId = "project.terminal",
) => ({
  id,
  resource: { kind: "entity", definitionId, resourceId },
  preview: false,
  titleProtection: null,
  builtInState: null,
  dockPresentation: null,
});
export const workspacePane = (id, tabs, region = "center") => ({
  id,
  region,
  titleProtection: null,
  tabs,
  activeTabId: tabs[0].id,
});
export const workspaceLeaf = (paneId) => ({ kind: "pane", paneId });
export const workspaceSplit = (id, first, second) => ({
  kind: "split",
  id,
  direction: "horizontal",
  fraction: 0.5,
  first,
  second,
});
export function workspaceState(id = "workspace", resource = "terminal") {
  const first = workspacePane("center-a", [
    workspaceTab("a", resource),
    workspaceTab("b", "retained-terminal"),
  ]);
  const second = workspacePane("center-b", [workspaceTab("c", resource)]);
  return {
    version: 1,
    id,
    projectId: "github",
    revision: 4,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 1,
        rendererId: "renderer",
        panes: [first, second],
        centerRoot: workspaceSplit(
          "center-split",
          workspaceLeaf(first.id),
          workspaceLeaf(second.id),
        ),
        focusedPaneId: first.id,
        recentPaneIds: [first.id, second.id],
        recentTabIds: ["a", "c", "b"],
      },
      {
        id: "detached",
        attachmentGeneration: 3,
        panes: [
          workspacePane(
            "detached-pane",
            [workspaceTab("detached-tab", resource)],
            "bottom",
          ),
        ],
        centerRoot: null,
        focusedPaneId: "detached-pane",
        recentPaneIds: ["detached-pane"],
      },
    ],
  };
}
export function workspaceOwnershipVariants() {
  const layout = workspaceState();
  const variants = [
    layout,
    { ...layout, windows: [layout.windows[0]], pendingTransfers: [] },
  ];
  const change = (edit) => {
    const value = structuredClone(layout);
    edit(value);
    variants.push(value);
  };
  change((v) => (v.windows[1].id = "main"));
  change((v) => (v.windows[1].panes[0].id = "center-a"));
  change((v) => (v.windows[1].panes[0].tabs[0].id = "a"));
  change((v) => (v.mainWindowId = "missing"));
  change((v) => (v.windows[0].focusedPaneId = "missing"));
  change((v) => v.windows[0].recentPaneIds.push("missing", "center-a"));
  change((v) => v.windows[0].recentTabIds.push("missing", "a"));
  change((v) => (v.windows[0].panes[0].activeTabId = "missing"));
  change((v) => (v.windows[0].centerRoot = workspaceLeaf("missing")));
  change((v) => (v.windows[0].centerRoot.second = workspaceLeaf("center-a")));
  change((v) => (v.windows[0].panes[0].tabs[0].fileMode = "edit"));
  change(
    (v) =>
      (v.windows[0].panes[0].tabs[0].resource.definitionId = "project.tasks"),
  );
  change(
    (v) =>
      (v.legacyCodeImports = [
        {
          tabId: "legacy",
          codeId: "code",
          views: [
            { tabId: "legacy", documentId: "doc", mode: "edit" },
            { tabId: "legacy", documentId: "doc", mode: "edit" },
          ],
        },
      ]),
  );
  const transfer = {
    id: "transfer",
    sourceWindowId: "main",
    sourceGeneration: 1,
    sourcePaneId: "center-a",
    sourcePlacement: {
      panePosition: 0,
      tabPosition: 0,
      region: "center",
      centerRoot: layout.windows[0].centerRoot,
    },
    tabIds: ["a"],
    wholePane: false,
    destinationWindowId: "destination",
    destinationGeneration: 0,
    destinationPaneId: "new-pane",
    phase: "preparing",
  };
  const pending = structuredClone(layout);
  pending.windows.push({
    id: "destination",
    attachmentGeneration: 0,
    panes: [],
    centerRoot: null,
    focusedPaneId: null,
    recentPaneIds: [],
  });
  pending.pendingTransfers = [transfer];
  variants.push(pending);
  for (const edit of [
    (v) => v.pendingTransfers.push({ ...transfer }),
    (v) => v.pendingTransfers[0].sourceGeneration++,
    (v) => (v.pendingTransfers[0].destinationPaneId = "center-a"),
    (v) => (v.pendingTransfers[0].destinationWindowId = "main"),
    (v) => v.pendingTransfers[0].tabIds.push("a"),
    (v) => (v.pendingTransfers[0].sourceWindowId = "missing"),
  ]) {
    const v = structuredClone(pending);
    edit(v);
    variants.push(v);
  }
  return { variants, valid: [layout, variants[1], pending] };
}
export function workspaceWireFixtures() {
  const { valid } = workspaceOwnershipVariants();
  return {
    workspaceOwnershipSchema: valid,
    workspaceTabSchema: [
      workspaceTab("tab"),
      {
        ...workspaceTab("builtin"),
        resource: { kind: "builtin", definitionId: "git.history" },
        builtInState: { definitionId: "git.history", worktreeId: null },
      },
    ],
    projectCenterLayoutNodeSchema: [
      workspaceLeaf("pane"),
      valid[0].windows[0].centerRoot,
    ],
  };
}
