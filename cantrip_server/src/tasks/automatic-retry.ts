import type {
  TaskAutomaticRetry,
  TaskFailureKind,
} from "@cantrip/protocol/tasks";
export { taskFailureKindForError as classifyTaskFailure } from "@cantrip/protocol/tasks";

export const TASK_RETRY_DELAY_MS = 5_000;
export const TASK_RETRY_WINDOW_MS = 60_000;
export const TASK_RETRY_LIMIT = 5;
export const TASK_RETRY_CLAIM_MS = 5 * 60_000;

export interface TaskRetryRecord {
  status: "idle" | TaskAutomaticRetry["status"];
  failureKind: TaskFailureKind;
  failureKey: string;
  dueAt: number | null;
  attempts: number[];
  claim: { id: string; expiresAt: number } | null;
}

export function taskFailureIsRetryable(kind: TaskFailureKind) {
  return [
    "timeout",
    "capacity",
    "rate-limit",
    "connection",
    "runtime",
  ].includes(kind);
}

export function scheduleTaskRetry(
  previous: TaskRetryRecord | null,
  failureKey: string,
  failureKind: TaskFailureKind,
  now: number,
): TaskRetryRecord {
  // Repeated status reads must not restart a countdown or spend another retry.
  if (previous?.failureKey === failureKey) return previous;
  const attempts = (previous?.attempts ?? []).filter(
    (at) => at > now - TASK_RETRY_WINDOW_MS,
  );
  const latched =
    previous?.status === "latched" || attempts.length >= TASK_RETRY_LIMIT;
  return {
    status: latched
      ? "latched"
      : taskFailureIsRetryable(failureKind)
        ? "scheduled"
        : "manual",
    failureKind,
    failureKey,
    attempts,
    claim: null,
    dueAt:
      !latched && taskFailureIsRetryable(failureKind)
        ? now + TASK_RETRY_DELAY_MS
        : null,
  };
}

export function taskRetrySummary(
  record: TaskRetryRecord | null | undefined,
  now = Date.now(),
): TaskAutomaticRetry | null {
  if (!record || record.status === "idle") return null;
  return {
    status: record.status,
    failureKind: record.failureKind,
    nextAttemptAt:
      record.status === "scheduled" && record.dueAt !== null
        ? new Date(record.dueAt).toISOString()
        : null,
    recentAttempts: record.attempts.filter(
      (at) => at > now - TASK_RETRY_WINDOW_MS,
    ).length,
  };
}
