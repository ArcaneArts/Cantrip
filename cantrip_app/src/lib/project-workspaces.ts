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

function projectNameMatchRank(name: string, query: string): number {
  if (!query) return 0;
  const normalizedName = name.toLocaleLowerCase();
  if (normalizedName === query) return 3;
  if (normalizedName.startsWith(query)) return 2;
  return normalizedName.includes(query) ? 1 : 0;
}

export function searchProjects(
  projects: ProjectSummary[],
  workspaces: ProjectWorkspaceSummary[],
  activeWorkspace: ProjectWorkspaceSummary | null,
  query: string,
  recentProjectIds: readonly string[] = [],
): ProjectSearchResult[] {
  const workspaceByProjectId = new Map<string, ProjectWorkspaceSummary>();
  for (const workspace of workspaces) {
    for (const projectId of workspace.projectIds) {
      workspaceByProjectId.set(projectId, workspace);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const recentPositions = new Map(
    recentProjectIds.map((id, index) => [id, index]),
  );
  const candidates = needle
    ? projects
    : projectsInWorkspace(projects, activeWorkspace);
  return candidates
    .map((project) => ({
      project,
      workspace: workspaceByProjectId.get(project.id) ?? null,
      nameRank: projectNameMatchRank(project.name, needle),
    }))
    .filter(
      ({ project, workspace, nameRank }) =>
        !needle ||
        nameRank > 0 ||
        [
          project.github?.nameWithOwner,
          project.source?.displayPath,
          workspace?.name,
        ].some((value) => value?.toLocaleLowerCase().includes(needle)),
    )
    .sort(
      (left, right) =>
        right.nameRank - left.nameRank ||
        (recentPositions.get(left.project.id) ?? Number.MAX_SAFE_INTEGER) -
          (recentPositions.get(right.project.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(({ project, workspace }) => ({ project, workspace }));
}
