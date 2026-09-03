import {
  isLocalGitProject,
  isWorkerBoundFolderProject,
} from "@cantrip/protocol";

interface ProjectWorkerAffinity {
  capabilities: { git: boolean };
  originKind: "github" | "managed-folder";
  preferredWorkerId?: string | null;
  replicas: ReadonlyArray<{ ready: boolean; workerId: string }>;
  source?: { workerId: string } | null;
}

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
