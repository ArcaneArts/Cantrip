import type {
  ChatSummary,
  TaskAssociatedPullRequest,
  TaskDetail,
  TaskGoalSnapshot,
  TaskImplementationPlacement,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CirclePause,
  CircleStop,
  ClipboardCopy,
  ExternalLink,
  Folder,
  GitBranch,
  GitPullRequest,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Server,
  Target,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentInspectContent } from "@/components/chat/agent-inspect-content";
import { formatGoalElapsed } from "@/components/chat/goal-panel";
import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getTaskImplementationDashboard,
  interruptChat,
  setChatPaused,
  updateChatGoal,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { useChatMessageHistory } from "@/lib/use-chat-message-history";
import { cn } from "@/lib/utils";

import { TaskListBackButton } from "./task-list-back-button";

const goalLabels: Record<TaskGoalSnapshot["status"], string> = {
  active: "Running",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget reached",
  complete: "Complete",
};

export function taskImplementationStatusLabel(
  task: TaskDetail,
  goal: TaskGoalSnapshot | null,
  active = false,
): string {
  if (task.state === "failed") return "Failed";
  if (task.state === "paused") return "Paused";
  if (task.state === "blocked")
    return goal ? goalLabels[goal.status] : "Blocked";
  if (task.state === "complete") return "Complete";
  if (!task.planGoalEnabled && active) return "Running";
  return goal ? goalLabels[goal.status] : "Starting";
}

export function taskImplementationPlacementLabel(
  placement: TaskImplementationPlacement,
) {
  return placement.kind === "folder" ? "Direct folder" : "Git worktree";
}

export function taskImplementationShowsLiveActivity(
  task: TaskDetail,
  goal: TaskGoalSnapshot | null,
  active = false,
): boolean {
  return (
    task.state === "implementing" &&
    (task.planGoalEnabled ? goal?.status === "active" : active)
  );
}

export const TASK_IMPLEMENTATION_CONTENT_CLASS_NAME =
  "flex w-full flex-col px-4 py-5 sm:px-8";

function PullRequestRow({
  pullRequest,
}: {
  pullRequest: TaskAssociatedPullRequest;
}) {
  const status = pullRequest.merged
    ? "Merged"
    : pullRequest.state === "open"
      ? pullRequest.draft
        ? "Draft"
        : "Open"
      : "Closed";
  return (
    <a
      className="group flex min-w-0 items-center gap-3 border-t px-1 py-3 text-sm first:border-t-0 hover:bg-muted/30"
      href={pullRequest.url}
      rel="noreferrer"
      target="_blank"
    >
      <GitPullRequest
        className={cn(
          "size-4 shrink-0",
          pullRequest.merged
            ? "text-violet-500"
            : pullRequest.state === "open"
              ? "text-emerald-500"
              : "text-rose-500",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          #{pullRequest.number} {pullRequest.title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {pullRequest.headRef} → {pullRequest.baseRef}
          {pullRequest.worktreeName ? ` · ${pullRequest.worktreeName}` : ""}
          {` · ${pullRequest.associationKind} ${pullRequest.associationSource}`}
        </span>
      </span>
      <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
        {status}
      </Badge>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

export function TaskImplementationDashboard({
  chat,
  initialTask,
  onClose,
  workerName,
}: {
  chat: ChatSummary;
  initialTask: TaskDetail;
  onClose?(): void;
  workerName?: string;
}) {
  const queryClient = useQueryClient();
  const taskResourcesLive = useAppLiveStatus() === "live";
  const [copied, setCopied] = useState(false);
  const dashboard = useQuery({
    queryFn: () => getTaskImplementationDashboard(chat.id),
    queryKey: ["task-dashboard", chat.id],
    refetchInterval: liveResourceRefreshInterval(
      taskResourcesLive,
      chat.status === "running" || chat.status === "waiting-for-approval"
        ? 10_000
        : 30_000,
    ),
    retry: false,
  });
  const task = dashboard.data?.task ?? initialTask;
  const goal = dashboard.data?.goal ?? null;
  const active =
    chat.status === "running" || chat.status === "waiting-for-approval";
  const messages = useChatMessageHistory({
    autoLoadOlder: true,
    chatId: chat.id,
    refetchInterval: liveResourceRefreshInterval(
      taskResourcesLive,
      active ? 1_000 : 5_000,
    ),
  });

  useEffect(() => {
    if (dashboard.data?.task) {
      queryClient.setQueryData(["task", chat.id], dashboard.data.task);
    }
  }, [chat.id, dashboard.data?.task, queryClient]);

  const refresh = async () => {
    await Promise.all([dashboard.refetch(), messages.refetch()]);
  };
  const settleControls = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["task-dashboard", chat.id] }),
      queryClient.invalidateQueries({ queryKey: ["task", chat.id] }),
      queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
      queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
      queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
    ]);
  };
  const pause = useMutation({
    mutationFn: () => setChatPaused(chat.id, true),
    onSettled: settleControls,
  });
  const resume = useMutation({
    mutationFn: async () => {
      if (chat.automationPaused) await setChatPaused(chat.id, false);
      if (goal?.status === "paused" || goal?.status === "blocked") {
        await updateChatGoal(chat.id, { status: "active" });
      }
    },
    onSettled: settleControls,
  });
  const stop = useMutation({
    mutationFn: async () => {
      if (task.planGoalEnabled) await setChatPaused(chat.id, true);
      await interruptChat(chat.id);
      if (task.planGoalEnabled && goal?.status === "active") {
        await updateChatGoal(chat.id, { status: "paused" });
      }
    },
    onSettled: settleControls,
  });
  const controlError = pause.error ?? resume.error ?? stop.error;
  const controlPending = pause.isPending || resume.isPending || stop.isPending;
  const statusLabel = taskImplementationStatusLabel(task, goal, active);
  const tokenProgress =
    goal?.tokenBudget && goal.tokenBudget > 0
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : null;
  const showResume =
    task.planGoalEnabled &&
    (chat.automationPaused ||
      task.state === "paused" ||
      goal?.status === "paused" ||
      goal?.status === "blocked");
  const showLiveActivity = taskImplementationShowsLiveActivity(
    task,
    goal,
    active,
  );
  const showPause = task.planGoalEnabled && showLiveActivity;
  const latestMessages = useMemo(() => messages.data ?? [], [messages.data]);
  const placement = dashboard.data?.placement;
  const directFolder = placement?.kind === "folder";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={TASK_IMPLEMENTATION_CONTENT_CLASS_NAME}>
        <header className="flex flex-wrap items-center gap-3 border-b pb-4">
          {onClose ? <TaskListBackButton onBack={onClose} /> : null}
          <div className="grid size-9 place-items-center rounded-lg bg-violet-500/10 text-violet-500">
            <Target className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">
                {task.planGoalEnabled ? "Implementation" : "Task execution"}
              </h2>
              <Badge variant="outline">{statusLabel}</Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {task.planGoalEnabled
                ? "Goal mode on this Task's underlying Chat"
                : "Normal agent turn from the saved Task prompt"}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title="Refresh dashboard"
            disabled={dashboard.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={cn("size-3.5", dashboard.isFetching && "animate-spin")}
            />
            <span className="sr-only">Refresh dashboard</span>
          </Button>
          {showResume ? (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => resume.mutate()}
            >
              {resume.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Resume
            </Button>
          ) : showPause ? (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending || task.state === "complete"}
              onClick={() => pause.mutate()}
            >
              {pause.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Pause className="size-3.5" />
              )}
              Pause
            </Button>
          ) : null}
          {active ? (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={controlPending}
              onClick={() => stop.mutate()}
            >
              {stop.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CircleStop className="size-3.5" />
              )}
              {task.planGoalEnabled ? "Stop & pause" : "Stop"}
            </Button>
          ) : null}
        </header>

        {controlError ? (
          <p className="border-b py-3 text-xs text-destructive">
            {errorMessage(controlError)}
          </p>
        ) : null}
        {dashboard.isError ? (
          <p className="border-b py-3 text-xs text-destructive">
            {errorMessage(dashboard.error)}
          </p>
        ) : null}

        <section
          className={cn(
            "grid gap-0 border-b py-4",
            directFolder ? "sm:grid-cols-2" : "sm:grid-cols-3",
          )}
        >
          <div className="flex items-center gap-2 py-1 text-sm">
            <Server className="size-3.5 text-muted-foreground" />
            <span className="truncate">
              {workerName ?? placement?.workerId ?? "Worker"}
            </span>
          </div>
          {placement?.kind === "folder" ? (
            <div className="flex items-center gap-2 py-1 text-sm">
              <Folder className="size-3.5 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate">{placement.displayPath}</span>
                <span className="block text-xs text-muted-foreground">
                  {taskImplementationPlacementLabel(placement)} · direct writes
                  · no Git checkpoint
                </span>
              </span>
            </div>
          ) : placement?.kind === "git" ? (
            <>
              <div className="flex items-center gap-2 py-1 text-sm">
                <GitBranch className="size-3.5 text-muted-foreground" />
                <span className="truncate">
                  {placement?.worktreeName ?? "Worktree"}
                  {placement?.branch ? ` · ${placement.branch}` : " · detached"}
                </span>
              </div>
              <div className="flex items-center gap-2 py-1 text-sm">
                {placement?.dirty ? (
                  <CirclePause className="size-3.5 text-amber-500" />
                ) : (
                  <Check className="size-3.5 text-emerald-500" />
                )}
                <span>
                  {placement?.dirty
                    ? `${placement.dirtyFileCount} local change${placement.dirtyFileCount === 1 ? "" : "s"}`
                    : "Worktree clean"}
                </span>
              </div>
            </>
          ) : null}
        </section>

        {goal ? (
          <section className="border-b py-4" aria-label="Goal usage">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>{formatGoalElapsed(goal.timeUsedSeconds)} elapsed</span>
              <span>
                {goal.tokensUsed.toLocaleString()} tokens
                {goal.tokenBudget
                  ? ` / ${goal.tokenBudget.toLocaleString()}`
                  : ""}
              </span>
            </div>
            {tokenProgress !== null ? (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  aria-label="Goal token budget used"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(tokenProgress)}
                  className="h-full rounded-full bg-violet-500 transition-[width]"
                  role="progressbar"
                  style={{ width: `${tokenProgress}%` }}
                />
              </div>
            ) : null}
          </section>
        ) : dashboard.data?.goalUnavailableReason ? (
          <p className="border-b py-3 text-xs text-muted-foreground">
            {dashboard.data.goalUnavailableReason}
          </p>
        ) : null}

        {task.lastError?.operationKind === "implementation" ? (
          <section className="border-b py-4 text-sm">
            <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p className="whitespace-pre-wrap">{task.lastError.message}</p>
            </div>
          </section>
        ) : null}

        {dashboard.data?.warnings.length ? (
          <section
            className="border-b py-4"
            aria-labelledby="task-warning-heading"
          >
            <h3
              id="task-warning-heading"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Advisories
            </h3>
            <div className="mt-2 divide-y">
              {dashboard.data.warnings.map((warning, index) => (
                <div
                  key={`${warning.code}-${warning.pullRequestNumber ?? index}`}
                  className="flex items-start gap-2 py-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{warning.message}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {showLiveActivity ? (
          <section
            className="border-b py-5"
            aria-labelledby="task-activity-heading"
          >
            <h3
              id="task-activity-heading"
              className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Latest activity
            </h3>
            <div className="min-h-48 overflow-hidden">
              <AgentInspectContent
                active={active}
                messages={latestMessages}
                visible
              />
            </div>
          </section>
        ) : null}

        {placement && !directFolder ? (
          <section className="border-b py-5" aria-labelledby="task-pr-heading">
            <div className="flex items-center gap-2">
              <h3
                id="task-pr-heading"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Implementation pull requests
              </h3>
              {dashboard.data?.pullRequests.length ? (
                <Badge variant="outline" className="h-5 text-[10px]">
                  {dashboard.data.pullRequests.length}
                </Badge>
              ) : null}
            </div>
            {dashboard.data?.pullRequests.length ? (
              <div className="mt-2 divide-y">
                {dashboard.data.pullRequests.map((pullRequest) => (
                  <PullRequestRow
                    key={pullRequest.number}
                    pullRequest={pullRequest}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {dashboard.data?.pullRequestsUnavailableReason ??
                  "No Task-associated pull requests detected yet."}
              </p>
            )}
          </section>
        ) : null}

        <section className="py-6" aria-labelledby="task-plan-heading">
          <h3
            id="task-plan-heading"
            className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {task.planGoalEnabled ? "Final plan" : "Task prompt"}
          </h3>
          <Markdown>
            {task.planGoalEnabled
              ? (task.finalPlanMarkdown ?? "")
              : task.briefMarkdown}
          </Markdown>
          {task.goalPrompt ? (
            <details className="mt-8 border-y py-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Generated Goal prompt
              </summary>
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await navigator.clipboard.writeText(task.goalPrompt ?? "");
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1_500);
                  }}
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <ClipboardCopy className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {task.goalPrompt}
              </pre>
            </details>
          ) : null}
        </section>
      </div>
    </div>
  );
}
