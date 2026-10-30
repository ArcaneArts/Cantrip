import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";

export function workspaceLegacyLayout(label) {
  const at = "2026-10-25T00:00:00.123Z";
  const dock = {
    preferredMode: "split",
    splitFraction: 0.32,
    restoreFraction: 0.32,
  };
  const member = (paneId, tabKind, tabId, position) => ({
    tabKey: `${tabKind}:${tabId}`,
    paneId,
    projectId: "github",
    tabKind,
    tabId,
    builtInState:
      tabKind === "builtin" ? { definitionId: tabId, worktreeId: null } : null,
    titleProtection:
      tabKind === "browser"
        ? { ...label, classification: { recordKind: "browser" } }
        : null,
    dockPresentation: paneId === "center-a" ? null : dock,
    position,
    createdAt: at,
    updatedAt: at,
  });
  const pane = (id, region, members) => ({
    id,
    projectId: "github",
    region,
    position: 0,
    titleProtection: null,
    anchorTabKey: members[0].tabKey,
    members,
    createdAt: at,
    updatedAt: at,
  });
  return {
    projectId: "github",
    revision: 12,
    centerRoot: { kind: "pane", paneId: "center-a" },
    panes: [
      pane("center-a", "center", [
        member("center-a", "terminal", "first", 0),
        member("center-a", "terminal", "second", 1),
      ]),
      pane("right-pane", "right", [
        member("right-pane", "browser", "browser", 0),
      ]),
      pane("bottom-pane", "bottom", [
        member("bottom-pane", "builtin", "git.history", 0),
      ]),
    ],
  };
}

export function workspaceLayoutWireFixtures(label) {
  const layout = workspaceState();
  const views = [{ tabId: "import-tab", documentId: "document", mode: "edit" }];
  const legacyImport = {
    windowId: "cantrip-editor-import",
    paneId: "import-pane",
    views,
  };
  const actions = [
    {
      type: "migrate-code-files",
      tabId: "a",
      codeId: "code",
      expectedWorkerId: "worker",
      expectedWorktreeId: "worktree",
      views,
    },
    {
      type: "migrate-explorer-file",
      tabId: "a",
      explorerId: "explorer",
      expectedWorkerId: "worker",
      expectedWorktreeId: "worktree",
      expectedStateProtection: {
        classification: { recordKind: "explorer-state" },
        protectedState: label.protectedLabel,
      },
      documentId: "document",
      mode: "visual",
      retainedViews: views,
    },
    { type: "replace-attachment", rendererId: "renderer" },
    {
      type: "prepare-return",
      transferId: "transfer",
      paneId: "pane",
      splitId: "split",
    },
    {
      type: "prepare-detach",
      transferId: "transfer",
      paneId: "pane",
      tabId: "a",
      destinationWindowId: "new-window",
      destinationPaneId: "new-pane",
    },
    ...[
      "transfer-state-ready",
      "commit-transfer",
      "transfer-ready",
      "cancel-transfer",
    ].map((type) => ({ type, transferId: "transfer" })),
    { type: "select", tabId: "a" },
    { type: "home" },
    {
      type: "open-conversation",
      view: workspaceTab("conversation", "chat", "project.agent"),
      newPaneId: "conversation-pane",
      splitId: "conversation-split",
    },
    { type: "close-conversation", viewId: "conversation" },
    { type: "close-tab", tabId: "a" },
    { type: "close-pane", paneId: "pane" },
    { type: "pin", tabId: "a" },
    { type: "file-mode", tabId: "a", mode: "preview" },
    {
      type: "rename-pane",
      paneId: "pane",
      titleProtection: {
        ...label,
        classification: { recordKind: "tab-group" },
      },
    },
    {
      type: "dock-presentation",
      tabId: "a",
      presentation: {
        preferredMode: "split",
        splitFraction: 0.32,
        restoreFraction: 0.32,
      },
    },
    {
      type: "reorder-panes",
      region: "center",
      paneIds: ["center-a", "center-b"],
    },
    {
      type: "move-new-pane",
      tabId: "a",
      paneId: "new-pane",
      region: "center",
      position: 0,
      splitId: "split",
    },
    { type: "reorder", paneId: "pane", tabIds: ["a", "b"] },
    { type: "move", tabId: "a", targetPaneId: "pane", position: 0 },
    {
      type: "split",
      tabId: "a",
      targetPaneId: "pane",
      paneId: "new-pane",
      splitId: "split",
      edge: "right",
      fraction: 0.5,
    },
    { type: "resize", splitId: "split", fraction: 0.5 },
    {
      type: "open",
      tab: workspaceTab("new-tab"),
      target: { kind: "pane", paneId: "center-a" },
    },
    {
      type: "open",
      tab: workspaceTab("new-tab"),
      replacePreviewTabId: "a",
      target: {
        kind: "new-pane",
        paneId: "new-pane",
        region: "center",
        splitId: "new-split",
      },
    },
  ];
  return {
    workspaceCommandSchema: actions.map((action) => ({
      operationId: "operation",
      workspaceId: layout.id,
      projectId: layout.projectId,
      windowId: "main",
      attachmentGeneration: 1,
      expectedRevision: layout.revision,
      action,
    })),
    workspaceReceiptSchema: [
      {
        layout,
        operationId: "operation",
        appliedRevision: 2,
        replayed: true,
        focusWindowId: null,
        emptyWindowIds: [],
      },
    ],
    workspaceSeedRequestSchema: [
      { mainWindowId: "main" },
      {
        mainWindowId: "main",
        activeTabByPane: { "center-a": "terminal:second" },
        focusedPaneId: "center-a",
        detachedPanes: [{ paneId: "right-pane", windowId: "detached" }],
      },
    ],
    workspaceLegacyFileImportSchema: [legacyImport],
    workspaceLegacyFileImportRequestSchema: [
      { ...legacyImport, expectedRevision: 4 },
    ],
    workspaceLegacyFileImportReceiptSchema: [{ layout, replayed: false }],
    projectTabLayoutWireSummarySchema: [workspaceLegacyLayout(label)],
    projectBuiltinSurfaceDefinitionIdSchema: ["git.history"],
  };
}
