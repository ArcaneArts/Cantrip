import type { ProjectSurface } from "@/lib/project-surface";

export function mobileProjectSurfaces(
  surfaces: readonly ProjectSurface[],
): ProjectSurface[] {
  // The bottom bar scrolls and the picker exposes all views. Selection must not
  // replace a file with another view of its worktree or alter visible membership.
  return surfaces.filter(
    (surface) =>
      surface.kind !== "builtin" ||
      surface.entity.definitionId !== "project.overview",
  );
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
