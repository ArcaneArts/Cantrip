import type { ChatSummary, TaskDetail } from "@cantrip/protocol";

export function taskCanBeDeleted(
  task: TaskDetail | undefined,
  chatStatus?: ChatSummary["status"],
): boolean {
  if (!task || task.state === "complete") return false;
  return (
    (task.state === "draft" && task.dispatch === null) ||
    task.state === "failed" ||
    task.dispatch?.state === "queued" ||
    task.dispatch?.state === "failed" ||
    chatStatus === "failed"
  );
}
