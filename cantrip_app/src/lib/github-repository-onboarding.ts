import type { ProjectSummary } from "@cantrip/protocol";

export type GithubRepositoryOnboardingAction = "create-chat" | "stop" | "wait";

export function githubRepositoryOnboardingAction(
  projectId: string,
  projects: Array<Pick<ProjectSummary, "id" | "setupStatus">> | undefined,
): GithubRepositoryOnboardingAction {
  const project = projects?.find(({ id }) => id === projectId);
  if (!project || project.setupStatus === "cloning") return "wait";
  return project.setupStatus === "ready" ? "create-chat" : "stop";
}
