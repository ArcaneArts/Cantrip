import {
  workspacePaneViews,
  type WorkspaceAction,
  type WorkspaceWindow,
} from "@cantrip/protocol";
import type { TabLayoutCommand } from "./workspace-dnd-model";

/** Allocate new identities once, before enqueueing. The command client retains
 * these exact identities through transport retries and revision rebases. */
export function workspaceLayoutAction(
  command: TabLayoutCommand,
  window: WorkspaceWindow,
  allocateId: () => string = () => crypto.randomUUID(),
): WorkspaceAction {
  switch (command.type) {
    case "reorder-panes":
      return {
        type: "reorder-panes",
        region: command.region,
        paneIds: [...command.paneIds],
      };
    case "reorder-members":
      return {
        type: "reorder",
        paneId: command.paneId,
        tabIds: [...command.tabKeys],
      };
    case "resize-center-split":
      return {
        type: "resize",
        splitId: command.splitId,
        fraction: command.fraction,
      };
    case "split-member":
      return {
        type: "split",
        tabId: command.tabKey,
        targetPaneId: command.targetPaneId,
        paneId: allocateId(),
        splitId: allocateId(),
        edge: command.edge,
        fraction: command.fraction ?? 0.5,
      };
    case "move-member": {
      if (command.targetPaneId !== null)
        return {
          type: "move",
          tabId: command.tabKey,
          targetPaneId: command.targetPaneId,
          position: command.targetMemberPosition,
        };
      const source = window.panes.find((pane) =>
        workspacePaneViews(pane).some((tab) => tab.id === command.tabKey),
      );
      if (!source) throw new Error("Tab does not belong to this window.");
      const region = command.targetRegion ?? source.region;
      const remaining = window.panes.filter(
        (pane) =>
          pane.region === region &&
          !(pane === source && workspacePaneViews(source).length === 1),
      );
      return {
        type: "move-new-pane",
        tabId: command.tabKey,
        paneId: allocateId(),
        splitId: allocateId(),
        region,
        position: command.targetPanePosition ?? remaining.length,
      };
    }
  }
}
