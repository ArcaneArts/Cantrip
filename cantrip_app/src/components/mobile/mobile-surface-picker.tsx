import type { ExecutionTarget, ProjectCapabilities } from "@cantrip/protocol";
import { LayoutDashboard, Loader2, Plus, X } from "lucide-react";

import { performMobileNavigationHaptic } from "@/components/mobile/mobile-navigation-haptics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  projectSurfaceCreateOptions,
  type ProjectSurfaceCreateKind,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export function isMobileProjectOverviewSurface(
  surface: ProjectSurface,
): boolean {
  return (
    surface.kind === "builtin" &&
    surface.entity.definitionId === "project.overview"
  );
}

export function MobileSurfacePicker({
  activeTabKey,
  capabilities,
  creatingKinds,
  onCloseSurface,
  onCreate,
  onOpenChange,
  onOverview,
  onSelect,
  open,
  overviewSelected,
  projectName,
  surfaces,
}: {
  activeTabKey: string | null;
  capabilities?: ProjectCapabilities;
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  onCloseSurface(surface: ProjectSurface): void;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onOpenChange(open: boolean): void;
  onOverview(): void;
  onSelect(tabKey: string): void;
  open: boolean;
  overviewSelected: boolean;
  projectName: string;
  surfaces: readonly ProjectSurface[];
}) {
  const existingSurfaces = surfaces.filter(
    (surface) => !isMobileProjectOverviewSurface(surface),
  );
  const createOptions = projectSurfaceCreateOptions(
    creatingKinds,
    capabilities,
  );
  const selectOverview = () => {
    void performMobileNavigationHaptic("press");
    onOverview();
    onOpenChange(false);
  };
  const selectSurface = (surface: ProjectSurface) => {
    void performMobileNavigationHaptic("press");
    onSelect(surface.tabKey);
    onOpenChange(false);
  };
  const createSurface = (kind: ProjectSurfaceCreateKind) => {
    void performMobileNavigationHaptic("press");
    onCreate(kind);
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-full max-h-full max-w-none gap-0 overflow-hidden rounded-none border-0 p-0"
        showClose={false}
      >
        <DialogHeader className="flex shrink-0 grid-cols-none flex-row items-center gap-3 border-b px-4 py-3 pr-4">
          <Button
            aria-label="Close project tabs"
            className="size-10"
            onClick={() => onOpenChange(false)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-5" />
          </Button>
          <span className="min-w-0 flex-1">
            <DialogTitle>Project tabs</DialogTitle>
            <DialogDescription className="truncate leading-5">
              {projectName} · Choose an open view or add another
            </DialogDescription>
          </span>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <section aria-labelledby="mobile-open-project-views">
            <h2
              className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              id="mobile-open-project-views"
            >
              Open views
            </h2>
            <div className="mt-2 space-y-1">
              <button
                aria-current={overviewSelected ? "page" : undefined}
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  overviewSelected && "bg-muted text-foreground",
                )}
                onClick={selectOverview}
                type="button"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card">
                  <LayoutDashboard className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    Overview
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Project summary
                  </span>
                </span>
              </button>
              {existingSurfaces.map((surface) => {
                const active =
                  !overviewSelected && surface.tabKey === activeTabKey;
                const label =
                  surface.kind === "explorer" ? "Explorer" : surface.title;
                return (
                  <div
                    className={cn(
                      "flex min-h-14 items-center rounded-xl transition-colors hover:bg-muted",
                      active && "bg-muted text-foreground",
                    )}
                    data-mobile-surface-picker-item={surface.tabKey}
                    key={surface.tabKey}
                  >
                    <button
                      aria-current={active ? "page" : undefined}
                      aria-label={`Open ${label}`}
                      className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => selectSurface(surface)}
                      type="button"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card">
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
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {label}
                        </span>
                        <span className="block truncate text-xs capitalize text-muted-foreground">
                          {surface.kind === "builtin"
                            ? "Project tool"
                            : surface.kind.replace("-", " ")}
                        </span>
                      </span>
                    </button>
                    <Button
                      aria-label={`Remove ${label} from project tabs`}
                      className="mr-2 size-10"
                      onClick={() => onCloseSurface(surface)}
                      size="icon"
                      title={`Remove ${label} from project tabs`}
                      type="button"
                      variant="ghost"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="mobile-add-project-view" className="mt-6">
            <h2
              className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              id="mobile-add-project-view"
            >
              Add a view
            </h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {createOptions.map(({ disabled, kind, label }) => (
                <button
                  className="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={disabled}
                  key={kind}
                  onClick={() => createSurface(kind)}
                  type="button"
                >
                  {creatingKinds.has(kind) ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <ProjectSurfaceIcon
                      className="size-4 shrink-0"
                      kind={kind}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
