import type { ProjectSurface } from "@/lib/project-surface";

export const MAX_MOBILE_PROJECT_SURFACES = 5;

export function mobileProjectSurfaces(
  surfaces: readonly ProjectSurface[],
  activeTabKey: string | null,
): ProjectSurface[] {
  const navigableSurfaces = surfaces.filter(
    (surface) =>
      surface.kind !== "builtin" ||
      surface.entity.definitionId !== "project.overview",
  );
  const explorerByWorktree = new Map<string, ProjectSurface>();
  for (const surface of navigableSurfaces) {
    if (surface.kind !== "explorer") continue;
    const current = explorerByWorktree.get(surface.entity.worktreeId);
    const surfacePriority =
      surface.tabKey === activeTabKey ? 2 : surface.entity.selectedPath ? 0 : 1;
    const currentPriority = current
      ? current.tabKey === activeTabKey
        ? 2
        : current.kind === "explorer" && !current.entity.selectedPath
          ? 1
          : 0
      : -1;
    if (surfacePriority > currentPriority) {
      explorerByWorktree.set(surface.entity.worktreeId, surface);
    }
  }
  const deduplicated = navigableSurfaces.filter(
    (surface) =>
      surface.kind !== "explorer" ||
      explorerByWorktree.get(surface.entity.worktreeId)?.tabKey ===
        surface.tabKey,
  );
  if (deduplicated.length <= MAX_MOBILE_PROJECT_SURFACES) return deduplicated;
  const active = deduplicated.find(({ tabKey }) => tabKey === activeTabKey);
  const recent = deduplicated
    .filter(({ tabKey }) => tabKey !== active?.tabKey)
    .slice(-(MAX_MOBILE_PROJECT_SURFACES - (active ? 1 : 0)));
  const visibleKeys = new Set([
    ...recent.map(({ tabKey }) => tabKey),
    ...(active ? [active.tabKey] : []),
  ]);
  return deduplicated.filter(({ tabKey }) => visibleKeys.has(tabKey));
}

export function mobileProjectShellModel({
  appMode,
  compactShell,
  projectOverviewSelected,
  selectedProject,
  selectedProjectId,
  showArchivedStandaloneChats,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
}: {
  appMode: "chat" | "ide" | null;
  compactShell: boolean;
  projectOverviewSelected: boolean;
  selectedProject: boolean;
  selectedProjectId: string | null;
  showArchivedStandaloneChats: boolean;
  showImporter: boolean;
  showProjectSettings: boolean;
  showServerAdmin: boolean;
  showSettings: boolean;
}) {
  const mobileProjectSelectorOpen =
    appMode === "ide" &&
    compactShell &&
    selectedProjectId === null &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings;
  const compactManagedHeader =
    compactShell &&
    (showArchivedStandaloneChats ||
      showImporter ||
      showSettings ||
      showServerAdmin ||
      (appMode === "ide" &&
        (mobileProjectSelectorOpen ||
          showProjectSettings ||
          (projectOverviewSelected && selectedProject))));
  return { compactManagedHeader, mobileProjectSelectorOpen } as const;
}
