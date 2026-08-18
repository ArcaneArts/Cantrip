import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type Collision,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { Ban, FolderGit2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProjectSurfaceIcon } from "./project-surface-icon";
import {
  decideWorkspaceDrop,
  type WorkspaceDndData,
  type WorkspaceDragItem,
  type WorkspaceDropDecision,
  type WorkspaceDropOperation,
  type WorkspaceDropTarget,
} from "@/lib/workspace-dnd-model";

export function filterWorkspacePointerCollisions(
  pointerCollisions: Collision[],
): Collision[] {
  if (pointerCollisions.length > 0) {
    const specific = pointerCollisions.filter((collision) => {
      const drop = (
        collision.data?.droppableContainer.data.current as
          WorkspaceDndData | undefined
      )?.drop;
      return drop?.type !== "top-bar" && drop?.type !== "sidebar-project";
    });
    return specific.length > 0 ? specific : pointerCollisions;
  }
  return [];
}

const workspaceCollisionDetection: CollisionDetection = (arguments_) => {
  return filterWorkspacePointerCollisions(pointerWithin(arguments_));
};

export function WorkspaceDragPreview({
  decision,
  drag,
}: {
  decision: WorkspaceDropDecision | null;
  drag: WorkspaceDragItem;
}) {
  return (
    <div
      className="flex w-56 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
      data-drop-status={decision?.status}
    >
      {drag.type === "project" ? (
        <FolderGit2 className="size-4 shrink-0" />
      ) : (
        <ProjectSurfaceIcon
          kind={drag.visualKind}
          className="size-4 shrink-0"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{drag.label}</span>
      {decision?.status === "invalid" ? (
        <span
          className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
          aria-label={decision.reason}
          title={decision.reason}
        >
          <Ban className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}

function dragData(
  event: Pick<DragStartEvent, "active">,
  layout: ProjectTabLayoutSummary | null | undefined,
  projects: readonly ProjectSummary[],
): WorkspaceDragItem | undefined {
  const explicit = (event.active.data.current as WorkspaceDndData | undefined)
    ?.drag;
  if (explicit) return explicit;
  const id = String(event.active.id);
  if (id.startsWith("project:")) {
    const projectId = id.slice("project:".length);
    return {
      type: "project",
      projectId,
      label:
        projects.find((project) => project.id === projectId)?.name ?? "Project",
    };
  }
  const group = layout?.groups.find(({ anchorTabKey }) => anchorTabKey === id);
  if (!group) return undefined;
  const kinds = new Set(group.members.map(({ tabKind }) => tabKind));
  return {
    type: "group",
    projectId: group.projectId,
    groupId: group.id,
    label: group.title,
    visualKind:
      kinds.size > 1 ? "mixed" : (group.members[0]?.tabKind ?? "mixed"),
  };
}

function dropData(
  event: DragOverEvent | DragEndEvent,
  layout: ProjectTabLayoutSummary | null | undefined,
): WorkspaceDropTarget | undefined {
  const explicit = (event.over?.data.current as WorkspaceDndData | undefined)
    ?.drop;
  if (explicit) return explicit;
  if (!event.over) return undefined;
  const id = String(event.over.id);
  if (id.startsWith("project:")) {
    return { type: "project", projectId: id.slice("project:".length) };
  }
  const group = layout?.groups.find(({ anchorTabKey }) => anchorTabKey === id);
  return group
    ? {
        type: "sidebar-group",
        projectId: group.projectId,
        groupId: group.id,
        groupPosition: group.position,
      }
    : undefined;
}

export function WorkspaceDndProvider({
  children,
  className,
  layout,
  onOperation,
  projects,
  tauriTitlebar,
}: {
  children: ReactNode;
  className?: string;
  layout: ProjectTabLayoutSummary | null | undefined;
  onOperation(operation: WorkspaceDropOperation): void;
  projects: readonly ProjectSummary[];
  tauriTitlebar?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [activeDrag, setActiveDrag] = useState<WorkspaceDragItem | null>(null);
  const [decision, setDecision] = useState<WorkspaceDropDecision | null>(null);
  const clear = () => {
    setActiveDrag(null);
    setDecision(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={workspaceCollisionDetection}
      onDragStart={(event) => {
        const drag = dragData(event, layout, projects);
        setActiveDrag(drag ?? null);
        setDecision(null);
      }}
      onDragOver={(event) =>
        setDecision(
          decideWorkspaceDrop(
            layout,
            dragData(event, layout, projects) ?? activeDrag,
            dropData(event, layout) ?? null,
          ),
        )
      }
      onDragCancel={clear}
      onDragEnd={(event) => {
        const nextDecision = decideWorkspaceDrop(
          layout,
          dragData(event, layout, projects) ?? activeDrag,
          dropData(event, layout) ?? null,
        );
        if (nextDecision.status === "valid") {
          onOperation(nextDecision.operation);
        }
        clear();
      }}
    >
      <main
        className={className}
        data-slot="app-shell"
        data-tauri-titlebar={tauriTitlebar}
      >
        {children}
      </main>
      <DragOverlay>
        {activeDrag ? (
          <WorkspaceDragPreview drag={activeDrag} decision={decision} />
        ) : null}
      </DragOverlay>
      <span className="sr-only" aria-live="polite">
        {decision?.status === "invalid" ? decision.reason : ""}
      </span>
    </DndContext>
  );
}
