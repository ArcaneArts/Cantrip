import { describe, expect, it } from "vitest";
import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  type WorkspaceAction,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "../src/index.js";

function tab(
  id: string,
  definitionId:
    | "project.terminal"
    | "project.agent"
    | "project.git-history" = "project.terminal",
): WorkspaceTab {
  return {
    id,
    resource: { kind: "entity", definitionId, resourceId: id },
    titleProtection: null,
    preview: false,
    builtInState: null,
    dockPresentation: null,
  };
}

function fixture(): WorkspaceOwnership {
  return workspaceOwnershipSchema.parse({
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 1,
        panes: [
          {
            id: "main-pane",
            region: "center",
            titleProtection: null,
            tabs: [tab("agent", "project.agent"), tab("terminal")],
            activeTabId: "terminal",
          },
          {
            id: "history-pane",
            region: "right",
            titleProtection: null,
            tabs: [tab("history", "project.git-history")],
            activeTabId: "history",
          },
        ],
        centerRoot: { kind: "pane", paneId: "main-pane" },
        focusedPaneId: "main-pane",
        recentPaneIds: ["main-pane", "history-pane"],
      },
    ],
  });
}

function apply(
  layout: WorkspaceOwnership,
  action: WorkspaceAction,
  windowId = "main",
) {
  return applyWorkspaceCommand(layout, {
    operationId: `${layout.revision}-${action.type}`,
    workspaceId: layout.id,
    projectId: layout.projectId,
    windowId,
    attachmentGeneration: layout.windows.find((w) => w.id === windowId)!
      .attachmentGeneration,
    expectedRevision: layout.revision,
    action,
  }).layout;
}

function ready(
  layout: WorkspaceOwnership,
  transferId: string,
  windowId: string,
) {
  layout = apply(layout, { type: "transfer-ready", transferId }, windowId);
  return apply(layout, { type: "transfer-state-ready", transferId }, windowId);
}

function detach() {
  let layout = apply(fixture(), {
    type: "prepare-detach",
    transferId: "detach",
    paneId: "main-pane",
    tabId: "terminal",
    destinationWindowId: "popout",
    destinationPaneId: "detached-pane",
  });
  layout = ready(layout, "detach", "popout");
  return apply(layout, { type: "commit-transfer", transferId: "detach" });
}

describe("returning a popped-out tab to the main tab bar", () => {
  it.each([
    "ordinary-close",
    "legacy-placement",
    "replaced-pane",
    "single-view-return",
  ])("does not split the main pane: %s", (scenario) => {
    let layout = detach();
    const history = structuredClone(layout.windows[0]!.panes[1]);
    if (scenario === "legacy-placement")
      delete layout.windows[1]!.returnPlacement!.detachedPaneId;
    if (scenario === "replaced-pane") {
      layout = apply(layout, { type: "close-tab", tabId: "agent" });
      layout = apply(layout, {
        type: "open",
        tab: tab("new-agent", "project.agent"),
        target: {
          kind: "new-pane",
          paneId: "replacement-pane",
          region: "center",
          splitId: "unused",
        },
      });
    }
    const before = structuredClone(layout.windows[0]!.centerRoot);
    layout = apply(
      layout,
      {
        type: "prepare-return",
        transferId: "return",
        paneId: "detached-pane",
        splitId: "unwanted-split",
        ...(scenario === "single-view-return"
          ? { tabId: "terminal", destinationPaneId: "return-pane" }
          : {}),
      },
      "popout",
    );
    layout = ready(layout, "return", "main");
    layout = apply(
      layout,
      { type: "commit-transfer", transferId: "return" },
      "popout",
    );
    const main = layout.windows.find((w) => w.id === "main")!;
    const panes = main.panes.filter((p) => p.region === "center");
    expect(main.centerRoot).toEqual(before);
    expect(panes).toHaveLength(1);
    expect(panes[0]!.tabs.map((t) => t.id)).toEqual([
      scenario === "replaced-pane" ? "new-agent" : "agent",
      "terminal",
    ]);
    expect(main.panes.find((p) => p.id === "history-pane")).toEqual(history);
    expect(layout.windows.find((w) => w.id === "popout")!.panes).toEqual([]);
    workspaceOwnershipSchema.parse(layout);
  });
});
