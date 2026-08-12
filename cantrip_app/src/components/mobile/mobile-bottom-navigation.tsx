import { LayoutDashboard, LayoutGrid, Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export const MOBILE_BOTTOM_TAB_LONG_PRESS_MS = 500;

export interface MobileBottomNavigationItem {
  id: string;
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
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const beginLongPress = (itemId: string) => {
    cancelLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressTriggeredRef.current = true;
      onReset(itemId);
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
      className="mobile-safe-bottom relative z-30 flex shrink-0 items-stretch border-t bg-background/95 px-2 pt-1.5 backdrop-blur-xl"
    >
      <button
        aria-current={overviewSelected ? "page" : undefined}
        className={cn(
          "flex w-[3.75rem] shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          overviewSelected && "text-foreground",
        )}
        onClick={onOverview}
        type="button"
      >
        <LayoutDashboard
          className="size-4"
          fill={overviewSelected ? "currentColor" : "none"}
        />
        <span>Overview</span>
      </button>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const active = !overviewSelected && item.id === activeItemId;
          const showSwitcher = gridOpen && item.id === activeItemId;
          return (
            <button
              aria-current={active ? "page" : undefined}
              aria-label={
                showSwitcher || !item.surface
                  ? "Choose project tab group"
                  : item.surface.title
              }
              className={cn(
                "flex max-w-24 flex-[1_0_3.75rem] touch-manipulation select-none flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
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
                cancelLongPress();
                onReset(item.id);
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
                  kind={item.surface.kind}
                />
              )}
              <span className="max-w-full truncate">
                {showSwitcher || !item.surface ? "Tabs" : item.surface.title}
              </span>
            </button>
          );
        })}
      </div>
      <button
        aria-label="Add bottom tab"
        className="grid w-11 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onAdd}
        type="button"
      >
        <Plus className="size-5" />
      </button>
    </nav>
  );
}
