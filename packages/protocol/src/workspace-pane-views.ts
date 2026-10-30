import type {
  WorkspaceOwnership,
  WorkspacePane,
  WorkspaceTab,
} from "./workspace-ownership.js";

/** Enumerate interactive owners, including a retained inactive conversation. */
export function workspacePaneViews(pane: WorkspacePane): WorkspaceTab[] {
  return pane.conversationView
    ? [...pane.tabs, pane.conversationView]
    : pane.tabs;
}

export function workspaceSelectedViewId(pane: WorkspacePane): string | null {
  return pane.selection?.kind === "conversation"
    ? pane.selection.viewId
    : (pane.selection?.tabId ?? pane.activeTabId);
}

/** Migration preserves view identity, placement, topology, and focus history. */
export function migrateWorkspaceConversationViews(
  layout: WorkspaceOwnership,
): WorkspaceOwnership {
  const migrated = structuredClone(layout);
  if (migrated.version === 2) return migrated;
  migrated.version = 2;
  for (const window of migrated.windows) {
    for (const pane of window.panes) {
      if (!pane.activeTabId) throw new Error("Legacy pane has no active tab.");
      pane.conversationView = null;
      pane.selection = { kind: "tab", tabId: pane.activeTabId };
    }
  }
  return migrated;
}
