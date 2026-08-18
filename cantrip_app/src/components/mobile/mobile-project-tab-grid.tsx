import type {
  ExecutionTarget,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export function MobileProjectTabGrid({
  activeGroupId,
  activeTabByGroup,
  creatingKinds,
  layout,
  onCreate,
  onRemoveBottomTab,
  onSelectGroup,
  placement,
  surfaces,
}: {
  activeGroupId?: string | null;
  activeTabByGroup: Readonly<Record<string, string>>;
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  layout: ProjectTabLayoutSummary | null | undefined;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onRemoveBottomTab?: () => void;
  onSelectGroup(groupId: string): void;
  placement?: ProjectSurfacePlacementContext;
  surfaces: readonly ProjectSurface[];
}) {
  const surfacesByTabKey = useMemo(
    () => new Map(surfaces.map((surface) => [surface.tabKey, surface])),
    [surfaces],
  );
  const groups = useMemo(
    () =>
      (layout?.groups ?? []).map((group) => {
        const activeTabKey = group.members.some(
          ({ tabKey }) => tabKey === activeTabByGroup[group.id],
        )
          ? activeTabByGroup[group.id]!
          : group.anchorTabKey;
        return {
          ...group,
          representative: surfacesByTabKey.get(activeTabKey),
          representativeMember: group.members.find(
            ({ tabKey }) => tabKey === activeTabKey,
          ),
        };
      }),
    [activeTabByGroup, layout?.groups, surfacesByTabKey],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl p-4">
        <div>
          <h2 className="font-semibold">Project tabs</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose a tab group or create another surface.
          </p>
          <div className="mt-3 flex items-center justify-between gap-2">
            {onRemoveBottomTab ? (
              <Button
                className="text-destructive hover:text-destructive"
                onClick={onRemoveBottomTab}
                size="sm"
                variant="ghost"
              >
                <Trash2 className="size-4" />
                Remove bottom tab
              </Button>
            ) : (
              <span />
            )}
            <ProjectSurfaceCreateMenu
              align="end"
              creatingKinds={creatingKinds}
              onCreate={onCreate}
              placement={placement}
              trigger={
                <Button aria-label="Create project tab" size="sm">
                  <Plus className="size-4" />
                  New
                </Button>
              }
            />
          </div>
        </div>

        {groups.some(({ members }) => members.length > 0) ? (
          <nav aria-label="Project tab groups" className="mt-5 space-y-1">
            {groups.map((group, groupIndex) => {
              const representativeMember =
                group.representativeMember ?? group.members[0];
              if (!representativeMember) return null;
              const active = activeGroupId === group.id;
              return (
                <button
                  aria-current={active ? "page" : undefined}
                  aria-label={`Open Group ${groupIndex + 1}: ${group.title}`}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-muted",
                  )}
                  key={group.id}
                  onClick={() => onSelectGroup(group.id)}
                  type="button"
                >
                  <span className="grid size-9 shrink-0 place-items-center text-muted-foreground">
                    {group.representative ? (
                      <ProjectSurfaceIcon
                        className="size-4"
                        kind={
                          group.representative.kind === "chat" &&
                          group.representative.entity.experience === "task"
                            ? "task"
                            : group.representative.kind
                        }
                      />
                    ) : (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {group.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Group {groupIndex + 1} · {group.members.length}{" "}
                      {group.members.length === 1 ? "tab" : "tabs"}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="grid min-h-48 place-items-center px-6 text-center">
            <div>
              <p className="text-sm font-medium">No project tabs yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Use New to start an agent, terminal, explorer, Code workspace,
                or browser.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
