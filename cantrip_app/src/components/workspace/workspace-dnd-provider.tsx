import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  useDroppable,
  type CollisionDetection,
  type Collision,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { Ban, FolderGit2 } from "lucide-react";
import {
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { ProjectSurfaceIcon } from "./project-surface-icon";
import { WorkspaceDndStateProvider } from "./workspace-dnd-state";
import {
  decideWorkspaceDrop,
  type WorkspaceDndData,
  type WorkspaceDragItem,
  type WorkspaceDropDecision,
  type WorkspaceDropOperation,
  type WorkspaceDropTarget,
  workspacePaneTargetDropId,
} from "@/lib/workspace-dnd-model";

export function canStartWorkspacePointerDrag(event: {
  button: number;
  ctrlKey: boolean;
  isPrimary: boolean;
}): boolean {
  return event.isPrimary && event.button === 0 && !event.ctrlKey;
}

class WorkspacePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions,
      ) => {
        if (!canStartWorkspacePointerDrag(event)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

export function filterWorkspacePointerCollisions(
  pointerCollisions: Collision[],
): Collision[] {
  if (pointerCollisions.length > 0) {
    for (const targetType of [
      "pane-edge",
      "pane-tab",
      "pane-target",
      "region",
      "pane-strip",
    ] as const) {
      const matches = pointerCollisions.filter((collision) => {
        const drop = (
          collision.data?.droppableContainer.data.current as
            WorkspaceDndData | undefined
        )?.drop;
        return drop?.type === targetType;
      });
      if (matches.length > 0) return matches;
    }
    const typed = pointerCollisions.filter((collision) => {
      const drop = (
        collision.data?.droppableContainer.data.current as
          WorkspaceDndData | undefined
      )?.drop;
      return Boolean(drop);
    });
    return typed.length > 0 ? typed : pointerCollisions;
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
      data-workspace-drag-preview={drag.type}
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
  const pane = layout?.panes.find(({ anchorTabKey }) => anchorTabKey === id);
  if (!pane) return undefined;
  const kinds = new Set(pane.members.map(({ tabKind }) => tabKind));
  return {
    type: "pane",
    projectId: pane.projectId,
    paneId: pane.id,
    label: pane.title,
    region: pane.region,
    visualKind:
      kinds.size > 1 ? "mixed" : (pane.members[0]?.tabKind ?? "mixed"),
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
  const pane = layout?.panes.find(({ anchorTabKey }) => anchorTabKey === id);
  return pane
    ? {
        type: "pane",
        projectId: pane.projectId,
        paneId: pane.id,
        panePosition: pane.position,
        region: pane.region,
      }
    : undefined;
}

function PaneDropTarget({
  activePaneId,
  pane,
}: {
  activePaneId: string;
  pane: ProjectTabLayoutSummary["panes"][number];
}) {
  const drop = useDroppable({
    id: workspacePaneTargetDropId(pane.id),
    disabled: pane.id === activePaneId,
    data: {
      drop: {
        type: "pane-target",
        projectId: pane.projectId,
        paneId: pane.id,
      },
    } satisfies WorkspaceDndData,
  });
  return (
    <div
      ref={drop.setNodeRef}
      className={`rounded-md border px-3 py-2 text-xs shadow-sm transition-colors ${
        pane.id === activePaneId
          ? "border-muted bg-muted text-muted-foreground"
          : drop.isOver
            ? "border-primary bg-primary/10 text-foreground"
            : "bg-popover text-popover-foreground"
      }`}
      data-pane-drop-target={pane.id}
    >
      <span className="block max-w-40 truncate">{pane.title}</span>
      <span className="text-[10px] capitalize text-muted-foreground">
        {pane.region}
      </span>
    </div>
  );
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
    useSensor(WorkspacePointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const [activeDrag, setActiveDrag] = useState<WorkspaceDragItem | null>(null);
  const [decision, setDecision] = useState<WorkspaceDropDecision | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkspaceDropTarget | null>(
    null,
  );
  const clear = () => {
    setActiveDrag(null);
    setDecision(null);
    setDropTarget(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={workspaceCollisionDetection}
      onDragStart={(event) => {
        const drag = dragData(event, layout, projects);
        setActiveDrag(drag ?? null);
        setDecision(null);
        setDropTarget(null);
      }}
      onDragOver={(event) => {
        const drop = dropData(event, layout) ?? null;
        setDropTarget(drop);
        setDecision(
          decideWorkspaceDrop(
            layout,
            dragData(event, layout, projects) ?? activeDrag,
            drop,
          ),
        );
      }}
      onDragCancel={clear}
      onDragEnd={(event) => {
        const nextDecision = decideWorkspaceDrop(
          layout,
          dragData(event, layout, projects) ?? activeDrag,
          dropData(event, layout) ?? null,
        );
        clear();
        if (nextDecision.status === "valid") {
          onOperation(nextDecision.operation);
        }
      }}
    >
      <WorkspaceDndStateProvider value={{ activeDrag, decision, dropTarget }}>
        <main
          className={className}
          data-slot="app-shell"
          data-tauri-titlebar={tauriTitlebar}
        >
          {children}
        </main>
        <DragOverlay dropAnimation={null} zIndex={1000}>
          {activeDrag ? (
            <WorkspaceDragPreview drag={activeDrag} decision={decision} />
          ) : null}
        </DragOverlay>
        {activeDrag?.type === "surface" && (layout?.panes.length ?? 0) > 1 ? (
          <aside
            aria-label="Move tab to pane"
            className="fixed inset-x-0 bottom-4 z-[80] mx-auto flex w-fit max-w-[calc(100vw-2rem)] gap-2 overflow-x-auto rounded-lg border bg-background/95 p-2 shadow-xl backdrop-blur"
          >
            {layout?.panes.map((pane) => (
              <PaneDropTarget
                activePaneId={activeDrag.paneId}
                key={pane.id}
                pane={pane}
              />
            ))}
          </aside>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {decision?.status === "invalid" ? decision.reason : ""}
        </span>
      </WorkspaceDndStateProvider>
    </DndContext>
  );
}
