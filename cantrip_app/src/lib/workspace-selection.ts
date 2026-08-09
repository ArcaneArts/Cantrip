import type { ProjectTabLayoutSummary } from "@cantrip/protocol";

export interface WorkspaceSelection {
  activeTabByGroup: Readonly<Record<string, string>>;
  projectId: string | null;
  selectedGroupId: string | null;
}

export function emptyWorkspaceSelection(
  projectId: string | null = null,
): WorkspaceSelection {
  return { activeTabByGroup: {}, projectId, selectedGroupId: null };
}

export function selectedWorkspaceTabKey(
  selection: WorkspaceSelection,
): string | null {
  return selection.selectedGroupId
    ? (selection.activeTabByGroup[selection.selectedGroupId] ?? null)
    : null;
}

export function reconcileWorkspaceSelection(
  selection: WorkspaceSelection,
  layout: ProjectTabLayoutSummary | null | undefined,
  preferredTabKey?: string | null,
): WorkspaceSelection {
  if (!layout) return emptyWorkspaceSelection(selection.projectId);
  const projectChanged = selection.projectId !== layout.projectId;
  const preferredGroup = preferredTabKey
    ? layout.groups.find(({ members }) =>
        members.some(({ tabKey }) => tabKey === preferredTabKey),
      )
    : undefined;
  const selectedGroup =
    (!projectChanged
      ? layout.groups.find(({ id }) => id === selection.selectedGroupId)
      : undefined) ??
    preferredGroup ??
    layout.groups[0];
  const activeTabByGroup: Record<string, string> = {};
  for (const group of layout.groups) {
    const previous = projectChanged
      ? undefined
      : selection.activeTabByGroup[group.id];
    const preferred =
      preferredGroup?.id === group.id &&
      group.members.some(({ tabKey }) => tabKey === preferredTabKey)
        ? preferredTabKey
        : undefined;
    activeTabByGroup[group.id] =
      preferred ??
      (group.members.some(({ tabKey }) => tabKey === previous)
        ? previous!
        : group.anchorTabKey);
  }
  return {
    activeTabByGroup,
    projectId: layout.projectId,
    selectedGroupId: selectedGroup?.id ?? null,
  };
}

export function selectWorkspaceTab(
  selection: WorkspaceSelection,
  layout: ProjectTabLayoutSummary,
  tabKey: string,
): WorkspaceSelection {
  const group = layout.groups.find(({ members }) =>
    members.some((member) => member.tabKey === tabKey),
  );
  if (!group || group.projectId !== layout.projectId) return selection;
  const reconciled = reconcileWorkspaceSelection(selection, layout);
  return {
    ...reconciled,
    activeTabByGroup: {
      ...reconciled.activeTabByGroup,
      [group.id]: tabKey,
    },
    selectedGroupId: group.id,
  };
}
