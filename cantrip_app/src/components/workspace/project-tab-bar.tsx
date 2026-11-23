import { sidebarFileRevealAction } from "@/lib/sidebar-file-reveal";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { TabColor, TabIndicator } from "./tab-color";
import { surfaceColorKey } from "@/lib/tab-colors";
import { useDroppable } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Info, MoreHorizontal, Plus } from "lucide-react";
import { FileTypeIcon } from "@/components/files/file-type-icon";
import type { ExecutionTarget, ProjectPaneRegion } from "@cantrip/protocol";
import { Fragment, useCallback, useState, type ReactNode } from "react";
import {
  expandedTabCount,
  useTabBarWidth,
  useTabDisplay,
} from "@/lib/tab-display";
import "./tab-display.css";

import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "./project-surface-create-menu";
import {
  InlineRenameLabel,
  SurfaceActionsMenu,
  SurfaceMenuItems,
  surfaceMoveTargets,
  type SurfaceMenuActions,
} from "./surface-tab-controls";
import { ProjectBuiltInSurfaceIcon } from "@/components/sidebar/project-tool-launchers";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import {
  useWorkspaceDndState,
  WorkspaceDropPlaceholder,
} from "@/components/workspace/workspace-dnd-state";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StyledContextMenuContent } from "@/components/ui/styled-menu";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "@/lib/tab-middle-click";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceSurfaceDropPreview,
  workspaceSurfaceDragId,
  workspacePaneStripDropId,
  workspaceRegionDropId,
} from "@/lib/workspace-dnd-model";

export interface ProjectPaneTabStripProps {
  titlebar?: boolean;
  revealInFiles?: boolean;
  activeTabKey: string;
  allowedCreateKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onOpenRunning?(terminalId: string): void;
  onClose(surface: ProjectSurface): void;
  onKeepOpen?(surface: ProjectSurface): void;
  onPopOut?(surface: ProjectSurface): void;
  onPopOutPane?(surface: ProjectSurface): void;
  onDelete(surface: ProjectSurface, stopRunning?: true): void;
  onRename(surface: ProjectSurface, title: string): void;
  onMoveToRegion?(
    surface: ProjectSurface,
    region: Extract<ProjectPaneRegion, "center" | "right" | "bottom">,
  ): void;
  onSelect(tabKey: string): void;
  placement?: ProjectSurfacePlacementContext;
  paneId?: string;
  paneRegion?: ProjectPaneRegion;
  projectId?: string;
  surfaces: readonly ProjectSurface[];
}

export function surfaceCanRename(surface: ProjectSurface): boolean {
  return !(
    surface.kind === "builtin" ||
    surface.kind === "unresolved" ||
    surface.kind === "file" ||
    (surface.kind === "terminal" && surface.entity.kind === "run-configuration")
  );
}

export function surfaceCanDelete(surface: ProjectSurface): boolean {
  return (
    surface.kind !== "builtin" &&
    surface.kind !== "unresolved" &&
    surface.kind !== "file" &&
    surface.definition.deletable
  );
}

export function surfaceDeleteLabel(surface: ProjectSurface): string {
  return surface.kind === "chat" ? "Archive Resource" : "Delete Resource";
}

export function surfaceNeedsApproval(surface: ProjectSurface): boolean {
  return (
    surface.kind === "chat" && surface.entity.status === "waiting-for-approval"
  );
}

export function surfaceIsRunning(surface: ProjectSurface): boolean {
  return surface.kind === "chat" && surface.entity.status === "running";
}

function SurfaceTabIcon({ surface }: { surface: ProjectSurface }) {
  return surfaceNeedsApproval(surface) ? (
    <Info aria-hidden="true" className="size-3.5 shrink-0 text-amber-500" />
  ) : surface.kind === "builtin" ? (
    <ProjectBuiltInSurfaceIcon
      className="size-3.5 shrink-0"
      definitionId={surface.entity.definitionId}
    />
  ) : surface.kind === "file" ? (
    <FileTypeIcon path={surface.entity.path} className="size-3.5" />
  ) : surface.kind === "explorer" && surface.entity.selectedPath ? (
    <FileTypeIcon path={surface.entity.selectedPath} className="size-3.5" />
  ) : (
    <ProjectSurfaceIcon
      className="size-3.5 shrink-0"
      kind={
        surface.kind === "unresolved" ? surface.member.tabKind : surface.kind
      }
    />
  );
}

export function ProjectPaneTabStrip({
  titlebar = false,
  revealInFiles = true,
  activeTabKey,
  allowedCreateKinds,
  creatingKinds,
  onCreate,
  onOpenRunning,
  onClose,
  onKeepOpen,
  onPopOut,
  onPopOutPane,
  onDelete,
  onRename,
  onMoveToRegion,
  onSelect,
  placement,
  paneId: explicitPaneId,
  paneRegion = "center",
  projectId: explicitProjectId,
  surfaces,
}: ProjectPaneTabStripProps) {
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const displayMode = useTabDisplay("top");
  const { setElement, width } = useTabBarWidth();
  const expanded = expandedTabCount(displayMode, surfaces.length, width);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSurface | null>(null);
  const lastSurface = surfaces.at(-1);
  const paneId = explicitPaneId ?? lastSurface?.paneId ?? "empty";
  const projectId = explicitProjectId ?? surfaces[0]?.projectId ?? "empty";
  const workspaceDnd = useWorkspaceDndState();
  const crossPaneDrag =
    (workspaceDnd.activeDrag?.type === "conversation" ||
      workspaceDnd.activeDrag?.type === "surface") &&
    (workspaceDnd.activeDrag.type === "conversation" ||
      workspaceDnd.activeDrag.paneId !== paneId)
      ? workspaceDnd.activeDrag
      : null;
  const dropPreview = workspaceSurfaceDropPreview({
    decision: workspaceDnd.decision,
    drag: workspaceDnd.activeDrag,
    drop: workspaceDnd.dropTarget,
    memberCount: surfaces.length,
    paneId: paneId === "empty" ? null : paneId,
    region: paneRegion,
  });
  const paneStripDrop = useDroppable({
    id:
      paneId === "empty"
        ? workspaceRegionDropId("center")
        : workspacePaneStripDropId(paneId),
    disabled: projectId === "empty",
    data: {
      drop:
        paneId === "empty"
          ? { type: "region", projectId, paneId: null, region: "center" }
          : {
              type: "pane-strip",
              projectId,
              paneId,
              memberPosition: surfaces.length,
            },
    } satisfies WorkspaceDndData,
  });

  const beginRename = (surface: ProjectSurface) => {
    setEditingTabKey(surface.tabKey);
    setRenameValue(surface.title);
  };
  const finishRename = (surface: ProjectSurface) => {
    const title = renameValue.trim();
    setEditingTabKey(null);
    if (title && title !== surface.title) onRename(surface, title);
  };
  const closeImmediately = (surface: ProjectSurface) => {
    onClose(surface);
  };

  const stripRef = useCallback(
    (node: HTMLDivElement | null) => {
      paneStripDrop.setNodeRef(node);
      setElement(node);
    },
    [paneStripDrop.setNodeRef, setElement],
  );
  return (
    <>
      <div
        className={cn(
          "relative z-20 flex h-10 shrink-0 items-stretch",
          titlebar && "min-w-0 flex-1",
        )}
        data-tauri-drag-region={titlebar ? "" : undefined}
      >
        <div
          ref={stripRef}
          data-tab-display={displayMode}
          data-tauri-drag-region={titlebar ? "" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain px-1 transition-colors [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            paneStripDrop.isOver && "bg-muted/30",
          )}
          role="tablist"
          aria-label="Project pane tabs"
        >
          <SortableContext
            items={surfaces.map((surface) =>
              workspaceSurfaceDragId(surface.tabKey),
            )}
            strategy={horizontalListSortingStrategy}
          >
            {surfaces.map((surface, memberPosition) => {
              const active = surface.tabKey === activeTabKey;
              const editing = editingTabKey === surface.tabKey;
              const tabLabel = surfaceNeedsApproval(surface)
                ? `${surface.title} (Approval required)`
                : surfaceIsRunning(surface)
                  ? `${surface.title} (Running)`
                  : surface.title;
              const canRename = surfaceCanRename(surface);
              const canDelete = surfaceCanDelete(surface);
              const menuActions: SurfaceMenuActions = {
                colorKey: surfaceColorKey(surface),
                onRevealInFiles: revealInFiles
                  ? sidebarFileRevealAction(surface)
                  : undefined,
                deleteLabel: surfaceDeleteLabel(surface),
                moveTargets: surfaceMoveTargets(
                  surface,
                  paneRegion,
                  onMoveToRegion
                    ? (region) => onMoveToRegion(surface, region)
                    : undefined,
                ),
                onClose: () => closeImmediately(surface),
                onKeepOpen:
                  surface.kind === "file" && surface.preview && onKeepOpen
                    ? () => onKeepOpen(surface)
                    : undefined,
                onPopOut: onPopOut ? () => onPopOut(surface) : undefined,
                onPopOutPane: onPopOutPane
                  ? () => onPopOutPane(surface)
                  : undefined,
                onDelete: canDelete
                  ? () => setDeleteTarget(surface)
                  : undefined,
                onRename: canRename ? () => beginRename(surface) : undefined,
                title: surface.title,
              };
              return (
                <Fragment key={surface.tabKey}>
                  {crossPaneDrag ? (
                    <WorkspaceDropPlaceholder
                      active={dropPreview?.memberPosition === memberPosition}
                      label={crossPaneDrag.label}
                      orientation="horizontal"
                      paneId={paneId}
                      tabKey={
                        crossPaneDrag.type === "conversation"
                          ? `conversation:${crossPaneDrag.chatId}`
                          : crossPaneDrag.tabKey
                      }
                      visualKind={crossPaneDrag.visualKind}
                    />
                  ) : null}
                  <SortableProjectTabFrame
                    disabled={editing}
                    memberPosition={memberPosition}
                    surface={surface}
                  >
                    <TabColor
                      colorKey={surfaceColorKey(surface)}
                      active={active}
                    >
                      <ContextMenu.Root>
                        <ContextMenu.Trigger asChild>
                          <div
                            data-project-tab-key={surface.tabKey}
                            data-preview={surface.preview || undefined}
                            data-condensed={
                              !editing && memberPosition >= expanded
                            }
                            title={tabLabel}
                            style={{
                              width:
                                !editing && memberPosition >= expanded
                                  ? 40
                                  : displayMode === "hybrid"
                                    ? 160
                                    : undefined,
                            }}
                            onAuxClick={(event) =>
                              closeTabOnMiddleClick(event, () =>
                                closeImmediately(surface),
                              )
                            }
                            onMouseDown={preventMiddleMouseDefault}
                            className={cn(
                              "group relative flex min-w-0 max-w-56 shrink-0 items-center text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                              active && "text-foreground",
                            )}
                          >
                            {editing ? (
                              <InlineRenameLabel
                                ariaLabel={`Rename ${surface.title}`}
                                className="mx-1 h-7 w-36 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
                                value={renameValue}
                                onCancel={() => setEditingTabKey(null)}
                                onChange={setRenameValue}
                                onSubmit={() => finishRename(surface)}
                              />
                            ) : (
                              <button
                                type="button"
                                role="tab"
                                aria-label={tabLabel}
                                aria-selected={active}
                                data-agent-running={surfaceIsRunning(surface)}
                                className="tab-color-content flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                                onClick={() => onSelect(surface.tabKey)}
                                onDoubleClick={(event) => {
                                  event.preventDefault();
                                  if (menuActions.onKeepOpen)
                                    menuActions.onKeepOpen();
                                  else if (canRename) beginRename(surface);
                                }}
                              >
                                <SurfaceTabIcon surface={surface} />
                                <span
                                  className={cn(
                                    "truncate",
                                    surface.preview && "italic",
                                  )}
                                >
                                  {surface.title}
                                </span>
                              </button>
                            )}
                            {!editing ? (
                              <SurfaceActionsMenu
                                {...menuActions}
                                trigger={
                                  <button
                                    type="button"
                                    className="mr-1 grid size-6 shrink-0 place-items-center rounded opacity-0 hover:bg-background/70 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                    aria-label={`Actions for ${surface.title}`}
                                  >
                                    <MoreHorizontal className="size-3.5" />
                                  </button>
                                }
                              />
                            ) : null}
                            <TabIndicator active={active} />
                          </div>
                        </ContextMenu.Trigger>
                        <ContextMenu.Portal>
                          <StyledContextMenuContent className="min-w-40">
                            <SurfaceMenuItems {...menuActions} kind="context" />
                          </StyledContextMenuContent>
                        </ContextMenu.Portal>
                      </ContextMenu.Root>
                    </TabColor>
                  </SortableProjectTabFrame>
                </Fragment>
              );
            })}
            {crossPaneDrag ? (
              <WorkspaceDropPlaceholder
                active={dropPreview?.memberPosition === surfaces.length}
                label={crossPaneDrag.label}
                orientation="horizontal"
                paneId={paneId}
                tabKey={
                  crossPaneDrag.type === "conversation"
                    ? `conversation:${crossPaneDrag.chatId}`
                    : crossPaneDrag.tabKey
                }
                visualKind={crossPaneDrag.visualKind}
              />
            ) : null}
          </SortableContext>

          <ProjectSurfaceCreateMenu
            allowedKinds={allowedCreateKinds}
            creatingKinds={creatingKinds}
            onCreate={onCreate}
            onOpenRunning={onOpenRunning}
            placement={placement}
            trigger={
              <Button
                size="icon"
                variant="ghost"
                className="my-1 size-8 shrink-0"
                aria-label="Add project surface"
              >
                <Plus className="size-4" />
              </Button>
            }
          />
        </div>
      </div>
      <ConfirmDialog
        confirmLabel={
          deleteTarget ? surfaceDeleteLabel(deleteTarget) : "Delete Resource"
        }
        confirmVariant="destructive"
        description={
          deleteTarget?.kind === "chat"
            ? "This closes the tab and archives the Agent resource."
            : "This permanently deletes the resource and its saved view state."
        }
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`${deleteTarget?.kind === "chat" ? "Archive" : "Delete"} ${deleteTarget?.title ?? "resource"}?`}
      />
    </>
  );
}

function SortableProjectTabFrame({
  children,
  disabled,
  memberPosition,
  surface,
}: {
  children: ReactNode;
  disabled: boolean;
  memberPosition: number;
  surface: ProjectSurface;
}) {
  const sortable = useSortable({
    disabled,
    id: workspaceSurfaceDragId(surface.tabKey),
    data: {
      drag: {
        type: "surface",
        projectId: surface.projectId,
        paneId: surface.paneId,
        tabKey: surface.tabKey,
        label: surface.title,
        position: memberPosition,
        supportedRegions: surface.definition.supportedPlacements,
        visualKind: surface.kind,
      },
      drop: {
        type: "pane-tab",
        projectId: surface.projectId,
        paneId: surface.paneId,
        tabKey: surface.tabKey,
        memberPosition,
      },
    } satisfies WorkspaceDndData,
  });
  return (
    <div
      data-project-tab-position={memberPosition}
      data-project-tab-frame={surface.tabKey}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.25 : 1,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      {...(disabled ? {} : sortable.attributes)}
      {...(disabled ? {} : sortable.listeners)}
    >
      {children}
    </div>
  );
}

/** @deprecated Use ProjectPaneTabStrip. */
export const ProjectTabBar = ProjectPaneTabStrip;
