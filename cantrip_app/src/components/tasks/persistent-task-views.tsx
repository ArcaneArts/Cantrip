import type {
  ChatSummary,
  SettingsBundle,
  WorkerSummary,
} from "@cantrip/protocol";
import { useEffect, useMemo, useState, type Ref } from "react";

import { cn } from "@/lib/utils";

import { TaskSurface, type TaskSurfaceHandle } from "./task-surface";

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
  deleting,
  onClose,
  onDelete,
  onRename,
  settings,
  surfaceRef,
}: {
  activeTask: ActiveTaskView | null;
  deleting?: boolean;
  onClose?(): void;
  onDelete?(): void;
  onRename(chatId: string, title: string): void;
  settings: SettingsBundle | undefined;
  surfaceRef?: Ref<TaskSurfaceHandle>;
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
          deleting={active ? deleting : false}
          onClose={active ? onClose : undefined}
          onDelete={active ? onDelete : undefined}
          settings={settings}
          surfaceRef={active ? surfaceRef : undefined}
          worker={retained.worker}
          onRename={(title) => onRename(retained.chat.id, title)}
        />
      </div>
    );
  });
}
