import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";

export function resolveProjectWorkspace(
  workspaces: ProjectWorkspaceSummary[],
  preferredId: string | null,
): ProjectWorkspaceSummary | null {
  return (
    workspaces.find(({ id }) => id === preferredId) ??
    workspaces.find(({ isDefault }) => isDefault) ??
    workspaces[0] ??
    null
  );
}

export function projectsInWorkspace(
  projects: ProjectSummary[],
  workspace: ProjectWorkspaceSummary | null,
): ProjectSummary[] {
  if (!workspace) return projects;
  const visibleIds = new Set(workspace.projectIds);
  return projects.filter(({ id }) => visibleIds.has(id));
}
