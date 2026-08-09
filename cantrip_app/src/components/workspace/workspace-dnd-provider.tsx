import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type Collision,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { Ban, FolderGit2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { ProjectSurfaceIcon } from "./project-surface-icon";
import {
  decideWorkspaceDrop,
  type WorkspaceDndData,
  type WorkspaceDragItem,
  type WorkspaceDropDecision,
  type WorkspaceDropOperation,
  type WorkspaceDropTarget,
} from "@/lib/workspace-dnd-model";
import { cn } from "@/lib/utils";
import {
  beginDesktopNativeTabDrag,
  cancelDesktopNativeTabDrag,
  finishDesktopNativeTabDrag,
  moveDesktopNativeTabDragPreview,
  startDesktopNativeWindowDrag,
  type DesktopNativeDragStart,
  type DesktopNativeDropResolution,
  type DesktopNativeTabDrag,
} from "@/lib/desktop-window-coordinator";

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
    label:
      group.members.find(({ tabKey }) => tabKey === group.anchorTabKey)
        ?.title ??
      group.members[0]?.title ??
      "Tab group",
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
  desktopRuntime = false,
  isPopout = false,
  onDesktopTabDrop,
  onOperation,
  projects,
  tauriTitlebar,
}: {
  children: ReactNode;
  className?: string;
  desktopRuntime?: boolean;
  isPopout?: boolean;
  layout: ProjectTabLayoutSummary | null | undefined;
  onDesktopTabDrop?(
    drag: DesktopNativeTabDrag,
    resolution: DesktopNativeDropResolution,
  ): Promise<void>;
  onOperation(operation: WorkspaceDropOperation): void;
  projects: readonly ProjectSummary[];
  tauriTitlebar?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [activeDrag, setActiveDrag] = useState<WorkspaceDragItem | null>(null);
  const [decision, setDecision] = useState<WorkspaceDropDecision | null>(null);
  const nativeDragRef = useRef<DesktopNativeTabDrag | null>(null);
  const nativeStartRef = useRef<Promise<DesktopNativeDragStart> | null>(null);
  const nativeFinishingRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);

  const finishNativeDrag = async () => {
    if (nativeFinishingRef.current) return;
    const drag = nativeDragRef.current;
    const started = nativeStartRef.current;
    if (!drag || !started || !onDesktopTabDrop) return;
    nativeFinishingRef.current = true;
    try {
      await started;
      const resolution = await finishDesktopNativeTabDrag();
      await onDesktopTabDrop(drag, resolution);
    } finally {
      nativeDragRef.current = null;
      nativeStartRef.current = null;
      nativeFinishingRef.current = false;
    }
  };

  const beginNativeDrag = (drag: WorkspaceDragItem | undefined) => {
    if (
      !desktopRuntime ||
      !onDesktopTabDrop ||
      drag?.type !== "surface" ||
      !layout
    ) {
      return;
    }
    const sourceGroup = layout.groups.find(({ id }) => id === drag.groupId);
    if (!sourceGroup) return;
    const nativeDrag: DesktopNativeTabDrag = {
      groupId: drag.groupId,
      projectId: drag.projectId,
      sourceGroupSize: sourceGroup.members.length,
      sourceIsPopout: isPopout,
      surface: {
        kind: drag.visualKind,
        tabKey: drag.tabKey,
        title: drag.label,
      },
    };
    nativeDragRef.current = nativeDrag;
    nativeFinishingRef.current = false;
    const started = beginDesktopNativeTabDrag(nativeDrag);
    nativeStartRef.current = started;
    void started
      .then((result) =>
        result.mode === "move-window"
          ? startDesktopNativeWindowDrag().then(finishNativeDrag)
          : undefined,
      )
      .catch((error) => {
        console.error("Could not begin native tab dragging", error);
        nativeDragRef.current = null;
        nativeStartRef.current = null;
        void cancelDesktopNativeTabDrag();
      });
  };

  const cancelNativeDrag = () => {
    const started = nativeStartRef.current;
    nativeDragRef.current = null;
    nativeStartRef.current = null;
    nativeFinishingRef.current = false;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    void (started
      ? started.catch(() => undefined).then(cancelDesktopNativeTabDrag)
      : cancelDesktopNativeTabDrag());
  };

  const clear = (_event?: DragCancelEvent) => {
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
        beginNativeDrag(drag);
      }}
      onDragMove={(_event: DragMoveEvent) => {
        if (!nativeStartRef.current || previewFrameRef.current !== null) return;
        previewFrameRef.current = window.requestAnimationFrame(() => {
          previewFrameRef.current = null;
          void nativeStartRef.current
            ?.then((started) =>
              started.mode === "preview"
                ? moveDesktopNativeTabDragPreview()
                : undefined,
            )
            .catch(() => undefined);
        });
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
      onDragCancel={(event) => {
        cancelNativeDrag();
        clear(event);
      }}
      onDragEnd={(event) => {
        const nextDecision = decideWorkspaceDrop(
          layout,
          dragData(event, layout, projects) ?? activeDrag,
          dropData(event, layout) ?? null,
        );
        const nativeStarted = nativeStartRef.current;
        if (nativeStarted) {
          void nativeStarted
            .then((started) => {
              if (started.mode === "move-window") {
                void finishNativeDrag();
                return;
              }
              if (nextDecision.status === "valid") {
                cancelNativeDrag();
                onOperation(nextDecision.operation);
              } else if (nextDecision.status === "noop" && event.over) {
                cancelNativeDrag();
              } else {
                void finishNativeDrag();
              }
            })
            .catch(() => undefined);
        } else if (nextDecision.status === "valid") {
          onOperation(nextDecision.operation);
        }
        clear();
      }}
    >
      <main className={className} data-tauri-titlebar={tauriTitlebar}>
        {children}
      </main>
      <DragOverlay>
        {activeDrag ? (
          <div
            className={cn(
              "flex w-56 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl",
              decision?.status === "invalid" &&
                "border-destructive text-destructive ring-1 ring-destructive/40",
            )}
          >
            {activeDrag.type === "project" ? (
              <FolderGit2 className="size-4 shrink-0" />
            ) : (
              <ProjectSurfaceIcon
                kind={activeDrag.visualKind}
                className="size-4 shrink-0"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{activeDrag.label}</span>
            {decision?.status === "invalid" ? (
              <Ban className="size-4 shrink-0" aria-label={decision.reason} />
            ) : null}
          </div>
        ) : null}
      </DragOverlay>
      <span className="sr-only" aria-live="polite">
        {decision?.status === "invalid" ? decision.reason : ""}
      </span>
    </DndContext>
  );
}
