import type {
  ProjectReplicaJobSummary,
  ProjectSummary,
} from "@cantrip/protocol";

export function projectOwningWorkerId(
  project: Pick<ProjectSummary, "preferredWorkerId" | "source"> | undefined,
  setupJob?: Pick<ProjectReplicaJobSummary, "workerId">,
): string | null {
  return (
    project?.source?.workerId ??
    project?.preferredWorkerId ??
    setupJob?.workerId ??
    null
  );
}

export function latestProjectProvisionJob(
  jobs: readonly ProjectReplicaJobSummary[] | undefined,
): ProjectReplicaJobSummary | null {
  let latest: ProjectReplicaJobSummary | null = null;
  for (const job of jobs ?? []) {
    if (job.kind !== "provision") continue;
    if (
      !latest ||
      job.createdAt > latest.createdAt ||
      (job.createdAt === latest.createdAt && job.id > latest.id)
    ) {
      latest = job;
    }
  }
  return latest;
}

export function projectSetupPercent(
  job: ProjectReplicaJobSummary | null | undefined,
): number {
  return job?.progress.percent ?? 5;
}

export function isWindowsLongPathSetupFailure(
  job: Pick<ProjectReplicaJobSummary, "error"> | null | undefined,
): boolean {
  const error = job?.error;
  if (!error) return false;
  return (
    error.code === "windows-long-paths-disabled" ||
    /\b(?:filename|file name|path)(?: or extension)?(?: is)? too long\b/iu.test(
      error.message,
    )
  );
}

export function projectSetupFailureKey(
  job: Pick<ProjectReplicaJobSummary, "id" | "stateRevision">,
): string {
  return `${job.id}:${job.stateRevision}`;
}
