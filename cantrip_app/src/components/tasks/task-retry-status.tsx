import type { TaskDetail, TaskFailureKind } from "@cantrip/protocol/tasks";
import { useEffect, useState } from "react";

const labels: Record<TaskFailureKind, string> = {
  timeout: "Timeout",
  capacity: "Provider at capacity",
  "rate-limit": "Rate limited",
  connection: "Connection failure",
  runtime: "Runtime failure",
  "needs-input": "Needs your input",
  configuration: "Configuration needed",
  "usage-limit": "Usage limited",
  "budget-limit": "Budget reached",
};
export function taskRetryFailureLabel(task: TaskDetail) {
  return task.automaticRetry
    ? labels[task.automaticRetry.failureKind]
    : "Failed";
}
export function taskRetryStatusText(
  task: TaskDetail,
  paused = false,
  now = Date.now(),
) {
  const retry = task.automaticRetry;
  if (!retry || task.state === "complete") return null;
  if (paused || task.state === "paused") return "Automatic retry is paused.";
  const label = labels[retry.failureKind];
  if (retry.status === "latched")
    return `${label}. Automatic retries stopped: five attempts within 60 seconds. Retry to start a new window.`;
  if (retry.status === "manual")
    return `${label}. ${retry.failureKind === "needs-input" ? "Reply in Chat to continue." : "Review the issue, then Retry."}`;
  if (retry.status === "retrying") return `${label}. Retrying…`;
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(retry.nextAttemptAt!) - now) / 1000),
  );
  return seconds > 0
    ? `${label}. Retrying in ${seconds}s…`
    : `${label}. Waiting to retry…`;
}

/** Display only: scheduling and the rolling latch live on the server. */
export function TaskRetryStatus({
  task,
  paused = false,
  fallback = null,
}: {
  task: TaskDetail;
  paused?: boolean;
  fallback?: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (paused || task.automaticRetry?.status !== "scheduled") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [paused, task.automaticRetry?.status, task.automaticRetry?.nextAttemptAt]);
  // A newly reset deadline can render before the effect refreshes the old
  // tick. Never show six seconds from a stale render timestamp.
  return (
    taskRetryStatusText(task, paused, Math.max(now, Date.now())) ?? fallback
  );
}
