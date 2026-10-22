import type {
  ChatMessage,
  ChatSummary,
  TaskDetail,
  TaskGoalSnapshot,
} from "@cantrip/protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatGoalElapsed } from "@/components/chat/goal-panel";
import { projectTrajectory } from "@/components/chat/trajectory-model";
import { TrajectoryActivityBar } from "@/components/chat/trajectory-timeline";
import {
  taskExecutionMessages,
  taskOverviewMetrics,
} from "./task-overview-model";

export function TaskOverviewSummary({
  chat,
  goal,
  historyIncomplete = false,
  messages,
  task,
  visible,
}: {
  chat: ChatSummary;
  goal: TaskGoalSnapshot | null;
  historyIncomplete?: boolean;
  messages: readonly ChatMessage[];
  task: TaskDetail;
  visible: boolean;
}) {
  const active =
    chat.status === "running" || chat.status === "waiting-for-approval";
  const clockActive =
    task.state !== "complete" &&
    !chat.automationPaused &&
    (goal ? goal.status === "active" : active);
  const [clockMs, setClockMs] = useState(Date.now);
  const usageObservedAt = useRef(Date.now());
  useEffect(() => {
    usageObservedAt.current = Date.now();
  }, [goal?.timeUsedSeconds, goal?.status, chat.automationPaused]);
  useEffect(() => {
    if (!visible || !clockActive) return;
    setClockMs(Date.now());
    const interval = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [clockActive, visible]);
  const execution = useMemo(
    () => taskExecutionMessages(messages, task.implementationStartedAt),
    [messages, task.implementationStartedAt],
  );
  const metrics = useMemo(() => taskOverviewMetrics(execution), [execution]);
  const trajectory = useMemo(
    () => projectTrajectory({ active, messages: execution, nowMs: clockMs }),
    [active, clockMs, execution],
  );
  const started = Date.parse(task.implementationStartedAt ?? task.createdAt);
  const ended = task.completedAt
    ? Date.parse(task.completedAt)
    : active
      ? clockMs
      : Date.parse(task.updatedAt);
  const elapsed = goal
    ? goal.timeUsedSeconds +
      (clockActive
        ? Math.max(0, (clockMs - usageObservedAt.current) / 1_000)
        : 0)
    : Math.max(0, (ended - started) / 1_000 || 0);
  const count = (value: number) =>
    `${value.toLocaleString()}${historyIncomplete ? "+" : ""}`;
  const tokenProgress = goal?.tokenBudget
    ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
    : null;
  return (
    <section className="border-b py-5" aria-label="Task progress">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Elapsed</dt>
          <dd className="mt-1 text-xl font-medium tabular-nums">
            {formatGoalElapsed(elapsed)}
          </dd>
        </div>
        <div title="Agent turns, including the current turn">
          <dt className="text-xs text-muted-foreground">Turns</dt>
          <dd className="mt-1 text-xl font-medium tabular-nums">
            {count(metrics.turns)}
          </dd>
        </div>
        <div title="Distinct files in recorded agent edits">
          <dt className="text-xs text-muted-foreground">Files changed</dt>
          <dd className="mt-1 text-xl font-medium tabular-nums">
            {count(metrics.files)}
          </dd>
        </div>
        <div title="Added and removed lines in recorded edit previews. Large edits may be truncated.">
          <dt className="text-xs text-muted-foreground">Recorded lines</dt>
          <dd className="mt-1 flex gap-3 text-xl font-medium tabular-nums">
            <span
              className="text-emerald-500"
              aria-label={`${metrics.added} added lines`}
            >
              +{metrics.added.toLocaleString()}
            </span>
            <span
              className="text-rose-500"
              aria-label={`${metrics.removed} removed lines`}
            >
              −{metrics.removed.toLocaleString()}
            </span>
          </dd>
        </div>
      </dl>
      {goal ? (
        <div
          className="mt-4 text-xs text-muted-foreground"
          aria-label="Goal usage"
        >
          {goal.tokensUsed.toLocaleString()} tokens
          {goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ""}
        </div>
      ) : null}
      {tokenProgress !== null ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            role="progressbar"
            aria-label="Goal token budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(tokenProgress)}
            className="h-full bg-violet-500"
            style={{ width: `${tokenProgress}%` }}
          />
        </div>
      ) : null}
      <div className="mt-5">
        <TrajectoryActivityBar turn={trajectory} />
      </div>
    </section>
  );
}
