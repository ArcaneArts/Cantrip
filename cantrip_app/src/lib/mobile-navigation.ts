import type { ProjectSummary } from "@cantrip/protocol";

export interface ProjectSelectionAction {
  projectId: string | null;
  showImporter?: boolean;
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
    return { projectId: null, showImporter: true };
  }
  if (visibleProjects.some(({ id }) => id === selectedProjectId)) return null;
  return { projectId: visibleProjects[0]?.id ?? null };
}
