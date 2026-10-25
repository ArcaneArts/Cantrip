import type { WorkspaceAction, WorkspaceWindow } from "@cantrip/protocol";
import type { WorkspaceSelection } from "./workspace-selection";

export function workspaceWindowSelection(
  projectId: string,
  window: WorkspaceWindow,
): WorkspaceSelection {
  return {
    projectId,
    destination: window.focusedPaneId === null ? "overview" : "surface",
    focusedPaneId: window.focusedPaneId,
    activeTabByPane: Object.fromEntries(
      window.panes.map((pane) => [pane.id, pane.activeTabId]),
    ),
  };
}

/** Translate a UI focus intent, not its cached inactive-pane selections. The
 * controller owns those selections, including adjacent-tab close fallback. */
export function workspaceSelectionAction(
  next: WorkspaceSelection,
  projectId: string,
  window: WorkspaceWindow,
): WorkspaceAction | null {
  if (next.projectId !== projectId)
    throw new Error("Workspace selection belongs to another project.");
  if (next.destination === "overview")
    return window.focusedPaneId === null ? null : { type: "home" };
  const pane = window.panes.find(
    (candidate) => candidate.id === next.focusedPaneId,
  );
  const tabId = pane && next.activeTabByPane[pane.id];
  if (!pane || !tabId || !pane.tabs.some((tab) => tab.id === tabId))
    throw new Error("Selected tab does not belong to this window.");
  return window.focusedPaneId === pane.id && pane.activeTabId === tabId
    ? null
    : { type: "select", tabId };
}
