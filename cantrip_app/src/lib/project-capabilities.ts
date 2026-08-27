import type { ProjectSummary } from "@cantrip/protocol";

export function projectHasGithubCapability(
  project: Pick<ProjectSummary, "capabilities" | "github">,
): boolean {
  return project.capabilities.github;
}
