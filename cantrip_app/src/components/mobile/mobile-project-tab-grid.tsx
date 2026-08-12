import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import {
  InlineRenameLabel,
  SurfaceActionsMenu,
} from "@/components/workspace/surface-tab-controls";
import type { ProjectSurface } from "@/lib/project-surface";

function surfaceState(surface: ProjectSurface): string {
  if (surface.kind === "chat") {
    if (surface.entity.status === "waiting-for-approval") return "Approval";
    if (surface.entity.status === "running") return "Running";
    if (surface.entity.status === "failed") return "Failed";
    if (surface.entity.status === "offline") return "Offline";
  }
  if (surface.kind === "terminal") {
    if (surface.entity.status === "running") return "Running";
    if (surface.entity.status === "failed") return "Failed";
    if (surface.entity.status === "offline") return "Offline";
    if (surface.entity.status === "exited") return "Exited";
  }
  if (surface.kind === "code") {
    if (surface.entity.status === "running") return "Running";
    if (surface.entity.status === "starting") return "Starting";
    if (surface.entity.status === "failed") return "Failed";
    if (surface.entity.status === "offline") return "Offline";
    if (surface.entity.status === "stopped") return "Stopped";
  }
  return "Open";
}

function surfaceKindLabel(surface: ProjectSurface): string {
  if (surface.kind === "remote-desktop") return "Remote desktop";
  return `${surface.kind.slice(0, 1).toUpperCase()}${surface.kind.slice(1)}`;
}

export function MobileProjectTabGrid({
  creatingKinds,
  layout,
  onCreate,
  onDelete,
  onDuplicate,
  onRename,
  onSelect,
  surfaces,
}: {
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  layout: ProjectTabLayoutSummary | null | undefined;
  onCreate(kind: ProjectSurfaceCreateKind): void;
  onDelete(surface: ProjectSurface): void;
  onDuplicate?(surface: ProjectSurface): void;
  onRename(surface: ProjectSurface, title: string): void;
  onSelect(tabKey: string): void;
  surfaces: readonly ProjectSurface[];
}) {
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSurface | null>(null);
  const surfacesByTabKey = useMemo(
    () => new Map(surfaces.map((surface) => [surface.tabKey, surface])),
    [surfaces],
  );
  const groups = useMemo(
    () =>
      (layout?.groups ?? []).map((group) => ({
        ...group,
        surfaces: group.members
          .map(({ tabKey }) => surfacesByTabKey.get(tabKey))
          .filter((surface): surface is ProjectSurface => Boolean(surface)),
      })),
    [layout?.groups, surfacesByTabKey],
  );
  const unresolvedCount =
    (layout?.groups.reduce((count, group) => count + group.members.length, 0) ??
      0) - surfaces.length;

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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-3xl space-y-5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Project tabs</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Open a surface or create another one.
              </p>
            </div>
            <ProjectSurfaceCreateMenu
              align="end"
              creatingKinds={creatingKinds}
              onCreate={onCreate}
              trigger={
                <Button aria-label="Create project tab" size="sm">
                  <Plus className="size-4" />
                  New
                </Button>
              }
            />
          </div>

          {groups.some(
            ({ surfaces: groupSurfaces }) => groupSurfaces.length,
          ) ? (
            groups.map((group, groupIndex) =>
              group.surfaces.length > 0 ? (
                <section
                  key={group.id}
                  aria-labelledby={`mobile-group-${group.id}`}
                >
                  <div className="mb-2 flex items-center justify-between px-1">
                    <h3
                      className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                      id={`mobile-group-${group.id}`}
                    >
                      Group {groupIndex + 1}
                    </h3>
                    <Badge
                      className="h-5 px-1.5 text-[9px]"
                      variant="secondary"
                    >
                      {group.surfaces.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.surfaces.map((surface) => {
                      const editing = editingTabKey === surface.tabKey;
                      return (
                        <div
                          className="group relative min-w-0 rounded-xl border bg-card p-3 shadow-sm"
                          key={surface.tabKey}
                        >
                          <div className="flex items-start gap-2">
                            <button
                              aria-label={`Open ${surface.title}`}
                              className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
                              onClick={() => onSelect(surface.tabKey)}
                              type="button"
                            >
                              <span className="grid size-8 place-items-center rounded-lg bg-muted">
                                <ProjectSurfaceIcon
                                  className="size-4"
                                  kind={surface.kind}
                                />
                              </span>
                            </button>
                            <SurfaceActionsMenu
                              onDelete={() => setDeleteTarget(surface)}
                              onDuplicate={
                                surface.kind === "chat" && onDuplicate
                                  ? () => onDuplicate(surface)
                                  : undefined
                              }
                              onRename={() => beginRename(surface)}
                              title={surface.title}
                              trigger={
                                <button
                                  aria-label={`Actions for ${surface.title}`}
                                  className="relative z-10 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  type="button"
                                >
                                  <MoreHorizontal className="size-4" />
                                </button>
                              }
                            />
                          </div>
                          {editing ? (
                            <InlineRenameLabel
                              ariaLabel={`Rename ${surface.title}`}
                              className="relative z-10 mt-3 w-full"
                              onCancel={() => setEditingTabKey(null)}
                              onChange={setRenameValue}
                              onSubmit={() => finishRename(surface)}
                              value={renameValue}
                            />
                          ) : (
                            <button
                              className="mt-3 block w-full min-w-0 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
                              onClick={() => onSelect(surface.tabKey)}
                              type="button"
                            >
                              <span className="block truncate text-sm font-medium">
                                {surface.title}
                              </span>
                              <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                <span className="truncate">
                                  {surfaceKindLabel(surface)}
                                </span>
                                <span className="shrink-0">
                                  {surfaceState(surface)}
                                </span>
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null,
            )
          ) : unresolvedCount > 0 ? (
            <div className="grid min-h-48 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed px-6 text-center">
              <div>
                <p className="text-sm font-medium">No project tabs yet</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Use New to start a chat, terminal, explorer, Code workspace,
                  or browser.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      <Dialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={Boolean(deleteTarget)}
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
                if (deleteTarget) onDelete(deleteTarget);
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
