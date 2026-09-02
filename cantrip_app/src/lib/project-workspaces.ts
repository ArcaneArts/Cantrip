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

export function resolveProjectWorkspaceForSelection(
  workspaces: readonly ProjectWorkspaceSummary[],
  projectId: string,
): ProjectWorkspaceSummary | null {
  return (
    workspaces.find(({ projectIds }) => projectIds.includes(projectId)) ?? null
  );
}

export interface ProjectSearchResult {
  project: ProjectSummary;
  workspace: ProjectWorkspaceSummary | null;
}

export function searchProjects(
  projects: ProjectSummary[],
  workspaces: ProjectWorkspaceSummary[],
  activeWorkspace: ProjectWorkspaceSummary | null,
  query: string,
): ProjectSearchResult[] {
  const workspaceByProjectId = new Map<string, ProjectWorkspaceSummary>();
  for (const workspace of workspaces) {
    for (const projectId of workspace.projectIds) {
      workspaceByProjectId.set(projectId, workspace);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const candidates = needle
    ? projects
    : projectsInWorkspace(projects, activeWorkspace);
  return candidates
    .filter((project) => {
      if (!needle) return true;
      const workspace = workspaceByProjectId.get(project.id);
      return [
        project.name,
        project.github?.nameWithOwner,
        project.source?.displayPath,
        workspace?.name,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle));
    })
    .map((project) => ({
      project,
      workspace: workspaceByProjectId.get(project.id) ?? null,
    }));
}
