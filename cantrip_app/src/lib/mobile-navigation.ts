import type { ProjectSummary } from "@cantrip/protocol";

export interface ProjectSelectionAction {
  projectId: string | null;
  showImporter?: boolean;
}

export const PRIMARY_MOBILE_BOTTOM_TAB_ID = "primary";

export interface MobileBottomTab {
  groupId: string | null;
  id: string;
}

export function mobileBottomTabsFromConfiguration(
  groupIds?: readonly (string | null)[],
): MobileBottomTab[] {
  const restored = groupIds?.length ? groupIds : [null];
  return restored.map((groupId, index) => ({
    groupId,
    id: index === 0 ? PRIMARY_MOBILE_BOTTOM_TAB_ID : `mobile-${String(index)}`,
  }));
}

export function mobileBottomTabConfiguration(
  tabs: readonly MobileBottomTab[],
): (string | null)[] {
  return tabs.map(({ groupId }) => groupId);
}

export function initialMobileBottomTabs(): MobileBottomTab[] {
  return mobileBottomTabsFromConfiguration();
}

export function assignMobileBottomTab(
  tabs: MobileBottomTab[],
  tabId: string,
  groupId: string,
): MobileBottomTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.id !== tabId || tab.groupId === groupId) return tab;
    changed = true;
    return { ...tab, groupId };
  });
  return changed ? next : tabs;
}

export function reconcileMobileBottomTabs(
  tabs: MobileBottomTab[],
  validGroupIds: ReadonlySet<string>,
): MobileBottomTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.groupId === null || validGroupIds.has(tab.groupId)) return tab;
    changed = true;
    return { ...tab, groupId: null };
  });
  return changed ? next : tabs;
}

export function removeMobileBottomTab(
  tabs: readonly MobileBottomTab[],
  tabId: string,
): { activeTabId: string; tabs: MobileBottomTab[] } | null {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index <= 0) return null;
  const next = tabs.filter((tab) => tab.id !== tabId);
  return {
    activeTabId: next[Math.min(index - 1, next.length - 1)]!.id,
    tabs: next,
  };
}

export function projectSelectionAction({
  compact,
  preserveCurrentDestination = false,
  projects,
  selectedProjectId,
  visibleProjects,
}: {
  compact: boolean;
  preserveCurrentDestination?: boolean;
  projects: readonly Pick<ProjectSummary, "id">[];
  selectedProjectId: string | null;
  visibleProjects: readonly Pick<ProjectSummary, "id">[];
}): ProjectSelectionAction | null {
  if (preserveCurrentDestination) return null;

  if (compact) {
    if (
      selectedProjectId === null ||
      projects.some(({ id }) => id === selectedProjectId)
    ) {
      return null;
    }
    return { projectId: null, showImporter: false };
  }

  if (projects.length === 0) {
    return { projectId: null, showImporter: false };
  }
  if (visibleProjects.some(({ id }) => id === selectedProjectId)) return null;
  return { projectId: visibleProjects[0]?.id ?? null };
}
