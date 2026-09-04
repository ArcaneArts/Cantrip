import { createContext, useContext, type ReactNode } from "react";

import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type {
  WorkspaceDragItem,
  WorkspaceDropDecision,
  WorkspaceDropTarget,
} from "@/lib/workspace-dnd-model";

export interface WorkspaceDndState {
  activeDrag: WorkspaceDragItem | null;
  decision: WorkspaceDropDecision | null;
  dropTarget: WorkspaceDropTarget | null;
}

const WorkspaceDndStateContext = createContext<WorkspaceDndState>({
  activeDrag: null,
  decision: null,
  dropTarget: null,
});

export function WorkspaceDndStateProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkspaceDndState;
}) {
  return (
    <WorkspaceDndStateContext.Provider value={value}>
      {children}
    </WorkspaceDndStateContext.Provider>
  );
}

export function useWorkspaceDndState(): WorkspaceDndState {
  return useContext(WorkspaceDndStateContext);
}

export function WorkspaceDropPlaceholder({
  active,
  compact = false,
  label,
  orientation,
  paneId,
  tabKey,
  visualKind,
}: {
  active: boolean;
  compact?: boolean;
  label: string;
  orientation: "horizontal" | "vertical";
  paneId: string | null;
  tabKey: string;
  visualKind: Extract<WorkspaceDragItem, { type: "surface" }>["visualKind"];
}) {
  const horizontal = orientation === "horizontal";
  const expandedWidth = compact ? 40 : 160;
  return (
    <div
      aria-hidden={!active}
      aria-label={active ? `Drop ${label} here` : undefined}
      className={`shrink-0 overflow-hidden transition-[width,height,opacity] duration-150 ease-out ${active ? "opacity-70" : "opacity-0"}`}
      data-workspace-drop-placeholder={active ? tabKey : undefined}
      data-workspace-drop-placeholder-pane={
        active ? (paneId ?? "new-pane") : undefined
      }
      style={{
        height: horizontal ? 40 : active ? 40 : 0,
        width: horizontal ? (active ? expandedWidth : 0) : 40,
      }}
    >
      <div
        className={
          compact
            ? "grid size-10 place-items-center border border-primary/50 bg-primary/10 text-primary"
            : "flex h-10 w-40 items-center gap-2 rounded-t-md border border-primary/50 bg-primary/10 px-3 text-xs text-primary"
        }
      >
        <ProjectSurfaceIcon className="size-4 shrink-0" kind={visualKind} />
        {!compact ? <span className="truncate">{label}</span> : null}
      </div>
    </div>
  );
}
