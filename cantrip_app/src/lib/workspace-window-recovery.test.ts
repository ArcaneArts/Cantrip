import { expect, it, vi } from "vitest";
import type { WorkspaceOwnership } from "@cantrip/protocol";
import {
  restoreWorkspaceWindows,
  workspaceWindowRecoveryTargets,
} from "./workspace-window-recovery";

function layout(): WorkspaceOwnership {
  return {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: ["main", "one", "two"].map((id) => ({
      id,
      attachmentGeneration: 0,
      centerRoot: { kind: "pane", paneId: id },
      focusedPaneId: id,
      recentPaneIds: [id],
      panes: [
        {
          id,
          region: "center",
          titleProtection: null,
          activeTabId: `tab-${id}`,
          tabs: [
            {
              id: `tab-${id}`,
              preview: false,
              titleProtection: null,
              builtInState: null,
              dockPresentation: null,
              resource: {
                kind: "entity",
                definitionId: "project.terminal",
                resourceId: id,
              },
            },
          ],
        },
      ],
    })),
  };
}

it("preserves detached window, pane and tab identities without replaying a transfer", () => {
  const state = layout();
  const before = structuredClone(state);
  expect(workspaceWindowRecoveryTargets(state)).toEqual(
    ["one", "two"].map((id) => ({
      windowId: id,
      target: { projectId: "project", paneId: id, activeTabKey: `tab-${id}` },
    })),
  );
  expect(state).toEqual(before);
});

it("reopens an interrupted transfer's authoritative source, never its staged destination", () => {
  const state = layout();
  state.windows[2]!.panes = [];
  expect(
    workspaceWindowRecoveryTargets(state).map((target) => target.windowId),
  ).toEqual(["one"]);
  state.pendingTransfers = [
    {
      id: "transfer",
      sourceWindowId: "one",
      destinationWindowId: "two",
    } as NonNullable<WorkspaceOwnership["pendingTransfers"]>[number],
  ];
  expect(
    workspaceWindowRecoveryTargets(state).map(({ windowId }) => windowId),
  ).toEqual(["one"]);
});

it("continues independent windows after an actual native open failure", async () => {
  const state = layout();
  const error = new Error("native creation failed");
  const open = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(undefined);
  const onError = vi.fn();
  await restoreWorkspaceWindows({ read: () => state, open, onError });
  expect(open.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
  expect(onError).toHaveBeenCalledWith(error);
  expect(state.windows).toHaveLength(3);
});

it("does not resurrect a window removed during another asynchronous open", async () => {
  const state = layout();
  const open = vi.fn(async () => {
    state.windows.pop();
  });
  await restoreWorkspaceWindows({ read: () => state, open, onError: vi.fn() });
  expect(open).toHaveBeenCalledTimes(1);
});

it("stops opening windows when the connection is disposed", async () => {
  let state: WorkspaceOwnership | null = layout();
  const open = vi.fn(async () => {
    state = null;
  });
  await restoreWorkspaceWindows({ read: () => state, open, onError: vi.fn() });
  expect(open).toHaveBeenCalledTimes(1);
});

it("recovers a detached direct conversation with no rail tabs", () => {
  const state = layout();
  state.version = 2;
  for (const window of state.windows)
    for (const pane of window.panes) {
      pane.conversationView = null;
      pane.selection = { kind: "tab", tabId: pane.activeTabId! };
    }
  const pane = state.windows[1]!.panes[0]!;
  pane.conversationView = {
    ...pane.tabs[0]!,
    resource: {
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "agent",
    },
  };
  pane.tabs = [];
  pane.activeTabId = null;
  pane.selection = { kind: "conversation", viewId: "tab-one" };
  expect(
    workspaceWindowRecoveryTargets(state).find(
      (target) => target.windowId === "one",
    )?.target,
  ).toEqual({ projectId: "project", paneId: "one", activeTabKey: "tab-one" });
});
