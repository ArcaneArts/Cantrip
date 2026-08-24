import type {
  ChatSummary,
  TaskDetail,
  TaskWorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  ClipboardList,
  Loader2,
  Pause,
  Play,
  Settings2,
} from "lucide-react";
import { useMemo } from "react";

import { summarizePlanProgress } from "@/components/chat/chat-plan-progress";
import {
  projectTrajectory,
  type TrajectoryLane,
} from "@/components/chat/trajectory-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { useAppLiveStatus } from "@/lib/app-live-react";
import {
  getProjectTaskPauseState,
  getProjectTaskWorkload,
  getTaskWorkers,
  setProjectTaskPauseState,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export type ProjectTaskWorkloadItem = Awaited<
  ReturnType<typeof getProjectTaskWorkload>
>["items"][number];

export type ProjectTaskWorkloadBand =
  "attention" | "running" | "queued" | "completed";

export interface ProjectTaskWorkloadPresentation {
  band: ProjectTaskWorkloadBand;
  label: string;
  paused: boolean;
  tone: "attention" | "completed" | "muted" | "running";
}

const activeBandOrder: Record<ProjectTaskWorkloadBand, number> = {
  attention: 0,
  running: 1,
  queued: 2,
  completed: 3,
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const laneColors: Record<TrajectoryLane, string> = {
  input: "bg-slate-400",
  model: "bg-violet-500",
  tools: "bg-sky-500",
  changes: "bg-emerald-500",
};

function titleCaseCode(code: string): string {
  return code
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function projectTaskWorkloadPresentation(
  task: TaskDetail,
  chat: ChatSummary | undefined,
  projectPaused: boolean,
): ProjectTaskWorkloadPresentation {
  const dispatch = task.dispatch;
  if (task.state === "complete") {
    return {
      band: "completed",
      label: "Completed",
      paused: false,
      tone: "completed",
    };
  }
  if (
    chat?.status === "waiting-for-approval" ||
    (chat?.status === "failed" && dispatch?.state !== "queued")
  ) {
    return {
      band: "attention",
      label:
        chat.status === "waiting-for-approval" ? "Needs approval" : "Failed",
      paused: false,
      tone: "attention",
    };
  }
  if (dispatch?.state === "queued") {
    const paused = projectPaused;
    return {
      band: "queued",
      label: paused ? "Paused · queued" : "Queued",
      paused,
      tone: "muted",
    };
  }
  if (
    dispatch?.state === "claimed" ||
    dispatch?.state === "running" ||
    dispatch?.state === "paused"
  ) {
    const paused = dispatch.state === "paused";
    return {
      band: "running",
      label: paused ? "Paused" : "Running",
      paused,
      tone: paused ? "muted" : "running",
    };
  }
  if (
    task.state === "failed" ||
    task.state === "blocked" ||
    task.state === "review" ||
    dispatch?.state === "failed" ||
    dispatch?.state === "cancelled" ||
    dispatch?.state === "expired"
  ) {
    return {
      band: "attention",
      label:
        task.state === "failed" || dispatch?.state === "failed"
          ? "Failed"
          : dispatch?.state === "expired"
            ? "Needs recovery"
            : dispatch?.state === "cancelled"
              ? "Cancelled"
              : task.state === "blocked"
                ? "Blocked"
                : task.currentQuestions.length > 0
                  ? "Needs answers"
                  : "Needs review",
      paused: false,
      tone: "attention",
    };
  }
  if (!dispatch && task.state === "draft") {
    return {
      band: "attention",
      label: "Draft",
      paused: false,
      tone: "attention",
    };
  }
  if (
    task.state === "planning" ||
    task.state === "finalizing" ||
    task.state === "implementing" ||
    task.state === "paused"
  ) {
    const paused = task.state === "paused";
    return {
      band: "running",
      label: paused ? "Paused" : "Running",
      paused,
      tone: paused ? "muted" : "running",
    };
  }
  return {
    band: "queued",
    label: projectPaused ? "Paused · queued" : "Queued",
    paused: projectPaused,
    tone: "muted",
  };
}

export function sortProjectTaskWorkload(
  items: readonly ProjectTaskWorkloadItem[],
  chats: ReadonlyMap<string, ChatSummary>,
  projectPaused: boolean,
): {
  active: ProjectTaskWorkloadItem[];
  completed: ProjectTaskWorkloadItem[];
} {
  const active: ProjectTaskWorkloadItem[] = [];
  const completed: ProjectTaskWorkloadItem[] = [];
  for (const item of items) {
    const presentation = projectTaskWorkloadPresentation(
      item.task,
      chats.get(item.task.chatId),
      projectPaused,
    );
    (presentation.band === "completed" ? completed : active).push(item);
  }
  active.sort((left, right) => {
    const leftBand = projectTaskWorkloadPresentation(
      left.task,
      chats.get(left.task.chatId),
      projectPaused,
    ).band;
    const rightBand = projectTaskWorkloadPresentation(
      right.task,
      chats.get(right.task.chatId),
      projectPaused,
    ).band;
    return (
      activeBandOrder[leftBand] - activeBandOrder[rightBand] ||
      right.task.priority - left.task.priority ||
      Date.parse(right.task.createdAt) - Date.parse(left.task.createdAt) ||
      left.task.chatId.localeCompare(right.task.chatId)
    );
  });
  completed.sort(
    (left, right) =>
      Date.parse(right.task.completedAt ?? right.task.updatedAt) -
        Date.parse(left.task.completedAt ?? left.task.updatedAt) ||
      left.task.chatId.localeCompare(right.task.chatId),
  );
  return { active, completed };
}

function promptSummary(markdown: string): string {
  const line = markdown
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line?.replace(/^#{1,6}\s+/u, "") ?? "No Task prompt yet";
}

function TaskTrajectoryBar({ item }: { item: ProjectTaskWorkloadItem }) {
  const active =
    item.task.dispatch?.state === "running" ||
    item.task.dispatch?.state === "claimed";
  const trajectory = projectTrajectory({
    active,
    messages: item.messages,
    nowMs: Date.now(),
  });
  const rootEvents = trajectory?.events.filter((event) => event.agentIsRoot);
  if (!rootEvents || rootEvents.length === 0) return null;
  const lanes = (["input", "model", "tools", "changes"] as const)
    .map((lane) => ({
      count: rootEvents.filter((event) => event.lane === lane).length,
      lane,
    }))
    .filter(({ count }) => count > 0);
  return (
    <div
      aria-label="Root agent trajectory"
      className="flex h-1.5 w-28 overflow-hidden rounded-full bg-muted"
      title={`${rootEvents.length} root agent trajectory event${rootEvents.length === 1 ? "" : "s"}`}
    >
      {lanes.map(({ count, lane }) => (
        <span
          key={lane}
          className={cn("h-full", laneColors[lane])}
          style={{ flexGrow: count }}
        />
      ))}
    </div>
  );
}

function TaskWorkloadRow({
  chat,
  item,
  onOpen,
  paused,
  taskWorkers,
}: {
  chat: ChatSummary | undefined;
  item: ProjectTaskWorkloadItem;
  onOpen(): void;
  paused: boolean;
  taskWorkers: ReadonlyMap<string, TaskWorkerSummary>;
}) {
  const { task } = item;
  const presentation = projectTaskWorkloadPresentation(task, chat, paused);
  const progress = summarizePlanProgress(item.plan.steps);
  const requestedWorker = task.requestedTaskWorkerId
    ? (taskWorkers.get(task.requestedTaskWorkerId)?.name ??
      "Unavailable worker")
    : "Auto";
  const claimedWorker = task.dispatch?.selectedTaskWorkerId
    ? (taskWorkers.get(task.dispatch.selectedTaskWorkerId)?.name ??
      "Unavailable worker")
    : null;
  const actionLabel =
    presentation.band === "attention"
      ? task.state === "draft"
        ? "Edit"
        : "Review"
      : presentation.band === "queued"
        ? "Edit"
        : "Open";
  return (
    <div
      className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {chat?.title ?? promptSummary(task.briefMarkdown)}
          </span>
          <Badge
            className={cn(
              presentation.tone === "attention" &&
                "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
              presentation.tone === "running" &&
                "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300",
              presentation.tone === "completed" &&
                "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            variant="outline"
          >
            {presentation.tone === "attention" ? (
              <AlertTriangle className="size-3" />
            ) : presentation.tone === "running" ? (
              <CirclePlay className="size-3" />
            ) : presentation.tone === "completed" ? (
              <CheckCircle2 className="size-3" />
            ) : presentation.paused ? (
              <CirclePause className="size-3" />
            ) : null}
            {presentation.label}
          </Badge>
          <Badge variant="secondary">
            {task.planGoalEnabled ? "Plan + Goal" : "Direct"}
          </Badge>
          <span className="text-xs tabular-nums text-muted-foreground">
            P{task.priority}
          </span>
          {progress ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              Steps {progress.currentStepNumber} of {progress.total}
            </span>
          ) : null}
          <TaskTrajectoryBar item={item} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {promptSummary(task.briefMarkdown)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>Assignment: {requestedWorker}</span>
          {claimedWorker ? <span>Worker: {claimedWorker}</span> : null}
          <span title={task.createdAt}>
            Created {dateTime.format(new Date(task.createdAt))}
          </span>
          {task.completedAt ? (
            <span title={task.completedAt}>
              Completed {dateTime.format(new Date(task.completedAt))}
            </span>
          ) : null}
          {task.dispatch?.eligibilityCode ? (
            <span className="text-amber-700 dark:text-amber-300">
              {titleCaseCode(task.dispatch.eligibilityCode)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 self-center">
        <Button
          aria-label={`${actionLabel} ${chat?.title ?? "Task"}`}
          className="sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          size="sm"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {actionLabel}
        </Button>
        <ChevronRight className="size-4 text-muted-foreground" />
      </div>
    </div>
  );
}

function WorkloadList({
  chats,
  items,
  label,
  onOpenTask,
  paused,
  taskWorkers,
}: {
  chats: ReadonlyMap<string, ChatSummary>;
  items: ProjectTaskWorkloadItem[];
  label: string;
  onOpenTask(chatId: string): void;
  paused: boolean;
  taskWorkers: ReadonlyMap<string, TaskWorkerSummary>;
}) {
  return (
    <section aria-label={label}>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card/65 shadow-sm">
        {items.length > 0 ? (
          items.map((item) => (
            <TaskWorkloadRow
              key={item.task.chatId}
              chat={chats.get(item.task.chatId)}
              item={item}
              paused={paused}
              taskWorkers={taskWorkers}
              onOpen={() => onOpenTask(item.task.chatId)}
            />
          ))
        ) : (
          <p className="px-5 py-7 text-center text-sm text-muted-foreground">
            {label === "Completed"
              ? "No completed Tasks yet."
              : "No active Tasks."}
          </p>
        )}
      </div>
    </section>
  );
}

export function ProjectTasksDashboard({
  chats,
  onConfigureWorkers,
  onOpenTask,
  projectId,
}: {
  chats: ChatSummary[];
  onConfigureWorkers(): void;
  onOpenTask(chatId: string): void;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const live = useAppLiveStatus() === "live";
  const workload = useQuery({
    queryKey: ["project-task-workload", projectId],
    queryFn: () => getProjectTaskWorkload(projectId),
    refetchInterval: live ? false : 3_000,
  });
  const taskWorkers = useQuery({
    queryKey: ["task-workers"],
    queryFn: getTaskWorkers,
    refetchInterval: live ? false : 5_000,
  });
  const pauseState = useQuery({
    queryKey: ["project-task-pause", projectId],
    queryFn: () => getProjectTaskPauseState(projectId),
    refetchInterval: live ? false : 3_000,
  });
  const pauseMutation = useMutation({
    mutationFn: async (paused: boolean) => {
      const current = pauseState.data;
      if (!current) throw new Error("Task pause state is still loading.");
      return setProjectTaskPauseState(projectId, {
        paused,
        rowVersion: current.rowVersion,
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["project-task-pause", projectId], next);
      void queryClient.invalidateQueries({
        queryKey: ["project-task-workload", projectId],
      });
    },
  });
  const chatMap = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );
  const workerMap = useMemo(
    () =>
      new Map((taskWorkers.data ?? []).map((worker) => [worker.id, worker])),
    [taskWorkers.data],
  );
  const sorted = useMemo(
    () =>
      sortProjectTaskWorkload(
        workload.data?.items ?? [],
        chatMap,
        pauseState.data?.paused ?? false,
      ),
    [chatMap, pauseState.data?.paused, workload.data?.items],
  );

  if (taskWorkers.isLoading) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (taskWorkers.isError) {
    return (
      <EmptyState>
        <EmptyStateContent>
          <EmptyStateIcon>
            <AlertTriangle className="size-5 text-destructive" />
          </EmptyStateIcon>
          <EmptyStateTitle>Task Workers unavailable</EmptyStateTitle>
          <EmptyStateDescription>
            {taskWorkers.error instanceof Error
              ? taskWorkers.error.message
              : "Cantrip could not load Task Worker settings."}
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button
              variant="outline"
              onClick={() => void taskWorkers.refetch()}
            >
              Try again
            </Button>
          </EmptyStateActions>
        </EmptyStateContent>
      </EmptyState>
    );
  }
  if ((taskWorkers.data?.length ?? 0) === 0) {
    return (
      <EmptyState>
        <EmptyStateContent>
          <EmptyStateIcon>
            <Settings2 className="size-5" />
          </EmptyStateIcon>
          <EmptyStateTitle>No Task Workers configured</EmptyStateTitle>
          <EmptyStateDescription>
            Add a Task Worker before Tasks can leave the queue. Its model,
            reasoning, capabilities, and concurrency apply across projects.
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button onClick={onConfigureWorkers}>Configure Task Workers</Button>
          </EmptyStateActions>
        </EmptyStateContent>
      </EmptyState>
    );
  }
  if (workload.isLoading || pauseState.isLoading) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  const error = workload.error ?? pauseState.error ?? taskWorkers.error;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-7">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardList className="size-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {pauseState.data?.paused
                ? "This project workload is paused. Running turns are parked and capacity is released."
                : "Needs-attention Tasks are first; workers claim eligible queued Tasks FIFO."}
            </p>
          </div>
          <Button
            pending={pauseMutation.isPending}
            variant="outline"
            onClick={() => pauseMutation.mutate(!pauseState.data?.paused)}
          >
            {pauseState.data?.paused ? (
              <Play className="size-4" />
            ) : (
              <Pause className="size-4" />
            )}
            {pauseState.data?.paused ? "Resume Tasks" : "Pause Tasks"}
          </Button>
        </header>
        {error || pauseMutation.isError ? (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error instanceof Error
              ? error.message
              : pauseMutation.error instanceof Error
                ? pauseMutation.error.message
                : "The Task workload could not be loaded."}
          </div>
        ) : null}
        <div className="space-y-7">
          <WorkloadList
            chats={chatMap}
            items={sorted.active}
            label="Active"
            paused={pauseState.data?.paused ?? false}
            taskWorkers={workerMap}
            onOpenTask={onOpenTask}
          />
          <WorkloadList
            chats={chatMap}
            items={sorted.completed}
            label="Completed"
            paused={false}
            taskWorkers={workerMap}
            onOpenTask={onOpenTask}
          />
        </div>
      </div>
    </div>
  );
}
