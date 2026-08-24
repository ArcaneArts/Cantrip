import type {
  ChatSummary,
  SettingsBundle,
  WorkerSummary,
} from "@cantrip/protocol";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import { TaskSurface } from "./task-surface";

export const MAX_RETAINED_TASK_VIEWS = 8;

export interface ActiveTaskView {
  chat: ChatSummary;
  worker?: WorkerSummary;
}

export function retainTaskSurfaceTabs(
  retained: ActiveTaskView[],
  active: ActiveTaskView,
  limit = MAX_RETAINED_TASK_VIEWS,
): ActiveTaskView[] {
  const withoutActive = retained.filter(
    (candidate) => candidate.chat.id !== active.chat.id,
  );
  return [...withoutActive, active].slice(-Math.max(1, limit));
}

export function PersistentTaskViews({
  activeTask,
  onClose,
  onRename,
  settings,
}: {
  activeTask: ActiveTaskView | null;
  onClose?(): void;
  onRename(chatId: string, title: string): void;
  settings: SettingsBundle | undefined;
}) {
  const [retainedTasks, setRetainedTasks] = useState<ActiveTaskView[]>([]);

  useEffect(() => {
    if (!activeTask) return;
    setRetainedTasks((current) => retainTaskSurfaceTabs(current, activeTask));
  }, [activeTask]);

  const renderedTasks = useMemo(
    () =>
      activeTask
        ? retainTaskSurfaceTabs(retainedTasks, activeTask)
        : retainedTasks,
    [activeTask, retainedTasks],
  );

  return renderedTasks.map((retained) => {
    const active = activeTask?.chat.id === retained.chat.id;
    return (
      <div
        key={retained.chat.id}
        aria-hidden={!active}
        className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}
      >
        <TaskSurface
          chat={retained.chat}
          onClose={active ? onClose : undefined}
          settings={settings}
          worker={retained.worker}
          onRename={(title) => onRename(retained.chat.id, title)}
        />
      </div>
    );
  });
}
