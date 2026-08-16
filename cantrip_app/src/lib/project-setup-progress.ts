import type { ProjectReplicaJobSummary } from "@cantrip/protocol";

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
