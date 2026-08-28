import type { TaskDetail } from "@cantrip/protocol";

export function taskCanBeDeleted(task: TaskDetail | undefined): boolean {
  return task !== undefined;
}
