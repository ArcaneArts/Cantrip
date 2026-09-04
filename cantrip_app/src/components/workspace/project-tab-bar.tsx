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
import type { ExecutionTarget, ProjectPaneRegion } from "@cantrip/protocol";
import { useState, type ReactNode } from "react";

import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "./project-surface-create-menu";
import { InlineRenameLabel, SurfaceActionsMenu } from "./surface-tab-controls";
import { ProjectBuiltInSurfaceIcon } from "@/components/sidebar/project-tool-launchers";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import { nextProjectTabAfterRemoval } from "@/lib/project-pane";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "@/lib/tab-middle-click";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceSurfaceDragId,
  workspacePaneStripDropId,
} from "@/lib/workspace-dnd-model";

export interface ProjectPaneTabStripProps {
  activeTabKey: string;
  allowedCreateKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onClose(surface: ProjectSurface): void;
  onDelete(surface: ProjectSurface): void;
  onRename(surface: ProjectSurface, title: string): void;
  onMoveToRegion?(
    surface: ProjectSurface,
    region: Extract<ProjectPaneRegion, "center" | "right" | "bottom">,
  ): void;
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
  paneId?: string;
  paneRegion?: ProjectPaneRegion;
  projectId?: string;
  surfaces: readonly ProjectSurface[];
}

function surfaceCanRename(surface: ProjectSurface): boolean {
  return !(
    surface.kind === "builtin" ||
    (surface.kind === "terminal" && surface.entity.kind === "run-configuration")
  );
}

function surfaceCanDelete(surface: ProjectSurface): boolean {
  return surface.kind !== "builtin" && surface.definition.deletable;
}

function surfaceDeleteLabel(surface: ProjectSurface): string {
  return surface.kind === "chat" ? "Archive Resource" : "Delete Resource";
}

function SurfaceTabIcon({ surface }: { surface: ProjectSurface }) {
  return surface.kind === "builtin" ? (
    <ProjectBuiltInSurfaceIcon
      className="size-3.5 shrink-0"
      definitionId={surface.entity.definitionId}
    />
  ) : surface.kind === "explorer" && surface.entity.selectedPath ? (
    <FileCode2 className="size-3.5 shrink-0" />
  ) : (
    <ProjectSurfaceIcon className="size-3.5 shrink-0" kind={surface.kind} />
  );
}

export function ProjectPaneTabStrip({
  activeTabKey,
  allowedCreateKinds,
  creatingKinds,
  onCreate,
  onClose,
  onDelete,
  onRename,
  onMoveToRegion,
  onSelect,
  placement,
  previewFile,
  paneId: explicitPaneId,
  paneRegion = "center",
  projectId: explicitProjectId,
  surfaces,
}: ProjectPaneTabStripProps) {
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSurface | null>(null);
  const lastSurface = surfaces.at(-1);
  const paneId = explicitPaneId ?? lastSurface?.paneId ?? "empty";
  const projectId =
    explicitProjectId ??
    surfaces[0]?.projectId ??
    previewFile?.projectId ??
    "empty";
  const paneStripDrop = useDroppable({
    id: workspacePaneStripDropId(paneId),
    disabled: surfaces.length === 0,
    data: {
      drop: {
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
          ref={paneStripDrop.setNodeRef}
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
              const active =
                !previewFile?.active && surface.tabKey === activeTabKey;
              const editing = editingTabKey === surface.tabKey;
              const canRename = surfaceCanRename(surface);
              const canDelete = surfaceCanDelete(surface);
              return (
                <SortableProjectTabFrame
                  disabled={editing}
                  key={surface.tabKey}
                  memberPosition={memberPosition}
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
                              if (canRename) beginRename(surface);
                            }}
                          >
                            <SurfaceTabIcon surface={surface} />
                            <span className="truncate">{surface.title}</span>
                          </button>
                        )}
                        {!editing ? (
                          <SurfaceActionsMenu
                            deleteLabel={surfaceDeleteLabel(surface)}
                            title={surface.title}
                            onClose={() => closeImmediately(surface)}
                            onDelete={
                              canDelete
                                ? () => setDeleteTarget(surface)
                                : undefined
                            }
                            onRename={
                              canRename ? () => beginRename(surface) : undefined
                            }
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
                        {canRename ? (
                          <StyledContextMenuItem
                            onSelect={() => beginRename(surface)}
                          >
                            <Pencil className="size-4" /> Rename
                          </StyledContextMenuItem>
                        ) : null}
                        {canRename ? (
                          <ContextMenu.Separator className="my-1 h-px bg-border" />
                        ) : null}
                        {onMoveToRegion
                          ? (["center", "right", "bottom"] as const)
                              .filter(
                                (region) =>
                                  region !== paneRegion &&
                                  surface.definition.supportedPlacements.includes(
                                    region,
                                  ),
                              )
                              .map((region) => (
                                <StyledContextMenuItem
                                  key={region}
                                  onSelect={() =>
                                    onMoveToRegion(surface, region)
                                  }
                                >
                                  Move to{" "}
                                  {region === "center"
                                    ? "Center"
                                    : region === "right"
                                      ? "Right"
                                      : "Bottom"}
                                </StyledContextMenuItem>
                              ))
                          : null}
                        <StyledContextMenuItem
                          onSelect={() => closeImmediately(surface)}
                        >
                          <X className="size-4" /> Close View
                        </StyledContextMenuItem>
                        {canDelete ? (
                          <ContextMenu.Separator className="my-1 h-px bg-border" />
                        ) : null}
                        {canDelete ? (
                          <StyledContextMenuItem
                            className="text-destructive focus:bg-destructive/10"
                            onSelect={() => setDeleteTarget(surface)}
                          >
                            <Trash2 className="size-4" />
                            {surfaceDeleteLabel(surface)}
                          </StyledContextMenuItem>
                        ) : null}
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
            allowedKinds={allowedCreateKinds}
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
