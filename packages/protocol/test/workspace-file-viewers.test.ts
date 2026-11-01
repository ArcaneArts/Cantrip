import { expect, it } from "vitest";
import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  type WorkspaceAction,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "../src/index.js";
const tab = (viewer?: string | null): WorkspaceTab => ({
  id: "file",
  resource: {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "document",
  },
  preview: false,
  titleProtection: null,
  builtInState: null,
  dockPresentation: null,
  ...(viewer !== undefined
    ? { fileViewer: viewer, fileMode: "visual" as const }
    : {}),
});
function fixture(): WorkspaceOwnership {
  return workspaceOwnershipSchema.parse({
    version: 2,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [
          {
            id: "pane",
            region: "center",
            titleProtection: null,
            tabs: [tab()],
            activeTabId: "file",
            conversationView: null,
            selection: { kind: "tab", tabId: "file" },
          },
        ],
        centerRoot: { kind: "pane", paneId: "pane" },
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
      },
    ],
  });
}
function step(
  layout: WorkspaceOwnership,
  action: WorkspaceAction,
  windowId = "main",
) {
  return applyWorkspaceCommand(layout, {
    operationId: `op-${layout.revision}`,
    projectId: layout.projectId,
    workspaceId: layout.id,
    windowId,
    expectedRevision: layout.revision,
    attachmentGeneration: 0,
    action,
  }).layout;
}
const open = (viewer?: string | null): WorkspaceAction => ({
  type: "open",
  target: { kind: "pane", paneId: "pane" },
  tab: { ...tab(viewer), id: "new-view" },
});
it("updates the existing file view, retains explicit choices on normal opens and resets to Automatic", () => {
  let layout = step(fixture(), open("json"));
  expect(layout.windows[0]!.panes[0]!.tabs).toHaveLength(1);
  expect(layout.windows[0]!.panes[0]!.tabs[0]).toMatchObject({
    id: "file",
    fileViewer: "json",
    fileMode: "visual",
  });
  layout = step(
    workspaceOwnershipSchema.parse(JSON.parse(JSON.stringify(layout))),
    open(),
  );
  expect(layout.windows[0]!.panes[0]!.tabs[0]!.fileViewer).toBe("json");
  layout = step(layout, {
    ...open(null),
    tab: { ...tab(null), id: "new-view", fileMode: "edit" },
  } as WorkspaceAction);
  expect(layout.windows[0]!.panes[0]!.tabs[0]).toMatchObject({
    fileViewer: null,
    fileMode: "edit",
  });
});
it("keeps the viewer choice with its owned tab across a completed pop-out transfer", () => {
  let layout = step(fixture(), open("json"));
  layout = step(layout, {
    type: "prepare-detach",
    transferId: "transfer",
    paneId: "pane",
    tabId: "file",
    destinationWindowId: "popout",
    destinationPaneId: "moved",
  });
  layout = step(
    layout,
    { type: "transfer-ready", transferId: "transfer" },
    "popout",
  );
  layout = step(
    layout,
    { type: "transfer-state-ready", transferId: "transfer" },
    "popout",
  );
  layout = step(layout, { type: "commit-transfer", transferId: "transfer" });
  expect(
    layout.windows.find((w) => w.id === "popout")!.panes[0]!.tabs[0],
  ).toMatchObject({ id: "file", fileViewer: "json", fileMode: "visual" });
});
it("rejects format metadata on unrelated surfaces and invalid identifiers", () => {
  for (const viewer of ["", "bad/path", "x".repeat(65)]) {
    const layout = fixture();
    layout.windows[0]!.panes[0]!.tabs[0]!.fileViewer = viewer;
    expect(workspaceOwnershipSchema.safeParse(layout).success).toBe(false);
  }
  const layout = fixture();
  const view = layout.windows[0]!.panes[0]!.tabs[0]!;
  view.resource = {
    kind: "entity",
    definitionId: "project.agent",
    resourceId: "agent",
  };
  view.fileViewer = "json";
  expect(workspaceOwnershipSchema.safeParse(layout).success).toBe(false);
});

it("keeps the captured source format stable while a pop-out is pending", () => {
  let layout = step(fixture(), open("json"));
  layout = step(layout, {
    type: "prepare-detach",
    transferId: "transfer",
    paneId: "pane",
    tabId: "file",
    destinationWindowId: "popout",
    destinationPaneId: "moved",
  });
  expect(
    step(layout, open("json")).windows[0]!.panes[0]!.tabs[0]!.fileViewer,
  ).toBe("json");
  expect(() => step(layout, open("image"))).toThrow(
    "File view is reserved for a pending transfer.",
  );
  expect(layout.windows[0]!.panes[0]!.tabs[0]!.fileViewer).toBe("json");
});
