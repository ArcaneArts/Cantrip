import { expect, it } from "vitest";
import {
  applyWorkspaceCommand,
  importWorkspaceLegacyFiles,
  migrateWorkspaceConversationViews,
  workspaceOwnershipSchema,
  workspacePaneViews,
  workspaceSelectedViewId,
  type WorkspaceAction,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "../src/index.js";

function view(id: string, agent = true): WorkspaceTab {
  return {
    id,
    resource: {
      kind: "entity",
      definitionId: agent ? "project.agent" : "project.terminal",
      resourceId: `resource-${id}`,
    },
    preview: false,
    titleProtection: null,
    builtInState: null,
    dockPresentation: null,
  };
}
function fixture(): WorkspaceOwnership {
  return workspaceOwnershipSchema.parse({
    version: 1,
    id: "desktop",
    projectId: "project",
    revision: 1,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 1,
        panes: [
          {
            id: "pane",
            region: "center",
            tabs: [view("file", false)],
            activeTabId: "file",
            titleProtection: null,
          },
        ],
        centerRoot: { kind: "pane", paneId: "pane" },
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
      },
    ],
  });
}
function command(
  layout: WorkspaceOwnership,
  action: WorkspaceAction,
  windowId = "main",
) {
  return applyWorkspaceCommand(layout, {
    operationId: `op-${layout.revision}`,
    workspaceId: layout.id,
    projectId: layout.projectId,
    windowId,
    attachmentGeneration: layout.windows.find((w) => w.id === windowId)!
      .attachmentGeneration,
    expectedRevision: layout.revision,
    action,
  });
}
function open(layout: WorkspaceOwnership, id = "conversation") {
  return command(layout, {
    type: "open-conversation",
    view: view(id),
    newPaneId: "new-pane",
    splitId: "new-split",
  }).layout;
}

it("migrates legacy pane selection without changing placement or mutating the input", () => {
  const legacy = fixture();
  const next = migrateWorkspaceConversationViews(legacy);
  expect(next.version).toBe(2);
  expect(next.windows[0]!.panes[0]).toEqual({
    ...legacy.windows[0]!.panes[0],
    conversationView: null,
    selection: { kind: "tab", tabId: "file" },
  });
  expect(next.windows[0]!.centerRoot).toEqual(legacy.windows[0]!.centerRoot);
  expect(legacy.version).toBe(1);
  expect(workspaceOwnershipSchema.parse(next)).toEqual(next);
});

it("opens directly while retaining real rail tabs and can return to either content", () => {
  let layout = open(fixture());
  let pane = layout.windows[0]!.panes[0]!;
  expect(pane.tabs.map(({ id }) => id)).toEqual(["file"]);
  expect(workspaceSelectedViewId(pane)).toBe("conversation");
  expect(workspacePaneViews(pane).map(({ id }) => id)).toEqual([
    "file",
    "conversation",
  ]);
  layout = command(layout, { type: "select", tabId: "file" }).layout;
  expect(workspaceSelectedViewId(layout.windows[0]!.panes[0]!)).toBe("file");
  layout = open(layout);
  pane = layout.windows[0]!.panes[0]!;
  expect(workspaceSelectedViewId(pane)).toBe("conversation");
  expect(pane.conversationView?.id).toBe("conversation");
});

it("closing the last rail tab keeps the conversation pane and closing its slot removes it", () => {
  let layout = open(fixture());
  layout = command(layout, { type: "close-tab", tabId: "file" }).layout;
  expect(layout.windows[0]!.panes[0]!.tabs).toEqual([]);
  expect(workspaceSelectedViewId(layout.windows[0]!.panes[0]!)).toBe(
    "conversation",
  );
  layout = command(layout, {
    type: "close-conversation",
    viewId: "conversation",
  }).layout;
  expect(layout.windows[0]!.panes).toEqual([]);
  expect(layout.windows[0]!.centerRoot).toBeNull();
  expect(layout.windows[0]!.focusedPaneId).toBeNull();
  layout = open(layout, "another");
  expect(layout.windows[0]!.panes[0]!.tabs).toEqual([]);
  expect(workspaceSelectedViewId(layout.windows[0]!.panes[0]!)).toBe("another");
});

it("ordinary rail opening focuses an existing direct owner rather than duplicating it", () => {
  const layout = open(fixture());
  const result = command(layout, {
    type: "open",
    tab: { ...view("conversation"), id: "duplicate" },
    target: { kind: "pane", paneId: "pane" },
  });
  expect(
    workspacePaneViews(result.layout.windows[0]!.panes[0]!).map(({ id }) => id),
  ).toEqual(["file", "conversation"]);
});

it("rejects duplicate owners, invalid selection, non-Agent slots, and old-version slots", () => {
  const layout = open(fixture());
  for (const mutate of [
    (l: WorkspaceOwnership) => {
      l.windows[0]!.panes[0]!.conversationView!.id = "file";
    },
    (l: WorkspaceOwnership) => {
      l.windows[0]!.panes[0]!.selection = {
        kind: "conversation",
        viewId: "missing",
      };
    },
    (l: WorkspaceOwnership) => {
      l.windows[0]!.panes[0]!.conversationView = view("terminal", false);
    },
    (l: WorkspaceOwnership) => {
      l.version = 1;
    },
  ]) {
    const invalid = structuredClone(layout);
    mutate(invalid);
    expect(workspaceOwnershipSchema.safeParse(invalid).success).toBe(false);
  }
});

function commitPrepared(
  layout: WorkspaceOwnership,
  id: string,
  source = "main",
  destination = "popout",
) {
  layout = command(
    layout,
    { type: "transfer-ready", transferId: id },
    destination,
  ).layout;
  layout = command(
    layout,
    { type: "transfer-state-ready", transferId: id },
    destination,
  ).layout;
  return command(layout, { type: "commit-transfer", transferId: id }, source)
    .layout;
}

it("whole-pane transfer retains an inactive conversation and the selected rail tab", () => {
  let layout = open(fixture());
  layout = command(layout, { type: "select", tabId: "file" }).layout;
  layout = command(layout, {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "pane",
    destinationWindowId: "popout",
    destinationPaneId: "pane",
  }).layout;
  expect(layout.pendingTransfers![0]!.tabIds).toEqual(["file", "conversation"]);
  layout = commitPrepared(layout, "detach");
  const moved = layout.windows.find((w) => w.id === "popout")!.panes[0]!;
  expect(workspaceSelectedViewId(moved)).toBe("file");
  expect(moved.conversationView?.id).toBe("conversation");
  expect(moved.tabs.map((v) => v.id)).toEqual(["file"]);
});

it("detaches a conversation without manufacturing a tab and returns to a free slot", () => {
  let layout = open(fixture());
  layout = command(layout, {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "pane",
    tabId: "conversation",
    destinationWindowId: "popout",
    destinationPaneId: "detached",
  }).layout;
  layout = commitPrepared(layout, "detach");
  expect(layout.windows.find((w) => w.id === "popout")!.panes[0]!.tabs).toEqual(
    [],
  );
  expect(layout.windows[0]!.panes[0]!.conversationView).toBeNull();
  layout = command(
    layout,
    {
      type: "prepare-return",
      transferId: "return",
      paneId: "detached",
      splitId: "return-split",
    },
    "popout",
  ).layout;
  layout = commitPrepared(layout, "return", "popout", "main");
  expect(layout.windows[0]!.panes).toHaveLength(1);
  expect(layout.windows[0]!.panes[0]!.conversationView?.id).toBe(
    "conversation",
  );
  expect(layout.windows[0]!.panes[0]!.tabs.map((v) => v.id)).toEqual(["file"]);
});

it("returning a conversation preserves intervening work in its old slot", () => {
  let layout = open(fixture());
  layout = command(layout, {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "pane",
    tabId: "conversation",
    destinationWindowId: "popout",
    destinationPaneId: "detached",
  }).layout;
  layout = commitPrepared(layout, "detach");
  layout = open(layout, "intervening");
  layout = command(
    layout,
    {
      type: "prepare-return",
      transferId: "return",
      paneId: "detached",
      splitId: "return-split",
    },
    "popout",
  ).layout;
  layout = commitPrepared(layout, "return", "popout", "main");
  const panes = layout.windows[0]!.panes;
  expect(panes).toHaveLength(2);
  expect(panes.find((p) => p.id === "pane")!.conversationView?.id).toBe(
    "intervening",
  );
  expect(panes.find((p) => p.id === "detached")!.conversationView?.id).toBe(
    "conversation",
  );
});

it("converts the direct slot into its own rail without removing another tab", () => {
  for (const position of [0, 1]) {
    const result = command(open(fixture()), {
      type: "move",
      tabId: "conversation",
      targetPaneId: "pane",
      position,
    }).layout;
    const pane = result.windows[0]!.panes[0]!;
    expect(pane.conversationView).toBeNull();
    expect(pane.tabs.map((v) => v.id)).toEqual(
      position === 0 ? ["conversation", "file"] : ["file", "conversation"],
    );
    expect(workspaceSelectedViewId(pane)).toBe("conversation");
  }
});

it("converts a tab-free conversation into its own rail", () => {
  const direct = command(open(fixture()), {
    type: "close-tab",
    tabId: "file",
  }).layout;
  const result = command(direct, {
    type: "move",
    tabId: "conversation",
    targetPaneId: "pane",
    position: 0,
  }).layout;
  const pane = result.windows[0]!.panes[0]!;
  expect(pane.conversationView).toBeNull();
  expect(pane.tabs.map((v) => v.id)).toEqual(["conversation"]);
});

it("splits either view while retaining the other in the original center pane", () => {
  for (const tabId of ["conversation", "file"]) {
    const result = command(open(fixture()), {
      type: "split",
      tabId,
      targetPaneId: "pane",
      paneId: "split-pane",
      splitId: "split",
      edge: "right",
      fraction: 0.5,
    }).layout;
    const panes = result.windows[0]!.panes;
    expect(panes).toHaveLength(2);
    expect(
      workspacePaneViews(panes.find((p) => p.id === "pane")!).map((v) => v.id),
    ).toEqual([tabId === "file" ? "conversation" : "file"]);
    expect(
      panes.find((p) => p.id === "split-pane")!.tabs.map((v) => v.id),
    ).toEqual([tabId]);
  }
});

it("places a moved rail after a center pane retained by its direct conversation", () => {
  const result = command(open(fixture()), {
    type: "move-new-pane",
    tabId: "file",
    paneId: "moved",
    region: "center",
    position: 1,
    splitId: "split",
  }).layout;
  expect(result.windows[0]!.panes.map((p) => p.id)).toEqual(["pane", "moved"]);
  expect(result.windows[0]!.panes[0]!.conversationView?.id).toBe(
    "conversation",
  );
});

it.each(["added-rail", "converted-rail", "rail-added-slot"])(
  "return preserves intervening detached content: %s",
  (scenario) => {
    let layout = open(fixture());
    layout = command(layout, {
      type: "prepare-detach",
      transferId: "detach",
      paneId: "pane",
      tabId: scenario === "rail-added-slot" ? "file" : "conversation",
      destinationWindowId: "popout",
      destinationPaneId: "detached",
    }).layout;
    layout = commitPrepared(layout, "detach");
    if (scenario === "added-rail")
      layout = command(
        layout,
        {
          type: "open",
          tab: view("extra", false),
          target: { kind: "pane", paneId: "detached" },
        },
        "popout",
      ).layout;
    if (scenario === "converted-rail")
      layout = command(
        layout,
        {
          type: "move",
          tabId: "conversation",
          targetPaneId: "detached",
          position: 0,
        },
        "popout",
      ).layout;
    if (scenario === "rail-added-slot")
      layout = command(
        layout,
        {
          type: "open-conversation",
          view: view("extra"),
          newPaneId: "unused",
          splitId: "unused",
        },
        "popout",
      ).layout;
    const ids = layout.windows
      .flatMap((w) =>
        w.panes.flatMap((p) => workspacePaneViews(p).map((v) => v.id)),
      )
      .sort();
    layout = command(
      layout,
      {
        type: "prepare-return",
        transferId: "return",
        paneId: "detached",
        splitId: "return-split",
      },
      "popout",
    ).layout;
    layout = commitPrepared(layout, "return", "popout", "main");
    const returned = layout.windows.find((w) => w.id === "main")!;
    expect(
      returned.panes
        .flatMap((p) => workspacePaneViews(p).map((v) => v.id))
        .sort(),
    ).toEqual(ids);
    expect(returned.panes).toHaveLength(2);
  },
);

it("imports a legacy editor after conversation ownership was enabled", () => {
  const layout = open(fixture());
  const imported = importWorkspaceLegacyFiles(
    layout,
    {
      windowId: "cantrip-editor-conversation-import",
      paneId: "imported",
      views: [{ tabId: "imported-file", documentId: "document", mode: "edit" }],
    },
    new Map([["document", null]]),
  );
  const pane = imported.layout.windows.find(
    (w) => w.id === "cantrip-editor-conversation-import",
  )!.panes[0]!;
  expect(pane.conversationView).toBeNull();
  expect(pane.selection).toEqual({ kind: "tab", tabId: "imported-file" });
  expect(imported.layout.windows[0]!.panes[0]!.conversationView?.id).toBe(
    "conversation",
  );
});

it("returns only the requested direct conversation while leaving sibling views in their window", () => {
  let layout = open(fixture());
  layout = command(layout, {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "pane",
    destinationWindowId: "popout",
    destinationPaneId: "pane",
  }).layout;
  layout = commitPrepared(layout, "detach");
  layout = command(
    layout,
    {
      type: "prepare-return",
      transferId: "return-one",
      paneId: "pane",
      tabId: "conversation",
      destinationPaneId: "returned-chat",
      splitId: "return-split",
    },
    "popout",
  ).layout;
  expect(layout.pendingTransfers![0]).toMatchObject({
    wholePane: false,
    tabIds: ["conversation"],
    sourcePlacement: { viewKind: "conversation" },
  });
  layout = commitPrepared(layout, "return-one", "popout", "main");
  expect(
    layout.windows
      .find((window) => window.id === "popout")!
      .panes[0]!.tabs.map((tab) => tab.id),
  ).toEqual(["file"]);
  expect(
    layout.windows.find((window) => window.id === "main")!.panes[0]!
      .conversationView?.id,
  ).toBe("conversation");
  workspaceOwnershipSchema.parse(layout);
});
it("rejects returning a single view into an already-owned pane identity", () => {
  let layout = open(fixture());
  layout = command(layout, {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "pane",
    destinationWindowId: "popout",
    destinationPaneId: "pane",
  }).layout;
  layout = commitPrepared(layout, "detach");
  expect(() =>
    command(
      layout,
      {
        type: "prepare-return",
        transferId: "return-one",
        paneId: "pane",
        tabId: "conversation",
        destinationPaneId: "pane",
        splitId: "return-split",
      },
      "popout",
    ),
  ).toThrow("new pane identity");
});
