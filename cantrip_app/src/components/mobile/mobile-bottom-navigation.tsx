import { LayoutDashboard, LayoutGrid, Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { performMobileNavigationHaptic } from "@/components/mobile/mobile-navigation-haptics";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export const MOBILE_BOTTOM_TAB_LONG_PRESS_MS = 500;

export interface MobileBottomNavigationItem {
  id: string;
  label?: string;
  surface?: ProjectSurface;
}

export function MobileBottomNavigation({
  activeItemId,
  gridOpen,
  items,
  onAdd,
  onOverview,
  onReset,
  onSelect,
  overviewSelected,
}: {
  activeItemId: string;
  gridOpen: boolean;
  items: readonly MobileBottomNavigationItem[];
  onAdd(): void;
  onOverview(): void;
  onReset(itemId: string): void;
  onSelect(itemId: string): void;
  overviewSelected: boolean;
}) {
  const evenlyDivided = items.length + 2 <= 5;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const resetBottomTab = (itemId: string) => {
    cancelLongPress();
    if (longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = true;
    void performMobileNavigationHaptic("reset");
    onReset(itemId);
  };
  const beginLongPress = (itemId: string) => {
    cancelLongPress();
    longPressTriggeredRef.current = false;
    void performMobileNavigationHaptic("press");
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      resetBottomTab(itemId);
    }, MOBILE_BOTTOM_TAB_LONG_PRESS_MS);
  };
  useEffect(
    () => () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

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
          {items.map((item) => {
            const active = !overviewSelected && item.id === activeItemId;
            const showSwitcher = gridOpen && item.id === activeItemId;
            return (
              <button
                aria-current={active ? "page" : undefined}
                aria-label={
                  showSwitcher || !item.surface
                    ? "Choose project tab group"
                    : (item.label ?? item.surface.title)
                }
                className={cn(
                  "flex touch-manipulation select-none flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  evenlyDivided
                    ? "min-w-0 flex-1"
                    : "min-w-[4.5rem] max-w-28 shrink-0 px-2",
                  active && "text-foreground",
                )}
                key={item.id}
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  onSelect(item.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  resetBottomTab(item.id);
                }}
                onPointerCancel={cancelLongPress}
                onPointerDown={() => beginLongPress(item.id)}
                onPointerLeave={cancelLongPress}
                onPointerUp={cancelLongPress}
                title="Hold to choose another project tab group"
                type="button"
              >
                {showSwitcher || !item.surface ? (
                  <LayoutGrid
                    className="size-4"
                    fill={active ? "currentColor" : "none"}
                  />
                ) : (
                  <ProjectSurfaceIcon
                    className="size-4"
                    filled={active}
                    kind={
                      item.surface.kind === "chat" &&
                      item.surface.entity.experience === "task"
                        ? "task"
                        : item.surface.kind
                    }
                  />
                )}
                <span className="max-w-full truncate">
                  {showSwitcher || !item.surface
                    ? "Tabs"
                    : (item.label ?? item.surface.title)}
                </span>
              </button>
            );
          })}
          <button
            aria-label="Add bottom tab"
            className={cn(
              "grid place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              evenlyDivided ? "min-w-0 flex-1" : "min-w-[4.5rem] shrink-0",
            )}
            onClick={onAdd}
            onPointerDown={() => void performMobileNavigationHaptic("press")}
            type="button"
          >
            <Plus className="size-5" />
          </button>
        </div>
      </div>
    </nav>
  );
}
