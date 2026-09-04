import type { ProjectTabLayoutSummary } from "@cantrip/protocol";

export interface WorkspaceSelection {
  activeTabByPane: Readonly<Record<string, string>>;
  destination: "overview" | "surface";
  projectId: string | null;
  focusedPaneId: string | null;
}

export function emptyWorkspaceSelection(
  projectId: string | null = null,
): WorkspaceSelection {
  return {
    activeTabByPane: {},
    destination: "overview",
    projectId,
    focusedPaneId: null,
  };
}

export function selectedWorkspaceTabKey(
  selection: WorkspaceSelection,
): string | null {
  return selection.destination === "surface" && selection.focusedPaneId
    ? (selection.activeTabByPane[selection.focusedPaneId] ?? null)
    : null;
}

export function selectWorkspaceOverview(
  selection: WorkspaceSelection,
  projectId: string | null = selection.projectId,
): WorkspaceSelection {
  if (projectId !== selection.projectId)
    return emptyWorkspaceSelection(projectId);
  return {
    ...selection,
    destination: "overview",
    focusedPaneId: null,
  };
}

export function reconcileWorkspaceSelection(
  selection: WorkspaceSelection,
  layout: ProjectTabLayoutSummary | null | undefined,
  preferredTabKey?: string | null,
): WorkspaceSelection {
  if (!layout) return emptyWorkspaceSelection(selection.projectId);
  if (layout.panes.length === 0) {
    return emptyWorkspaceSelection(layout.projectId);
  }
  const projectChanged = selection.projectId !== layout.projectId;
  const overviewSelected =
    !projectChanged && !preferredTabKey && selection.destination === "overview";
  const preferredPane = preferredTabKey
    ? layout.panes.find(({ members }) =>
        members.some(({ tabKey }) => tabKey === preferredTabKey),
      )
    : undefined;
  const previousFocusedTabKey =
    !projectChanged && selection.focusedPaneId
      ? selection.activeTabByPane[selection.focusedPaneId]
      : undefined;
  const previousFocusedPane = !projectChanged
    ? layout.panes.find(({ id }) => id === selection.focusedPaneId)
    : undefined;
  const relocatedFocusedPane =
    previousFocusedTabKey &&
    !previousFocusedPane?.members.some(
      ({ tabKey }) => tabKey === previousFocusedTabKey,
    )
      ? layout.panes.find(({ members }) =>
          members.some(({ tabKey }) => tabKey === previousFocusedTabKey),
        )
      : undefined;
  const focusedPane =
    relocatedFocusedPane ??
    previousFocusedPane ??
    preferredPane ??
    layout.panes[0];
  const activeTabByPane: Record<string, string> = {};
  for (const pane of layout.panes) {
    const previous = projectChanged
      ? undefined
      : selection.activeTabByPane[pane.id];
    const preferred =
      preferredPane?.id === pane.id &&
      pane.members.some(({ tabKey }) => tabKey === preferredTabKey)
        ? preferredTabKey
        : undefined;
    activeTabByPane[pane.id] =
      preferred ??
      (pane.members.some(({ tabKey }) => tabKey === previous)
        ? previous!
        : pane.anchorTabKey);
  }
  return {
    activeTabByPane,
    destination: overviewSelected ? "overview" : "surface",
    projectId: layout.projectId,
    focusedPaneId: overviewSelected ? null : (focusedPane?.id ?? null),
  };
}

export function selectWorkspaceTab(
  selection: WorkspaceSelection,
  layout: ProjectTabLayoutSummary,
  tabKey: string,
): WorkspaceSelection {
  const pane = layout.panes.find(({ members }) =>
    members.some((member) => member.tabKey === tabKey),
  );
  if (!pane || pane.projectId !== layout.projectId) return selection;
  const reconciled = reconcileWorkspaceSelection(selection, layout);
  return {
    ...reconciled,
    activeTabByPane: {
      ...reconciled.activeTabByPane,
      [pane.id]: tabKey,
    },
    destination: "surface",
    focusedPaneId: pane.id,
  };
}

export function selectWorkspacePane(
  selection: WorkspaceSelection,
  layout: ProjectTabLayoutSummary,
  paneId: string,
): WorkspaceSelection {
  const pane = layout.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return selection;
  const remembered = selection.activeTabByPane[pane.id];
  const activeTabKey =
    remembered && pane.members.some((member) => member.tabKey === remembered)
      ? remembered
      : pane.anchorTabKey;
  return {
    activeTabByPane: {
      ...selection.activeTabByPane,
      [pane.id]: activeTabKey,
    },
    destination: "surface",
    projectId: layout.projectId,
    focusedPaneId: pane.id,
  };
}

/** @deprecated Pop-out compatibility until detached ownership migrates. */
export const selectWorkspaceGroup = selectWorkspacePane;
