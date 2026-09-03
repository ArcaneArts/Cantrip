import type { GithubActionsJob, GithubActionsRun } from "@cantrip/protocol";

export const githubActionsFailedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "stale",
  "timed_out",
]);

export interface GithubActionsTarget {
  runId: number;
  jobId: number | null;
}

export interface GithubActionsViewStatus {
  activeRunCount: number;
  isFetching: boolean;
  runCount: number;
}

export function githubActionsRunIsActive(run: GithubActionsRun): boolean {
  return run.status !== "completed";
}

export function githubActionsStatusLabel(input: {
  conclusion: string | null;
  status: string;
}): string {
  return (
    input.status === "completed"
      ? (input.conclusion ?? "completed")
      : input.status
  )
    .replaceAll("_", " ")
    .replaceAll("-", " ");
}

export function githubActionsRunAgentPrompt(
  run: GithubActionsRun,
  jobs: GithubActionsJob[],
): string {
  const failedJobs = jobs.filter((job) =>
    githubActionsFailedConclusions.has(job.conclusion ?? ""),
  );
  const jobContext = failedJobs.length
    ? `\n\nFailed jobs:\n${failedJobs.map((job) => `- ${job.name}: ${githubActionsStatusLabel(job)}`).join("\n")}`
    : "";
  return [
    `Investigate and fix GitHub Actions workflow run #${run.runNumber} (${run.name}) in this pinned worktree.`,
    `The worktree starts at the exact failing commit ${run.headSha}.`,
    `Run URL: ${run.url}`,
    `Trigger: ${run.event}${run.headBranch ? ` on ${run.headBranch}` : ""}.${jobContext}`,
    "Inspect the workflow definition and reproduce the failed jobs locally where practical. Make the smallest appropriate fix, run focused validation, and summarize what caused the failure. Do not rewrite or bypass the workflow merely to make it green.",
  ].join("\n\n");
}

export function parseGithubActionsUrl(
  value: string | null,
): GithubActionsTarget | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const match = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/u.exec(url.pathname);
    if (!match) return null;
    const runId = Number(match[1]);
    const jobId = match[2] ? Number(match[2]) : null;
    return Number.isInteger(runId) && runId > 0
      ? {
          runId,
          jobId:
            jobId !== null && Number.isInteger(jobId) && jobId > 0
              ? jobId
              : null,
        }
      : null;
  } catch {
    return null;
  }
}
