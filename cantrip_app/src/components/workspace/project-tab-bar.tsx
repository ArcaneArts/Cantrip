import * as ContextMenu from "@radix-ui/react-context-menu";
import { useDroppable } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FileCode2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ExecutionTarget } from "@cantrip/protocol";
import { useState, type ReactNode } from "react";

import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "./project-surface-create-menu";
import { InlineRenameLabel, SurfaceActionsMenu } from "./surface-tab-controls";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import { nextProjectTabAfterRemoval } from "@/lib/project-tab-group";
import type { ProjectFileSurface } from "@/lib/project-surface";
import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "@/lib/tab-middle-click";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceSurfaceDragId,
  workspaceTopBarDropId,
} from "@/lib/workspace-dnd-model";

export interface ProjectTabBarProps {
  activeTabKey: string;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onClose(surface: ProjectFileSurface): void;
  onDelete(surface: ProjectFileSurface): void;
  onRename(surface: ProjectFileSurface, title: string): void;
  onSelect(tabKey: string): void;
  placement?: ProjectSurfacePlacementContext;
  previewFile?: {
    active: boolean;
    path: string;
    projectId: string;
    title: string;
    onClose(): void;
    onPin(): void;
    onSelect(): void;
  };
  surfaces: readonly ProjectFileSurface[];
}

export function ProjectTabBar({
  activeTabKey,
  creatingKinds,
  onCreate,
  onClose,
  onDelete,
  onRename,
  onSelect,
  placement,
  previewFile,
  surfaces,
}: ProjectTabBarProps) {
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectFileSurface | null>(
    null,
  );
  const lastSurface = surfaces.at(-1);
  const groupId = lastSurface?.groupId ?? "empty";
  const projectId = surfaces[0]?.projectId ?? previewFile?.projectId ?? "empty";
  const topBarDrop = useDroppable({
    id: workspaceTopBarDropId(groupId),
    disabled: surfaces.length === 0,
    data: {
      drop: {
        type: "top-bar",
        projectId,
        groupId,
        tabKey: lastSurface?.tabKey ?? "empty",
        lanePosition: surfaces.length,
        memberPosition: (lastSurface?.member.position ?? -1) + 1,
      },
    } satisfies WorkspaceDndData,
  });

  const beginRename = (surface: ProjectFileSurface) => {
    setEditingTabKey(surface.tabKey);
    setRenameValue(surface.title);
  };
  const finishRename = (surface: ProjectFileSurface) => {
    const title = renameValue.trim();
    setEditingTabKey(null);
    if (title && title !== surface.title) onRename(surface, title);
  };
  const closeImmediately = (surface: ProjectFileSurface) => {
    if (surface.tabKey === activeTabKey) {
      const nextTabKey = nextProjectTabAfterRemoval(surfaces, surface.tabKey);
      if (nextTabKey) onSelect(nextTabKey);
    }
    onClose(surface);
  };

  return (
    <>
      <div className="relative z-20 flex h-10 shrink-0 items-stretch bg-background">
        <div
          ref={topBarDrop.setNodeRef}
          className={cn(
            "flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain px-1 transition-colors [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            topBarDrop.isOver && "bg-muted/30",
          )}
          role="tablist"
          aria-label="Project file tabs"
        >
          <SortableContext
            items={surfaces.map((surface) =>
              workspaceSurfaceDragId(surface.tabKey),
            )}
            strategy={horizontalListSortingStrategy}
          >
            {surfaces.map((surface, lanePosition) => {
              const active =
                !previewFile?.active && surface.tabKey === activeTabKey;
              const editing = editingTabKey === surface.tabKey;
              return (
                <SortableProjectTabFrame
                  disabled={editing}
                  key={surface.tabKey}
                  lanePosition={lanePosition}
                  surface={surface}
                >
                  <ContextMenu.Root>
                    <ContextMenu.Trigger asChild>
                      <div
                        data-project-tab-key={surface.tabKey}
                        onAuxClick={(event) =>
                          closeTabOnMiddleClick(event, () =>
                            closeImmediately(surface),
                          )
                        }
                        onMouseDown={preventMiddleMouseDefault}
                        className={cn(
                          "group relative flex min-w-0 max-w-56 shrink-0 items-center rounded-t-md text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          active && "bg-muted text-foreground",
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
                            aria-selected={active}
                            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                            onClick={() => onSelect(surface.tabKey)}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              beginRename(surface);
                            }}
                          >
                            <FileCode2 className="size-3.5 shrink-0" />
                            <span className="truncate">{surface.title}</span>
                          </button>
                        )}
                        {!editing ? (
                          <SurfaceActionsMenu
                            deleteLabel="Delete Resource"
                            title={surface.title}
                            onClose={() => closeImmediately(surface)}
                            onDelete={() => setDeleteTarget(surface)}
                            onRename={() => beginRename(surface)}
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
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground transition-opacity",
                            active ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </div>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <StyledContextMenuContent className="min-w-40">
                        <StyledContextMenuItem
                          onSelect={() => beginRename(surface)}
                        >
                          <Pencil className="size-4" /> Rename
                        </StyledContextMenuItem>
                        <ContextMenu.Separator className="my-1 h-px bg-border" />
                        <StyledContextMenuItem
                          onSelect={() => closeImmediately(surface)}
                        >
                          <X className="size-4" /> Close View
                        </StyledContextMenuItem>
                        <ContextMenu.Separator className="my-1 h-px bg-border" />
                        <StyledContextMenuItem
                          className="text-destructive focus:bg-destructive/10"
                          onSelect={() => setDeleteTarget(surface)}
                        >
                          <Trash2 className="size-4" /> Delete Resource
                        </StyledContextMenuItem>
                      </StyledContextMenuContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Root>
                </SortableProjectTabFrame>
              );
            })}
          </SortableContext>

          {previewFile ? (
            <div
              onAuxClick={(event) =>
                closeTabOnMiddleClick(event, previewFile.onClose)
              }
              onMouseDown={preventMiddleMouseDefault}
              className={cn(
                "group relative flex min-w-0 max-w-56 shrink-0 self-start items-center rounded-t-md text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                previewFile.active && "bg-muted text-foreground",
              )}
              data-preview-file-path={previewFile.path}
              title={`${previewFile.path}\nDouble-click to keep open`}
            >
              <button
                aria-selected={previewFile.active}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left italic"
                onClick={previewFile.onSelect}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  previewFile.onPin();
                }}
                role="tab"
                type="button"
              >
                <FileCode2 className="size-3.5 shrink-0" />
                <span className="truncate">{previewFile.title}</span>
              </button>
              <button
                aria-label={`Close preview ${previewFile.title}`}
                className="mr-1 grid size-6 shrink-0 place-items-center rounded opacity-60 hover:bg-background/70 hover:opacity-100 focus:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  previewFile.onClose();
                }}
                title="Close preview"
                type="button"
              >
                <X className="size-3.5" />
              </button>
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground transition-opacity",
                  previewFile.active ? "opacity-100" : "opacity-0",
                )}
              />
            </div>
          ) : null}

          <ProjectSurfaceCreateMenu
            creatingKinds={creatingKinds}
            onCreate={onCreate}
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
        confirmLabel="Delete Resource"
        confirmVariant="destructive"
        description="This permanently deletes Cantrip's file-view resource and its saved view state. The project file on disk is not deleted."
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.title ?? "file-view resource"}?`}
      />
    </>
  );
}

function SortableProjectTabFrame({
  children,
  disabled,
  lanePosition,
  surface,
}: {
  children: ReactNode;
  disabled: boolean;
  lanePosition: number;
  surface: ProjectFileSurface;
}) {
  const sortable = useSortable({
    disabled,
    id: workspaceSurfaceDragId(surface.tabKey),
    data: {
      drag: {
        type: "surface",
        lane: "file-tabs",
        projectId: surface.projectId,
        groupId: surface.groupId,
        tabKey: surface.tabKey,
        label: surface.title,
        lanePosition,
        visualKind: surface.kind,
      },
      drop: {
        type: "top-tab",
        projectId: surface.projectId,
        groupId: surface.groupId,
        tabKey: surface.tabKey,
        lanePosition,
        memberPosition: surface.member.position,
      },
    } satisfies WorkspaceDndData,
  });
  return (
    <div
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
