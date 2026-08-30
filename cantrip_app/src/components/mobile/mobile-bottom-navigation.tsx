import type { ExecutionTarget } from "@cantrip/protocol";
import { LayoutDashboard, Plus } from "lucide-react";

import { performMobileNavigationHaptic } from "@/components/mobile/mobile-navigation-haptics";
import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export function MobileBottomNavigation({
  activeTabKey,
  creatingKinds,
  onCreate,
  onOverview,
  onSelect,
  overviewSelected,
  placement,
  surfaces,
}: {
  activeTabKey: string | null;
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onOverview(): void;
  onSelect(tabKey: string): void;
  overviewSelected: boolean;
  placement?: ProjectSurfacePlacementContext;
  surfaces: readonly ProjectSurface[];
}) {
  const evenlyDivided = surfaces.length + 2 <= 5;

  return (
    <nav
      aria-label="Project navigation"
      className="mobile-safe-bottom relative z-30 shrink-0 border-t bg-background/95 pt-1.5 backdrop-blur-xl"
      data-layout={evenlyDivided ? "equal" : "scroll"}
    >
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          className={cn(
            "flex min-w-full items-stretch px-2",
            !evenlyDivided && "w-max",
          )}
        >
          <button
            aria-current={overviewSelected ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              evenlyDivided ? "min-w-0 flex-1" : "min-w-[4.5rem] shrink-0 px-2",
              overviewSelected && "text-foreground",
            )}
            onClick={onOverview}
            onPointerDown={() => void performMobileNavigationHaptic("press")}
            type="button"
          >
            <LayoutDashboard
              className="size-4"
              fill={overviewSelected ? "currentColor" : "none"}
            />
            <span>Overview</span>
          </button>
          {surfaces.map((surface) => {
            const active = !overviewSelected && surface.tabKey === activeTabKey;
            const label =
              surface.kind === "explorer" ? "Explorer" : surface.title;
            return (
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Open ${label}`}
                className={cn(
                  "flex touch-manipulation flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  evenlyDivided
                    ? "min-w-0 flex-1"
                    : "min-w-[4.5rem] max-w-28 shrink-0 px-2",
                  active && "text-foreground",
                )}
                key={surface.tabKey}
                onClick={() => onSelect(surface.tabKey)}
                onPointerDown={() =>
                  void performMobileNavigationHaptic("press")
                }
                type="button"
              >
                <ProjectSurfaceIcon
                  className="size-4"
                  filled={active}
                  kind={
                    surface.kind === "chat" &&
                    surface.entity.experience === "task"
                      ? "task"
                      : surface.kind
                  }
                />
                <span className="max-w-full truncate">{label}</span>
              </button>
            );
          })}
          <ProjectSurfaceCreateMenu
            align="end"
            creatingKinds={creatingKinds}
            onCreate={onCreate}
            placement={placement}
            trigger={
              <button
                aria-label="Create project surface"
                className={cn(
                  "grid place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  evenlyDivided ? "min-w-0 flex-1" : "min-w-[4.5rem] shrink-0",
                )}
                onPointerDown={() =>
                  void performMobileNavigationHaptic("press")
                }
                type="button"
              >
                <Plus className="size-5" />
                <span className="sr-only">New project surface</span>
              </button>
            }
          />
        </div>
      </div>
    </nav>
  );
}
