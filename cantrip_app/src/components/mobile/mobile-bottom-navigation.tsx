import * as ContextMenu from "@radix-ui/react-context-menu";
import { LayoutDashboard, Plus, X } from "lucide-react";

import { performMobileNavigationHaptic } from "@/components/mobile/mobile-navigation-haptics";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export function MobileBottomNavigation({
  activeTabKey,
  onClose,
  onOpenPicker,
  onOverview,
  onSelect,
  overviewSelected,
  surfaces,
}: {
  activeTabKey: string | null;
  onClose(surface: ProjectSurface): void;
  onOpenPicker(): void;
  onOverview(): void;
  onSelect(tabKey: string): void;
  overviewSelected: boolean;
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
              <ContextMenu.Root key={surface.tabKey}>
                <ContextMenu.Trigger asChild>
                  <div
                    className={cn(
                      "relative flex items-stretch",
                      evenlyDivided
                        ? "min-w-0 flex-1"
                        : "min-w-[4.5rem] max-w-28 shrink-0",
                    )}
                    data-mobile-surface-tab={surface.tabKey}
                  >
                    <button
                      aria-current={active ? "page" : undefined}
                      aria-label={`Open ${label}`}
                      className={cn(
                        "flex w-full min-w-0 touch-manipulation flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                        !evenlyDivided && "px-2",
                        active && "text-foreground",
                      )}
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
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <StyledContextMenuContent className="min-w-40">
                    <StyledContextMenuItem onSelect={() => onClose(surface)}>
                      <X className="size-4" /> Close View
                    </StyledContextMenuItem>
                  </StyledContextMenuContent>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
          <button
            aria-label="Choose project tab"
            className={cn(
              "grid place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              evenlyDivided ? "min-w-0 flex-1" : "min-w-[4.5rem] shrink-0",
            )}
            onClick={onOpenPicker}
            onPointerDown={() => void performMobileNavigationHaptic("press")}
            type="button"
          >
            <Plus className="size-5" />
            <span className="sr-only">Choose project tab</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
