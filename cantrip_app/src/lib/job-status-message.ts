import type {
  ChatImportJobSummary,
  ChatRelocationJobSummary,
  ProjectFolderSetupJobError,
  ProjectGithubConversionJobSummary,
  ProjectReplicaJobErrorCode,
  ProjectReplicaJobProgress,
  ProjectReplicaJobSummary,
} from "@cantrip/protocol";

function codeLabel(code: string): string {
  return code.replaceAll("-", " ");
}

const replicaProgressMessages: Record<
  ProjectReplicaJobProgress["stage"],
  string
> = {
  queued: "Waiting for the target worker.",
  dispatching: "Starting the repository operation.",
  validating: "Validating the repository target.",
  "validating-placement": "Validating the repository placement.",
  "inspecting-existing-checkout": "Inspecting the existing checkout.",
  fetching: "Fetching repository references.",
  inspecting: "Inspecting repository state.",
  materializing: "Preparing repository files.",
  "resolving-revision": "Resolving the requested revision.",
  verifying: "Verifying the repository.",
  "fast-forwarding": "Fast-forwarding the repository.",
  removing: "Removing worker-local repository files.",
  blocked: "Repository setup needs attention.",
  failed: "Repository setup failed.",
  succeeded: "Repository setup is complete.",
  cancelled: "Repository setup was cancelled.",
};

export function projectReplicaProgressMessage(
  stage: ProjectReplicaJobProgress["stage"],
): string {
  return replicaProgressMessages[stage];
}

export function projectReplicaErrorMessage(
  code: ProjectReplicaJobErrorCode,
): string {
  const messages: Partial<Record<ProjectReplicaJobErrorCode, string>> = {
    "worker-offline":
      "The target worker is offline. The job will resume after it reconnects.",
    "capability-missing":
      "The target worker does not support this repository operation.",
    "windows-long-paths-disabled":
      "Git for Windows needs long-path support before this repository can be stored here.",
    "worktree-dirty":
      "The repository has local changes and was left unchanged.",
    "revision-diverged":
      "The repository revision diverged from the requested revision.",
    "remote-unavailable": "The repository remote is unavailable.",
    "replica-in-use": "The repository replica is still in use.",
  };
  return messages[code] ?? `Repository operation failed: ${codeLabel(code)}.`;
}

export function projectReplicaJobMessage(
  job: Pick<ProjectReplicaJobSummary, "error" | "progress">,
): string {
  return job.error
    ? projectReplicaErrorMessage(job.error.code)
    : projectReplicaProgressMessage(job.progress.stage);
}

export function projectFolderSetupErrorMessage(
  code: ProjectFolderSetupJobError["code"],
): string {
  switch (code) {
    case "worker-offline":
      return "The owning worker is offline. Folder setup will resume after it reconnects.";
    case "capability-missing":
      return "The owning worker does not support managed folder creation.";
    case "materialization-failed":
      return "The worker could not create the managed folder.";
  }
}

export function projectGithubConversionJobMessage(
  job: Pick<ProjectGithubConversionJobSummary, "error" | "state">,
): string {
  if (!job.error) {
    return job.state === "succeeded"
      ? "GitHub conversion is complete."
      : "GitHub conversion is in progress.";
  }
  switch (job.error.code) {
    case "worker-offline":
      return "The owning worker is offline. Conversion will resume after it reconnects.";
    case "capability-missing":
      return "The owning worker does not support managed folder conversion.";
    case "github-auth-required":
      return "GitHub authentication is required on the owning worker.";
    case "repository-collision":
      return "This GitHub repository is already attached to another project.";
    default:
      return `GitHub conversion failed: ${codeLabel(job.error.code)}.`;
  }
}

export function chatRelocationJobMessage(
  job: Pick<ChatRelocationJobSummary, "error" | "progress">,
): string {
  if (job.error) {
    return job.error.code === "worker-offline"
      ? "A required worker is offline. Relocation will resume after it reconnects."
      : `Chat relocation failed: ${codeLabel(job.error.code)}.`;
  }
  const messages: Record<
    ChatRelocationJobSummary["progress"]["stage"],
    string
  > = {
    queued: "Relocation is queued for validation.",
    "waiting-for-idle": "Waiting for the active chat turn to finish.",
    recovering: "Recovering the interrupted relocation.",
    validating: "Validating source and target placement.",
    "preparing-replica": "Preparing the target worktree.",
    "transferring-attachments": "Transferring chat attachments.",
    "hydrating-runtime": "Hydrating the target runtime.",
    "ready-to-commit": "Committing the new chat placement.",
    blocked: "Chat relocation needs attention.",
    failed: "Chat relocation failed.",
    succeeded: "Chat relocation is complete.",
    cancelled: "Chat relocation was cancelled.",
  };
  return messages[job.progress.stage];
}

export function chatImportJobMessage(
  job: Pick<
    ChatImportJobSummary,
    "attachmentWarningCount" | "error" | "progress"
  >,
): string {
  if (job.error) {
    return job.error.code === "worker-offline"
      ? "A required worker is offline. Import will resume after it reconnects."
      : `Chat import failed: ${codeLabel(job.error.code)}.`;
  }
  const messages: Record<ChatImportJobSummary["progress"]["stage"], string> = {
    queued: "Waiting to read the source chat.",
    reading: "Reading source chat history.",
    importing: "Saving the canonical transcript.",
    "awaiting-hydration": "Waiting to hydrate the imported chat runtime.",
    hydrating: "Creating the imported chat runtime.",
    blocked: "Chat import needs attention.",
    failed: "Chat import failed.",
    succeeded:
      job.attachmentWarningCount > 0
        ? "Chat history is ready with unavailable attachments."
        : "Chat history is imported and ready to continue.",
  };
  return messages[job.progress.stage];
}

export function projectSetupErrorMessage(value: string | null): string | null {
  if (!value) return null;
  if (value === "cancelled") return "Repository setup was cancelled.";
  const replicaCode = value as ProjectReplicaJobErrorCode;
  if (replicaCode in projectReplicaErrorCodeSet) {
    return projectReplicaErrorMessage(replicaCode);
  }
  const folderCode = value as ProjectFolderSetupJobError["code"];
  if (folderCode in projectFolderErrorCodeSet) {
    return projectFolderSetupErrorMessage(folderCode);
  }
  return value;
}

const projectReplicaErrorCodeSet: Record<ProjectReplicaJobErrorCode, true> = {
  "target-not-found": true,
  "target-mismatch": true,
  "worker-offline": true,
  "capability-missing": true,
  "replica-not-ready": true,
  "worktree-dirty": true,
  "revision-diverged": true,
  "lease-conflict": true,
  "attachment-unavailable": true,
  "runtime-incompatible": true,
  "stale-attempt": true,
  "policy-denied": true,
  "remote-unavailable": true,
  "windows-long-paths-disabled": true,
  "placement-unsupported": true,
  "path-invalid": true,
  "path-permission-denied": true,
  "parent-creation-failed": true,
  "target-type-mismatch": true,
  "target-repository-mismatch": true,
  "target-not-primary-worktree": true,
  "target-owned-by-another-project": true,
  "target-revision-mismatch": true,
  "link-unsupported": true,
  "link-target-mismatch": true,
  "ownership-proof-missing": true,
  "replica-in-use": true,
  "unpushed-commits": true,
  "worker-error": true,
};

const projectFolderErrorCodeSet: Record<
  ProjectFolderSetupJobError["code"],
  true
> = {
  "worker-offline": true,
  "capability-missing": true,
  "materialization-failed": true,
};
