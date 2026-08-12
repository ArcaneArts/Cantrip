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

export interface ProjectSearchResult {
  memberships: ProjectWorkspaceSummary[];
  project: ProjectSummary;
}

export function searchProjects(
  projects: ProjectSummary[],
  workspaces: ProjectWorkspaceSummary[],
  activeWorkspace: ProjectWorkspaceSummary | null,
  query: string,
): ProjectSearchResult[] {
  const membershipsByProjectId = new Map<string, ProjectWorkspaceSummary[]>();
  for (const workspace of workspaces) {
    for (const projectId of workspace.projectIds) {
      const memberships = membershipsByProjectId.get(projectId) ?? [];
      memberships.push(workspace);
      membershipsByProjectId.set(projectId, memberships);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const candidates = needle
    ? projects
    : projectsInWorkspace(projects, activeWorkspace);
  return candidates
    .filter((project) => {
      if (!needle) return true;
      const memberships = membershipsByProjectId.get(project.id) ?? [];
      return [
        project.name,
        project.github?.nameWithOwner,
        project.source?.displayPath,
        ...memberships.map(({ name }) => name),
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle));
    })
    .map((project) => ({
      memberships: membershipsByProjectId.get(project.id) ?? [],
      project,
    }));
}
