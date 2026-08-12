import type { ProjectSummary } from "@cantrip/protocol";

export interface ProjectSelectionAction {
  projectId: string | null;
  showImporter?: boolean;
}

export type MobileSecondNavigationTarget =
  { kind: "grid" } | { kind: "surface"; tabKey: string };

export function validMobileSurfaceTabKey(
  tabKey: string | null,
  validTabKeys: ReadonlySet<string>,
): string | null {
  return tabKey && validTabKeys.has(tabKey) ? tabKey : null;
}

export function mobileSecondNavigationTarget({
  gridOpen,
  overviewSelected,
  rememberedTabKey,
  selectedTabKey,
  validTabKeys,
}: {
  gridOpen: boolean;
  overviewSelected: boolean;
  rememberedTabKey: string | null;
  selectedTabKey: string | null;
  validTabKeys: ReadonlySet<string>;
}): MobileSecondNavigationTarget {
  if (gridOpen) return { kind: "grid" };
  if (
    !overviewSelected &&
    validMobileSurfaceTabKey(selectedTabKey, validTabKeys)
  ) {
    return { kind: "grid" };
  }
  const remembered = validMobileSurfaceTabKey(rememberedTabKey, validTabKeys);
  return remembered
    ? { kind: "surface", tabKey: remembered }
    : { kind: "grid" };
}

export function projectSelectionAction({
  compact,
  projects,
  selectedProjectId,
  visibleProjects,
}: {
  compact: boolean;
  projects: readonly Pick<ProjectSummary, "id">[];
  selectedProjectId: string | null;
  visibleProjects: readonly Pick<ProjectSummary, "id">[];
}): ProjectSelectionAction | null {
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
    return { projectId: null, showImporter: true };
  }
  if (visibleProjects.some(({ id }) => id === selectedProjectId)) return null;
  return { projectId: visibleProjects[0]?.id ?? null };
}
