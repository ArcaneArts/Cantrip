import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useDroppable } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CopyPlus, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProjectSurfaceIcon, surfaceKindLabel } from "./project-surface-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { nextProjectTabAfterRemoval } from "@/lib/project-tab-group";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceSurfaceDragId,
  workspaceTopBarDropId,
} from "@/lib/workspace-dnd-model";

export type ProjectSurfaceCreateKind = ProjectSurface["kind"];

const menuContentClass =
  "z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const createKinds: ProjectSurfaceCreateKind[] = [
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "history",
  "issues",
  "remote-desktop",
];

export interface ProjectTabBarProps {
  activeTabKey: string;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind): void;
  onDelete(surface: ProjectSurface): void;
  onDuplicate?(surface: ProjectSurface): void;
  onRename(surface: ProjectSurface, title: string): void;
  onSelect(tabKey: string): void;
  surfaces: readonly ProjectSurface[];
}

export function ProjectTabBar({
  activeTabKey,
  creatingKinds = new Set(),
  onCreate,
  onDelete,
  onDuplicate,
  onRename,
  onSelect,
  surfaces,
}: ProjectTabBarProps) {
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSurface | null>(null);
  const groupId = surfaces[0]?.groupId ?? "empty";
  const projectId = surfaces[0]?.projectId ?? "empty";
  const topBarDrop = useDroppable({
    id: workspaceTopBarDropId(groupId),
    disabled: surfaces.length === 0,
    data: {
      drop: {
        type: "top-bar",
        projectId,
        groupId,
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
          aria-label="Project tabs"
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
              return (
                <SortableProjectTabFrame
                  key={surface.tabKey}
                  memberPosition={memberPosition}
                  surface={surface}
                >
                  <ContextMenu.Root>
                    <ContextMenu.Trigger asChild>
                      <div
                        data-project-tab-key={surface.tabKey}
                        className={cn(
                          "group relative flex min-w-0 max-w-56 shrink-0 items-center rounded-t-md text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          active && "bg-muted text-foreground",
                        )}
                      >
                        {editing ? (
                          <input
                            autoFocus
                            aria-label={`Rename ${surface.title}`}
                            className="mx-1 h-7 w-36 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
                            value={renameValue}
                            onBlur={() => finishRename(surface)}
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") finishRename(surface);
                              if (event.key === "Escape")
                                setEditingTabKey(null);
                            }}
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
                            <ProjectSurfaceIcon
                              kind={surface.kind}
                              className="size-3.5 shrink-0"
                            />
                            <span className="truncate">{surface.title}</span>
                          </button>
                        )}
                        {!editing ? (
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                              <button
                                type="button"
                                className="mr-1 grid size-6 shrink-0 place-items-center rounded opacity-0 hover:bg-background/70 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                aria-label={`Actions for ${surface.title}`}
                              >
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenu.Trigger>
                            <SurfaceActions
                              surface={surface}
                              onDelete={() => setDeleteTarget(surface)}
                              onDuplicate={onDuplicate}
                              onRename={() => beginRename(surface)}
                            />
                          </DropdownMenu.Root>
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
                      <ContextMenu.Content className={menuContentClass}>
                        <ContextMenu.Item
                          className={menuItemClass}
                          onSelect={() => beginRename(surface)}
                        >
                          <Pencil className="size-4" /> Rename
                        </ContextMenu.Item>
                        {surface.kind === "chat" && onDuplicate ? (
                          <ContextMenu.Item
                            className={menuItemClass}
                            onSelect={() => onDuplicate(surface)}
                          >
                            <CopyPlus className="size-4" /> Duplicate
                          </ContextMenu.Item>
                        ) : null}
                        <ContextMenu.Separator className="my-1 h-px bg-border" />
                        <ContextMenu.Item
                          className={cn(
                            menuItemClass,
                            "text-destructive focus:bg-destructive/10",
                          )}
                          onSelect={() => setDeleteTarget(surface)}
                        >
                          <Trash2 className="size-4" /> Delete
                        </ContextMenu.Item>
                      </ContextMenu.Content>
                    </ContextMenu.Portal>
                  </ContextMenu.Root>
                </SortableProjectTabFrame>
              );
            })}
          </SortableContext>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="my-1 size-8 shrink-0"
                aria-label="Add tab to this group"
              >
                <Plus className="size-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={4}
                className={menuContentClass}
              >
                {createKinds.map((kind) => (
                  <DropdownMenu.Item
                    key={kind}
                    className={menuItemClass}
                    disabled={creatingKinds.has(kind)}
                    onSelect={() => onCreate(kind)}
                  >
                    <ProjectSurfaceIcon kind={kind} className="size-4" />
                    {surfaceKindLabel(kind)}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.title}?</DialogTitle>
            <DialogDescription>
              This permanently removes the {deleteTarget?.kind ?? "surface"}
              tab and its Cantrip-owned state. Project files are not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) {
                  const nextTabKey = nextProjectTabAfterRemoval(
                    surfaces,
                    deleteTarget.tabKey,
                  );
                  if (nextTabKey) onSelect(nextTabKey);
                  onDelete(deleteTarget);
                }
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SortableProjectTabFrame({
  children,
  memberPosition,
  surface,
}: {
  children: ReactNode;
  memberPosition: number;
  surface: ProjectSurface;
}) {
  const sortable = useSortable({
    id: workspaceSurfaceDragId(surface.tabKey),
    data: {
      drag: {
        type: "surface",
        projectId: surface.projectId,
        groupId: surface.groupId,
        tabKey: surface.tabKey,
        label: surface.title,
        visualKind: surface.kind,
      },
      drop: {
        type: "top-tab",
        projectId: surface.projectId,
        groupId: surface.groupId,
        tabKey: surface.tabKey,
        memberPosition,
      },
    } satisfies WorkspaceDndData,
  });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.25 : 1,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      {children}
    </div>
  );
}

function SurfaceActions({
  onDelete,
  onDuplicate,
  onRename,
  surface,
}: {
  onDelete(): void;
  onDuplicate?: (surface: ProjectSurface) => void;
  onRename(): void;
  surface: ProjectSurface;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" className={menuContentClass}>
        <DropdownMenu.Item className={menuItemClass} onSelect={onRename}>
          <Pencil className="size-4" /> Rename
        </DropdownMenu.Item>
        {surface.kind === "chat" && onDuplicate ? (
          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={() => onDuplicate(surface)}
          >
            <CopyPlus className="size-4" /> Duplicate
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Separator className="my-1 h-px bg-border" />
        <DropdownMenu.Item
          className={cn(
            menuItemClass,
            "text-destructive focus:bg-destructive/10",
          )}
          onSelect={onDelete}
        >
          <Trash2 className="size-4" /> Delete
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
