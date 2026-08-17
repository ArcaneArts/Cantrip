import type { TaskState } from "@cantrip/protocol";

const INTERACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "implementing",
  "paused",
  "blocked",
  "complete",
]);

export function taskChatIsInspectOnly(state: TaskState | undefined): boolean {
  return !state || !INTERACTIVE_TASK_STATES.has(state);
}
