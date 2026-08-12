import { LayoutDashboard, LayoutGrid } from "lucide-react";

import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export function MobileBottomNavigation({
  gridOpen,
  onOverview,
  onSecondDestination,
  overviewSelected,
  surface,
}: {
  gridOpen: boolean;
  onOverview(): void;
  onSecondDestination(): void;
  overviewSelected: boolean;
  surface?: ProjectSurface;
}) {
  const showSurface = !gridOpen && surface;
  const secondSelected = gridOpen || !overviewSelected;

  return (
    <nav
      aria-label="Project navigation"
      className="mobile-safe-bottom relative z-30 grid shrink-0 grid-cols-2 border-t bg-background/95 px-2 pt-1.5 backdrop-blur-xl"
    >
      <button
        aria-current={overviewSelected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          overviewSelected && "text-foreground",
        )}
        onClick={onOverview}
        type="button"
      >
        <LayoutDashboard className="size-4" />
        <span>Overview</span>
      </button>
      <button
        aria-current={secondSelected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          secondSelected && "text-foreground",
        )}
        onClick={onSecondDestination}
        type="button"
      >
        {showSurface ? (
          <ProjectSurfaceIcon className="size-4" kind={showSurface.kind} />
        ) : (
          <LayoutGrid className="size-4" />
        )}
        <span className="max-w-full truncate">
          {showSurface ? showSurface.title : "Tabs"}
        </span>
      </button>
    </nav>
  );
}
