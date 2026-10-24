import { expect, it, vi } from "vitest";
import type { WorkspaceWindow } from "@cantrip/protocol";
import { workspaceLayoutAction } from "./workspace-layout-command";

const window: WorkspaceWindow = {
  id: "main",
  attachmentGeneration: 0,
  centerRoot: { kind: "pane", paneId: "pane" },
  focusedPaneId: "pane",
  recentPaneIds: ["pane"],
  panes: [
    {
      id: "pane",
      region: "center",
      titleProtection: null,
      activeTabId: "opaque",
      tabs: [
        {
          id: "opaque",
          resource: {
            kind: "entity",
            definitionId: "project.terminal",
            resourceId: "resource",
          },
          titleProtection: null,
          preview: false,
          builtInState: null,
          dockPresentation: null,
        },
      ],
    },
  ],
};

it("translates drag operations without parsing opaque tab identities", () => {
  expect(
    workspaceLayoutAction(
      {
        type: "move-member",
        tabKey: "opaque",
        targetPaneId: "target",
        targetMemberPosition: 2,
      },
      window,
    ),
  ).toEqual({
    type: "move",
    tabId: "opaque",
    targetPaneId: "target",
    position: 2,
  });
  expect(
    workspaceLayoutAction(
      { type: "reorder-members", paneId: "pane", tabKeys: ["opaque"] },
      window,
    ),
  ).toEqual({
    type: "reorder",
    paneId: "pane",
    tabIds: ["opaque"],
  });
  expect(
    workspaceLayoutAction(
      { type: "reorder-panes", region: "center", paneIds: ["pane"] },
      window,
    ),
  ).toEqual({
    type: "reorder-panes",
    region: "center",
    paneIds: ["pane"],
  });
  expect(
    workspaceLayoutAction(
      { type: "resize-center-split", splitId: "split", fraction: 0.3 },
      window,
    ),
  ).toEqual({
    type: "resize",
    splitId: "split",
    fraction: 0.3,
  });
});

it("allocates split identities once and preserves explicit split size", () => {
  const allocate = vi
    .fn()
    .mockReturnValueOnce("new-pane")
    .mockReturnValueOnce("new-split");
  expect(
    workspaceLayoutAction(
      {
        type: "split-member",
        tabKey: "opaque",
        targetPaneId: "pane",
        edge: "left",
        fraction: 0.3,
      },
      window,
      allocate,
    ),
  ).toEqual({
    type: "split",
    tabId: "opaque",
    targetPaneId: "pane",
    paneId: "new-pane",
    splitId: "new-split",
    edge: "left",
    fraction: 0.3,
  });
  expect(allocate).toHaveBeenCalledTimes(2);
});

it("positions a newly extracted pane after removing an emptied source", () => {
  const action = workspaceLayoutAction(
    {
      type: "move-member",
      tabKey: "opaque",
      targetPaneId: null,
      targetMemberPosition: 0,
    },
    window,
    () => "allocated",
  );
  expect(action).toMatchObject({
    type: "move-new-pane",
    region: "center",
    position: 0,
    tabId: "opaque",
  });
  expect(() =>
    workspaceLayoutAction(
      {
        type: "move-member",
        tabKey: "another-window",
        targetPaneId: null,
        targetMemberPosition: 0,
      },
      window,
    ),
  ).toThrow("does not belong");
});
