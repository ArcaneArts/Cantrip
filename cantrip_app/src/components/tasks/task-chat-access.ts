import type { TaskDetail, TaskState } from "@cantrip/protocol";

const INTERACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "implementing",
  "paused",
  "blocked",
  "complete",
]);

export function taskChatIsInspectOnly(
  task: Pick<TaskDetail, "state" | "implementationStartedAt"> | undefined,
): boolean {
  if (!task) return true;
  if (task.state === "failed" && task.implementationStartedAt) return false;
  return !INTERACTIVE_TASK_STATES.has(task.state);
}
