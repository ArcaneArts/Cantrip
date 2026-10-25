import type { TaskDetail } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";

/** A scheduler eligibility reason explains a queue wait, not a failed task. */
export function TaskDispatchStatus({
  dispatch,
  paused = false,
}: {
  dispatch: TaskDetail["dispatch"];
  paused?: boolean;
}) {
  const code = dispatch?.eligibilityCode;
  if (!code) return null;
  if (dispatch.state === "queued" && code === "encryption-grant-unavailable") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1 text-muted-foreground"
        title="The task is saved in the queue. The worker needs its own encryption authorization, separate from this unlocked workspace. The scheduler checks again automatically."
      >
        {!paused ? (
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
        ) : null}
        {paused
          ? "Worker authorization pending (paused)"
          : "Waiting for worker authorization…"}
      </span>
    );
  }
  return (
    <span className="text-amber-700 dark:text-amber-300">
      {code
        .split("-")
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ")}
    </span>
  );
}
