import {
  gitChangeSummarySchema,
  type ChatSummary,
  type TaskDetail,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { runProtectedRepositoryOperation } from "@/lib/api/repository-operations";

export function taskGitChangesQueryKey(
  projectId: string | null,
  worktreeId: string | null,
  since: string,
  until: string | null,
) {
  return ["task-git-changes", projectId, worktreeId, since, until] as const;
}

/** Query the Task binding, independent of the worktree selected elsewhere in the IDE. */
export function TaskGitChangeMetrics({
  chat,
  task,
  visible,
  worktreeId,
}: {
  chat: ChatSummary;
  task: TaskDetail;
  visible: boolean;
  worktreeId?: string | null;
}) {
  const projectId = chat.projectId;
  const target =
    worktreeId === undefined ? (chat.activeWorktreeId ?? null) : worktreeId;
  const since = task.implementationStartedAt ?? task.createdAt;
  const until = task.completedAt;
  const changes = useQuery({
    queryKey: taskGitChangesQueryKey(projectId, target, since, until),
    enabled: visible && Boolean(projectId && target),
    queryFn: () =>
      runProtectedRepositoryOperation({
        projectId: projectId!,
        worktreeId: target!,
        type: "git.change-summary",
        arguments: { since, until },
        resultSchema: gitChangeSummarySchema,
      }),
    staleTime: 5_000,
    refetchInterval: visible ? 10_000 : false,
    retry: false,
  });
  const data = changes.data;
  const pending = Boolean(projectId && target) && changes.isPending;
  const unavailable = !target
    ? "Git change counts are unavailable for this execution folder."
    : changes.error instanceof Error
      ? changes.error.message
      : "Git change counts are unavailable.";
  const description = data
    ? "Distinct file paths and cumulative added/removed lines in commits on this worktree's current branch during the task, plus its current staged, unstaged, and untracked changes. Includes edits from other processes using the same worktree. Binary files count toward files changed, but have no line totals."
    : pending
      ? "Reading changes from the task's worktree…"
      : unavailable;
  const empty = pending ? "…" : "—";
  return (
    <>
      <div title={description}>
        <dt className="text-xs text-muted-foreground">Files changed</dt>
        <dd className="mt-1 text-xl font-medium tabular-nums">
          {data
            ? `${data.filesChanged.toLocaleString()}${data.partial ? "+" : ""}`
            : empty}
        </dd>
      </div>
      <div title={description}>
        <dt className="text-xs text-muted-foreground">Lines changed</dt>
        <dd className="mt-1">
          <div className="flex gap-3 text-xl font-medium tabular-nums">
            {data ? (
              <>
                <span
                  className="text-emerald-500"
                  aria-label={`${data.additions} added lines`}
                >
                  +{data.additions.toLocaleString()}
                </span>
                <span
                  className="text-rose-500"
                  aria-label={`${data.deletions} removed lines`}
                >
                  −{data.deletions.toLocaleString()}
                </span>
              </>
            ) : (
              <span>{empty}</span>
            )}
          </div>
          {data ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {changes.isError
                ? "Could not refresh · "
                : data.partial
                  ? "Partial totals · "
                  : ""}
              {data.commits.toLocaleString()} commit
              {data.commits === 1 ? "" : "s"} ·{" "}
              {data.uncommittedFiles.toLocaleString()} uncommitted
            </p>
          ) : !pending ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Git stats unavailable
            </p>
          ) : null}
        </dd>
      </div>
    </>
  );
}
