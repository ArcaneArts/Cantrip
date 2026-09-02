import {
  isLocalGitProject,
  isWorkerBoundFolderProject,
  type ProjectSummary,
} from "@cantrip/protocol";

type ProjectWorkerAffinity = Pick<
  ProjectSummary,
  "capabilities" | "originKind" | "preferredWorkerId" | "replicas" | "source"
>;

export function projectAllowsExecutionOnWorker(
  project: ProjectWorkerAffinity,
  workerId: string,
): boolean {
  if (
    isWorkerBoundFolderProject(project.originKind, project.capabilities.git)
  ) {
    return workerId === (project.preferredWorkerId ?? project.source?.workerId);
  }
  if (isLocalGitProject(project.originKind, project.capabilities.git)) {
    return project.replicas.some(
      (replica) => replica.ready && replica.workerId === workerId,
    );
  }
  return true;
}
