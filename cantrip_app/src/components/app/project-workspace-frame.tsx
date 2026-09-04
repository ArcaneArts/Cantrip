import * as ContextMenu from "@radix-ui/react-context-menu";
import { useDroppable } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ExecutionTarget,
  type ProjectDockPresentationPreference,
  type ProjectPaneRegion,
  type ProjectPaneSummary,
} from "@cantrip/protocol";
import { useQueries } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import {
  Fragment,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  DetachedPanePlaceholder,
  GlobalContentHost,
} from "@/components/app/global-content-host";
import { resolvedCenterLayoutRoot } from "@/components/app/center-split-layout";
import { CenterSplitWorkspace } from "@/components/app/center-split-workspace";
import { DockResizeControl } from "@/components/app/dock-resize-control";
import { PersistentSurfaceLayer } from "@/components/app/persistent-surface-layer";
import { projectPaneRenderBindings } from "@/components/app/project-pane-render-bindings";
import {
  createKindsForPaneRegion,
  legacyTopStripPresentation,
  legacyTopStripShowsSidebarPreview,
  partitionVisibleWorkspacePanes,
  responsiveProjectWorkspaceGridModel,
  sidebarFilePreviewForPane,
  visibleWorkspacePanes,
  type VisibleProjectPane,
} from "@/components/app/project-workspace-frame-model";
import {
  DEFAULT_DOCK_PRESENTATION,
  dockIsRendered,
  dockPresentationAfterRailTabClick,
  dockPresentationForKey,
  dockPresentationForPane,
  dockResizeCandidate,
  resizeDockPresentation,
  restoreDockPresentation,
  temporarySplitFraction,
  type DockRegion,
} from "@/components/app/project-dock-presentation";
import {
  ProjectPaneTabStrip,
  surfaceCanDelete,
  surfaceDeleteLabel,
} from "@/components/workspace/project-tab-bar";
import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import {
  useWorkspaceDndState,
  WorkspaceDropPlaceholder,
} from "@/components/workspace/workspace-dnd-state";
import { ProjectBuiltInSurfaceIcon } from "@/components/sidebar/project-tool-launchers";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import {
  Tooltip,
  TooltipButton,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getProjectRepositoryStats,
  getProjectTokenUsage,
  getRemoteDesktop,
} from "@/lib/api";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "@/lib/tab-middle-click";
import { useAppLiveScope } from "@/lib/app-live-react";
import { sidebarFileName } from "@/lib/sidebar-file-tabs";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceRegionDropId,
  workspaceSurfaceDropPreview,
  workspaceSurfaceDragId,
} from "@/lib/workspace-dnd-model";

function VisibleChatLiveScope({ chatId }: { chatId: string }) {
  useAppLiveScope({ kind: "chat", chatId });
  return null;
}

function SortableDockRailTab({
  active,
  disabled,
  memberPosition,
  onClose,
  onDelete,
  onMoveToRegion,
  onSelect,
  region,
  surface,
}: {
  active: boolean;
  disabled: boolean;
  memberPosition: number;
  onClose(): void;
  onDelete(): void;
  onMoveToRegion?(
    region: Extract<ProjectPaneRegion, "center" | DockRegion>,
  ): void;
  onSelect(): void;
  region: DockRegion;
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
    transition: {
      duration: 180,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    },
  });
  const canDelete = surfaceCanDelete(surface);
  const tooltipSide = region === "right" ? "left" : "top";
  const action = !active
    ? "Focus"
    : surface.member.dockPresentation?.preferredMode === "closed"
      ? "Expand"
      : "Collapse";
  const actionLabel = `${action} ${surface.title}`;
  return (
    <div
      className="size-10 shrink-0"
      data-dock-rail-tab={surface.tabKey}
      data-dock-rail-tab-position={memberPosition}
      onAuxClick={(event) => {
        if (!disabled) closeTabOnMiddleClick(event, onClose);
      }}
      onMouseDown={preventMiddleMouseDefault}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.35 : 1,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      {...(disabled ? {} : sortable.attributes)}
      {...(disabled ? {} : sortable.listeners)}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="size-10 shrink-0">
            <TooltipButton
              aria-label={`${actionLabel} in ${region} dock`}
              aria-pressed={active}
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-none border-border p-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                region === "right" ? "border-b" : "border-r",
                active && "bg-muted text-foreground",
              )}
              disabled={disabled}
              onClick={onSelect}
              size="icon"
              tooltip={actionLabel}
              tooltipSide={tooltipSide}
              variant="ghost"
            >
              {surface.kind === "builtin" ? (
                <ProjectBuiltInSurfaceIcon
                  className="size-4"
                  definitionId={surface.entity.definitionId}
                />
              ) : (
                <ProjectSurfaceIcon className="size-4" kind={surface.kind} />
              )}
            </TooltipButton>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <StyledContextMenuContent className="min-w-40">
            {onMoveToRegion
              ? (["center", "right", "bottom"] as const)
                  .filter(
                    (targetRegion) =>
                      targetRegion !== region &&
                      surface.definition.supportedPlacements.includes(
                        targetRegion,
                      ),
                  )
                  .map((targetRegion) => (
                    <StyledContextMenuItem
                      key={targetRegion}
                      onSelect={() => onMoveToRegion(targetRegion)}
                    >
                      Move to{" "}
                      {targetRegion === "center"
                        ? "Center"
                        : targetRegion === "right"
                          ? "Right"
                          : "Bottom"}
                    </StyledContextMenuItem>
                  ))
              : null}
            <StyledContextMenuItem onSelect={onClose}>
              <X className="size-4" /> Close View
            </StyledContextMenuItem>
            {canDelete ? (
              <ContextMenu.Separator className="my-1 h-px bg-border" />
            ) : null}
            {canDelete ? (
              <StyledContextMenuItem
                className="text-destructive focus:bg-destructive/10"
                onSelect={onDelete}
              >
                <Trash2 className="size-4" />
                {surfaceDeleteLabel(surface)}
              </StyledContextMenuItem>
            ) : null}
          </StyledContextMenuContent>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

export function DockRail({
  activeTabKey,
  creatingKinds,
  onCreate,
  onClose,
  onDelete,
  onMoveToRegion,
  onSelect,
  pending,
  pane,
  placement,
  projectId,
  region,
  surfaces,
}: {
  activeTabKey: string | null;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onClose(surface: ProjectSurface): void;
  onDelete(surface: ProjectSurface): void;
  onMoveToRegion?(
    surface: ProjectSurface,
    region: Extract<ProjectPaneRegion, "center" | "right" | "bottom">,
  ): void;
  onSelect(surface: ProjectSurface, active: boolean): void;
  pending: boolean;
  pane: ProjectPaneSummary | undefined;
  placement?: ProjectSurfacePlacementContext;
  projectId: string;
  region: DockRegion;
  surfaces: readonly ProjectSurface[];
}) {
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createTooltipOpen, setCreateTooltipOpen] = useState(false);
  const drop = useDroppable({
    id: workspaceRegionDropId(region),
    data: {
      drop: {
        paneId: pane?.id ?? null,
        projectId,
        region,
        type: "region",
      },
    } satisfies WorkspaceDndData,
  });
  const workspaceDnd = useWorkspaceDndState();
  const crossPaneDrag =
    workspaceDnd.activeDrag?.type === "surface" &&
    workspaceDnd.activeDrag.paneId !== (pane?.id ?? null)
      ? workspaceDnd.activeDrag
      : null;
  const dropPreview = workspaceSurfaceDropPreview({
    decision: workspaceDnd.decision,
    drag: workspaceDnd.activeDrag,
    drop: workspaceDnd.dropTarget,
    memberCount: surfaces.length,
    paneId: pane?.id ?? null,
    region,
  });
  const tooltipSide = region === "right" ? "left" : "top";
  return (
    <>
      <aside
        aria-label={`${region === "right" ? "Right" : "Bottom"} dock rail`}
        className={cn(
          "z-40 flex shrink-0 border-border",
          region === "right"
            ? "min-h-0 w-10 flex-col overflow-y-auto border-l [scrollbar-width:none]"
            : "h-10 min-w-0 flex-row overflow-x-auto border-t [scrollbar-width:none]",
          drop.isOver && "bg-primary/10",
        )}
        data-dock-rail={region}
        ref={drop.setNodeRef}
        style={
          region === "right"
            ? { gridColumn: 2, gridRow: 1 }
            : { gridColumn: "1 / -1", gridRow: 2 }
        }
      >
        <Tooltip
          onOpenChange={(open) => setCreateTooltipOpen(open && !createMenuOpen)}
          open={createTooltipOpen && !createMenuOpen}
        >
          <TooltipTrigger asChild>
            <span className="inline-flex size-10 shrink-0">
              <ProjectSurfaceCreateMenu
                align={region === "right" ? "end" : "start"}
                allowedKinds={createKindsForPaneRegion(region)}
                creatingKinds={creatingKinds}
                onCreate={onCreate}
                onOpenChange={(open) => {
                  setCreateMenuOpen(open);
                  if (open) setCreateTooltipOpen(false);
                }}
                placement={placement}
                trigger={
                  <button
                    aria-label={`Add surface to ${region} dock`}
                    className={cn(
                      "grid size-10 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                      region === "right" ? "border-b" : "border-r",
                    )}
                    disabled={pending}
                    type="button"
                  >
                    <Plus className="size-4" />
                  </button>
                }
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            Add surface to {region} dock
          </TooltipContent>
        </Tooltip>
        <SortableContext
          items={surfaces.map((surface) =>
            workspaceSurfaceDragId(surface.tabKey),
          )}
          strategy={
            region === "right"
              ? verticalListSortingStrategy
              : horizontalListSortingStrategy
          }
        >
          {surfaces.map((surface, memberPosition) => (
            <Fragment key={surface.tabKey}>
              {crossPaneDrag ? (
                <WorkspaceDropPlaceholder
                  active={dropPreview?.memberPosition === memberPosition}
                  compact
                  label={crossPaneDrag.label}
                  orientation={region === "right" ? "vertical" : "horizontal"}
                  paneId={pane?.id ?? null}
                  tabKey={crossPaneDrag.tabKey}
                  visualKind={crossPaneDrag.visualKind}
                />
              ) : null}
              <SortableDockRailTab
                active={surface.tabKey === activeTabKey}
                disabled={pending}
                memberPosition={memberPosition}
                onClose={() => onClose(surface)}
                onDelete={() => onDelete(surface)}
                onMoveToRegion={
                  onMoveToRegion
                    ? (targetRegion) => onMoveToRegion(surface, targetRegion)
                    : undefined
                }
                onSelect={() =>
                  onSelect(surface, surface.tabKey === activeTabKey)
                }
                region={region}
                surface={surface}
              />
            </Fragment>
          ))}
          {crossPaneDrag ? (
            <WorkspaceDropPlaceholder
              active={dropPreview?.memberPosition === surfaces.length}
              compact
              label={crossPaneDrag.label}
              orientation={region === "right" ? "vertical" : "horizontal"}
              paneId={pane?.id ?? null}
              tabKey={crossPaneDrag.tabKey}
              visualKind={crossPaneDrag.visualKind}
            />
          ) : null}
        </SortableContext>
      </aside>
    </>
  );
}

function genericPaneBody(
  bindings: Readonly<Record<string, any>>,
  presentation: VisibleProjectPane,
  nested = false,
): ReactNode {
  if (bindings.paneOwnedElsewhere?.(presentation.pane.id)) {
    return (
      <div
        className={cn("min-h-0 min-w-0", nested && "flex-1")}
        data-detached-pane-placeholder={presentation.pane.id}
        data-project-pane-id={presentation.pane.id}
        style={nested ? undefined : { gridArea: presentation.gridArea }}
      >
        <DetachedPanePlaceholder
          onFocus={() => bindings.focusDetachedPane(presentation.pane.id)}
        />
      </div>
    );
  }
  if (
    bindings.sidebarFilePreviewPaneVisible &&
    sidebarFilePreviewForPane(presentation, bindings.sidebarFilePreview)?.active
  ) {
    return null;
  }
  const kind = presentation.activeSurface?.kind;
  if (
    kind === "code" ||
    kind === "explorer" ||
    (kind === "terminal" &&
      presentation.activeSurface?.entity.kind !== "run-configuration")
  ) {
    return null;
  }
  if (!presentation.activeSurface) {
    return (
      <div
        className={cn(
          "grid min-h-0 min-w-0 place-items-center text-sm text-muted-foreground",
          nested && "flex-1",
        )}
        data-project-pane-id={presentation.pane.id}
        style={nested ? undefined : { gridArea: presentation.gridArea }}
      >
        Loading pane…
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        nested && "flex-1",
      )}
      data-project-pane-body={presentation.pane.id}
      data-project-pane-id={presentation.pane.id}
      key={presentation.pane.id}
      style={nested ? undefined : { gridArea: presentation.gridArea }}
    >
      <GlobalContentHost
        bindings={projectPaneRenderBindings(bindings, presentation)}
      />
    </div>
  );
}

function PaneBodyHost({
  bindings,
  presentation,
}: {
  bindings: Readonly<Record<string, any>>;
  presentation: VisibleProjectPane;
}) {
  const portalTarget = presentation.portalTarget;
  const attachPortalTarget = useCallback(
    (host: HTMLDivElement | null) => {
      if (host && portalTarget && portalTarget.parentElement !== host) {
        host.appendChild(portalTarget);
      }
    },
    [portalTarget],
  );
  return (
    <div
      className="relative flex min-h-0 min-w-0 overflow-hidden"
      data-project-pane-body={presentation.pane.id}
      data-project-pane-id={presentation.pane.id}
      ref={attachPortalTarget}
      style={{ gridArea: presentation.gridArea }}
    >
      {genericPaneBody(bindings, presentation, true)}
    </div>
  );
}

export function ProjectWorkspaceFrame({
  bindings,
  docked,
  railsVisible,
}: {
  bindings: Readonly<Record<string, any>>;
  docked: boolean;
  railsVisible: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const resizePointerRef = useRef<{
    latestPreference: ProjectDockPresentationPreference;
    moved: boolean;
    pointerId: number;
    region: DockRegion;
    startClientX: number;
    startClientY: number;
    startPreference: ProjectDockPresentationPreference;
    tabKey: string;
  } | null>(null);
  const resizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);
  const [frameSize, setFrameSize] = useState({ height: 0, width: 0 });
  const [resizeDraft, setResizeDraft] = useState<{
    preference: ProjectDockPresentationPreference;
    tabKey: string;
  } | null>(null);
  const panePortalTargetsRef = useRef(new Map<string, HTMLDivElement>());
  const [visiblePaneIdByRegion, setVisiblePaneIdByRegion] = useState<
    Partial<Record<ProjectPaneRegion, string>>
  >({});
  const focusedPane: ProjectPaneSummary | undefined =
    bindings.tabLayout.data?.panes.find(
      ({ id }: { id: string }) =>
        id === bindings.workspaceSelection.focusedPaneId,
    );
  const centerRoot = resolvedCenterLayoutRoot({
    centerPaneIds: (bindings.tabLayout.data?.panes ?? [])
      .filter(({ region }: ProjectPaneSummary) => region === "center")
      .map(({ id }: ProjectPaneSummary) => id),
    preferredPaneId:
      focusedPane?.region === "center" ? focusedPane.id : undefined,
    root: bindings.tabLayout.data?.centerRoot,
  });
  const panePortalTarget = (paneId: string) => {
    const current = panePortalTargetsRef.current.get(paneId);
    if (current || typeof document === "undefined") return current ?? null;
    const target = document.createElement("div");
    target.className = "contents";
    target.dataset.persistentSurfacePaneHost = paneId;
    panePortalTargetsRef.current.set(paneId, target);
    return target;
  };
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () =>
      setFrameSize({ height: frame.clientHeight, width: frame.clientWidth });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!focusedPane) return;
    setVisiblePaneIdByRegion((current) =>
      current[focusedPane.region] === focusedPane.id
        ? current
        : { ...current, [focusedPane.region]: focusedPane.id },
    );
  }, [focusedPane]);
  const presentations = useMemo(
    () =>
      visibleWorkspacePanes({
        activeTabByPane: bindings.workspaceSelection.activeTabByPane,
        centerRoot: bindings.tabLayout.data?.centerRoot,
        focusedPaneId: bindings.workspaceSelection.focusedPaneId,
        panes: bindings.tabLayout.data?.panes ?? [],
        surfaceByPaneId: bindings.projectSurfaceIndex.byPaneId,
        visiblePaneIdByRegion,
      }),
    [
      bindings.projectSurfaceIndex,
      bindings.tabLayout.data?.centerRoot,
      bindings.tabLayout.data?.panes,
      bindings.workspaceSelection.activeTabByPane,
      bindings.workspaceSelection.focusedPaneId,
      visiblePaneIdByRegion,
    ],
  );
  const excludedPersistentSurfaceIds = useMemo(
    () =>
      new Set(
        bindings.projectSurfaces
          .filter(({ paneId }: ProjectSurface) =>
            bindings.paneOwnedElsewhere?.(paneId),
          )
          .map(({ entity }: ProjectSurface) =>
            "id" in entity ? entity.id : "",
          )
          .filter(Boolean),
      ),
    [bindings.paneOwnedElsewhere, bindings.projectSurfaces],
  );
  const centers = presentations.filter(({ pane }) => pane.region === "center");
  const right = presentations.find(({ pane }) => pane.region === "right");
  const bottom = presentations.find(({ pane }) => pane.region === "bottom");
  const preferenceFor = (presentation: VisibleProjectPane | undefined) =>
    presentation && resizeDraft?.tabKey === presentation.activeTabKey
      ? resizeDraft.preference
      : dockPresentationForPane(presentation);
  const rightPreference = preferenceFor(right);
  const bottomPreference = preferenceFor(bottom);
  const fullRegion: DockRegion | null =
    right?.focused && rightPreference?.preferredMode === "full"
      ? "right"
      : bottom?.focused && bottomPreference?.preferredMode === "full"
        ? "bottom"
        : null;
  const rightRendered = Boolean(right && dockIsRendered(rightPreference));
  const bottomRendered = Boolean(bottom && dockIsRendered(bottomPreference));
  const { bottomFraction, grid, rightFraction } =
    responsiveProjectWorkspaceGridModel({
      bottom: bottomRendered,
      center: Boolean(centerRoot && centers.length > 0),
      frameHeight: frameSize.height,
      frameWidth: frameSize.width,
      fullRegion,
      right: rightRendered,
      savedBottomFraction: bottomPreference
        ? temporarySplitFraction(bottomPreference, fullRegion === "bottom")
        : 0.32,
      savedRightFraction: rightPreference
        ? temporarySplitFraction(rightPreference, fullRegion === "right")
        : 0.32,
    });
  const renderedPresentations = (
    fullRegion
      ? presentations.filter(({ pane }) => pane.region === fullRegion)
      : presentations.filter(
          ({ pane }) =>
            pane.region === "center" ||
            (pane.region === "right" && rightRendered) ||
            (pane.region === "bottom" && bottomRendered),
        )
  ).map((presentation) => ({
    ...presentation,
    portalTarget: bindings.paneOwnedElsewhere?.(presentation.pane.id)
      ? null
      : panePortalTarget(presentation.pane.id),
  }));
  const { live: livePresentations } = partitionVisibleWorkspacePanes(
    renderedPresentations,
    (paneId) => Boolean(bindings.paneOwnedElsewhere?.(paneId)),
  );
  const remotePresentations = livePresentations.filter(
    ({ activeSurface }) => activeSurface?.kind === "remote-desktop",
  );
  const remoteDesktopQueries = useQueries({
    queries: remotePresentations.map(({ activeSurface }) => ({
      enabled: docked,
      queryFn: () => getRemoteDesktop(activeSurface!.tabId),
      queryKey: ["remote-desktop", activeSurface!.tabId],
      refetchInterval: 10_000,
    })),
  });
  const remoteDesktopByTabKey = new Map(
    remotePresentations.map((presentation, index) => [
      presentation.activeTabKey,
      remoteDesktopQueries[index],
    ]),
  );
  const overviewPresentation = livePresentations.find(
    ({ activeSurface }) =>
      activeSurface?.kind === "builtin" &&
      activeSurface.entity.definitionId === "project.overview",
  );
  const [visibleRepositoryStats, visibleProjectTokenUsage] = useQueries({
    queries: [
      {
        enabled: Boolean(
          docked &&
          overviewPresentation &&
          bindings.selectedProject.setupStatus === "ready" &&
          bindings.selectedProject.source,
        ),
        queryFn: () => getProjectRepositoryStats(bindings.selectedProject.id),
        queryKey: ["project-repository-stats", bindings.selectedProject.id],
        retry: false,
        staleTime: 30_000,
      },
      {
        enabled: Boolean(docked && overviewPresentation),
        queryFn: () => getProjectTokenUsage(bindings.selectedProject.id),
        queryKey: ["project-token-usage", bindings.selectedProject.id],
        refetchInterval: 15_000,
        staleTime: 10_000,
      },
    ],
  });
  const bindingsForPresentation = (presentation: VisibleProjectPane) => {
    const remoteDesktop = remoteDesktopByTabKey.get(presentation.activeTabKey);
    if (remoteDesktop) return { ...bindings, remoteDesktop };
    if (presentation === overviewPresentation) {
      return {
        ...bindings,
        projectTokenUsage: visibleProjectTokenUsage,
        repositoryStats: visibleRepositoryStats,
      };
    }
    return bindings;
  };
  const commitDockPresentation = (
    projectId: string,
    tabKey: string,
    preference: ProjectDockPresentationPreference,
  ) => {
    if (
      bindings.dockPresentationMutation.isPending ||
      bindings.tabLayoutMutation.isPending
    ) {
      return false;
    }
    bindings.dockPresentationMutation.mutate({
      presentation: preference,
      projectId,
      tabKey,
    });
    return true;
  };
  const restoreResizeBodyStyles = () => {
    const previous = resizeBodyStyleRef.current;
    resizeBodyStyleRef.current = null;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
  };
  const beginResize =
    (
      region: DockRegion,
      presentation: VisibleProjectPane,
      preference: ProjectDockPresentationPreference,
    ) =>
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        bindings.dockPresentationMutation.isPending ||
        bindings.tabLayoutMutation.isPending
      ) {
        return;
      }
      resizePointerRef.current = {
        latestPreference: preference,
        moved: false,
        pointerId: event.pointerId,
        region,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPreference: preference,
        tabKey: presentation.activeTabKey,
      };
      resizeBodyStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor =
        region === "right" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizePointerRef.current;
    const frame = frameRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !frame) return;
    const bounds = frame.getBoundingClientRect();
    const total = resize.region === "right" ? bounds.width : bounds.height;
    if (total <= 0) return;
    const candidate = dockResizeCandidate({
      currentCoordinate:
        resize.region === "right" ? event.clientX : event.clientY,
      leadingEdge: resize.region === "right" ? bounds.left : bounds.top,
      preference: resize.startPreference,
      startCoordinate:
        resize.region === "right" ? resize.startClientX : resize.startClientY,
      trailingEdge: resize.region === "right" ? bounds.right : bounds.bottom,
    });
    const preference = resizeDockPresentation(
      resize.latestPreference,
      candidate,
    );
    resize.latestPreference = preference;
    resize.moved = true;
    setResizeDraft({ preference, tabKey: resize.tabKey });
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizePointerRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreResizeBodyStyles();
    setResizeDraft(null);
    if (resize.moved) {
      const presentation = presentations.find(
        ({ activeTabKey }) => activeTabKey === resize.tabKey,
      );
      if (presentation) {
        commitDockPresentation(
          presentation.pane.projectId,
          presentation.activeTabKey,
          resize.latestPreference,
        );
      }
    }
  };
  const cancelResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizePointerRef.current?.pointerId !== event.pointerId) return;
    resizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreResizeBodyStyles();
    setResizeDraft(null);
  };
  useEffect(
    () => () => {
      restoreResizeBodyStyles();
    },
    [],
  );
  const tabStrip = (presentation: VisibleProjectPane) => {
    const sidebarPreview = sidebarFilePreviewForPane(
      presentation,
      bindings.sidebarFilePreview,
    );
    return (
      <div
        className="min-w-0 overflow-hidden border-b"
        data-project-pane-id={presentation.pane.id}
        key={`${presentation.pane.id}:tabs`}
      >
        <ProjectPaneTabStrip
          activeTabKey={presentation.activeTabKey}
          allowedCreateKinds={createKindsForPaneRegion(
            presentation.pane.region,
          )}
          creatingKinds={bindings.creatingSurfaceKinds}
          onCreate={(kind, target) =>
            bindings.createProjectSurface(
              presentation.pane.projectId,
              kind,
              presentation.pane.id,
              target,
            )
          }
          onClose={bindings.closeSurfaceView}
          onDelete={bindings.deleteSurfaceResource}
          onMoveToRegion={bindings.moveSurfaceToRegion}
          onRename={bindings.renameSurface}
          onSelect={bindings.selectTopTab}
          paneId={presentation.pane.id}
          paneRegion={presentation.pane.region}
          placement={bindings.selectedPlacementContext}
          previewFile={
            sidebarPreview
              ? {
                  active: sidebarPreview.active,
                  onClose: bindings.closeSidebarFilePreview,
                  onPin: () => {
                    if (bindings.sidebarPreviewExplorer) {
                      void bindings.pinSidebarFilePath(
                        bindings.sidebarPreviewExplorer,
                        sidebarPreview.path,
                      );
                    }
                  },
                  onSelect: bindings.activateSidebarFilePreview,
                  path: sidebarPreview.path,
                  projectId: sidebarPreview.projectId,
                  title: sidebarFileName(sidebarPreview.path),
                }
              : undefined
          }
          projectId={presentation.pane.projectId}
          surfaces={presentation.surfaces}
        />
      </div>
    );
  };
  const selectDockRailSurface = (surface: ProjectSurface, active: boolean) => {
    const pane = bindings.tabLayout.data?.panes.find(
      ({ id }: { id: string }) => id === surface.paneId,
    );
    const preference =
      surface.member.dockPresentation ?? DEFAULT_DOCK_PRESENTATION;
    if (pane?.region === "right" || pane?.region === "bottom") {
      const nextPreference = dockPresentationAfterRailTabClick(
        preference,
        active,
      );
      if (nextPreference !== preference) {
        commitDockPresentation(
          surface.projectId,
          surface.tabKey,
          nextPreference,
        );
      }
    }
    bindings.selectTopTab(surface.tabKey);
  };
  const commitCenterSplitResize = (splitId: string, fraction: number) => {
    if (
      bindings.tabLayoutMutation.isPending ||
      bindings.dockPresentationMutation.isPending ||
      bindings.tabLayout.data?.centerRoot === undefined
    ) {
      return;
    }
    bindings.tabLayoutMutation.mutate({
      command: { type: "resize-center-split", splitId, fraction },
      projectId: bindings.selectedProject.id,
    });
  };
  const resizeControl = (
    presentation: VisibleProjectPane | undefined,
    preference: ProjectDockPresentationPreference | null,
    region: DockRegion,
    fraction: number,
  ) => {
    if (!presentation || !preference || (fullRegion && fullRegion !== region)) {
      return null;
    }
    const mode =
      fullRegion === region
        ? "full"
        : preference.preferredMode === "closed"
          ? "closed"
          : "split";
    const direction = region === "right" ? "vertical" : "horizontal";
    const dividerAvailable =
      region === "right" ? grid.showRightDivider : grid.showBottomDivider;
    const activeResize = resizePointerRef.current?.region === region;
    if (mode === "split" && !dividerAvailable && !activeResize) {
      return null;
    }
    const placementMode =
      mode === "split" && !dividerAvailable && activeResize
        ? resizePointerRef.current?.startPreference.preferredMode
        : mode;
    const style: CSSProperties =
      placementMode === "split"
        ? { gridArea: `${region}-divider` }
        : region === "right"
          ? {
              bottom: 0,
              left: placementMode === "full" ? 0 : undefined,
              position: "absolute",
              right: placementMode === "closed" ? 0 : undefined,
              top: 0,
              width: 6,
            }
          : {
              bottom: placementMode === "closed" ? 0 : undefined,
              height: 6,
              left: 0,
              position: "absolute",
              right: 0,
              top: placementMode === "full" ? 0 : undefined,
            };
    const commit = (next: ProjectDockPresentationPreference) =>
      commitDockPresentation(
        presentation.pane.projectId,
        presentation.activeTabKey,
        next,
      );
    return (
      <DockResizeControl
        direction={direction}
        fraction={mode === "closed" ? 0.05 : mode === "full" ? 0.95 : fraction}
        key={`${region}-resize-control`}
        label={`${region === "right" ? "Right" : "Bottom"} dock size`}
        mode={mode}
        onDoubleClick={() => commit(restoreDockPresentation(preference))}
        onKeyChange={(key) => {
          const next = dockPresentationForKey(direction, preference, key);
          if (next) commit(next);
        }}
        onPointerBegin={beginResize(region, presentation, preference)}
        onPointerCancel={cancelResize}
        onPointerEnd={endResize}
        onPointerMove={moveResize}
        style={style}
      />
    );
  };
  const focusPaneFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const paneId = target.closest<HTMLElement>("[data-project-pane-id]")
      ?.dataset.projectPaneId;
    if (!paneId || paneId === bindings.workspaceSelection.focusedPaneId) return;
    const presentation = presentations.find(({ pane }) => pane.id === paneId);
    if (!presentation) return;
    if (
      bindings.sidebarFilePreview?.active &&
      bindings.sidebarFilePreview.paneId === paneId
    ) {
      bindings.activateSidebarFilePreview();
      return;
    }
    bindings.selectTopTab(presentation.activeTabKey);
  };
  const presentationMutationPending = Boolean(
    bindings.dockPresentationMutation.isPending ||
    bindings.tabLayoutMutation.isPending,
  );
  const legacyTopStrip = legacyTopStripPresentation(presentations);
  const persistentSurfaceBindings = docked
    ? {
        ...bindings,
        dockPanePresentations: livePresentations,
        excludedPersistentSurfaceIds,
      }
    : railsVisible
      ? {
          ...bindings,
          selectedPane: legacyTopStrip?.pane,
          selectedPaneOwnedElsewhere: legacyTopStrip
            ? Boolean(bindings.paneOwnedElsewhere?.(legacyTopStrip.pane.id))
            : false,
          selectedPaneSurfaces: legacyTopStrip?.surfaces ?? [],
          selectedTabKey: legacyTopStrip?.activeTabKey ?? null,
          showSidebarPreviewTab: legacyTopStripShowsSidebarPreview(
            legacyTopStrip,
            bindings.sidebarFilePreview,
          ),
        }
      : bindings;

  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
      data-docked={docked ? "true" : "false"}
      data-rails-visible={railsVisible ? "true" : "false"}
      style={{
        gridTemplateColumns: railsVisible
          ? "minmax(0, 1fr) 2.5rem"
          : "minmax(0, 1fr) 0",
        gridTemplateRows: railsVisible
          ? "minmax(0, 1fr) 2.5rem"
          : "minmax(0, 1fr) 0",
      }}
    >
      <div
        className={cn(
          "relative min-h-0 min-w-0 overflow-hidden",
          docked ? "grid" : "flex flex-1 flex-col",
        )}
        data-project-workspace-frame
        onFocusCapture={(event) => focusPaneFromTarget(event.target)}
        onPointerDownCapture={(event) => focusPaneFromTarget(event.target)}
        ref={frameRef}
        style={
          docked
            ? {
                gridColumn: 1,
                gridRow: 1,
                gridTemplateAreas: grid.gridTemplateAreas,
                gridTemplateColumns: grid.gridTemplateColumns,
                gridTemplateRows: grid.gridTemplateRows,
              }
            : { gridColumn: 1, gridRow: 1 }
        }
      >
        {docked && centerRoot && !fullRegion ? (
          <div
            className="grid min-h-0 min-w-0 overflow-hidden"
            data-center-layout-root
            style={{ gridArea: "center-root" }}
          >
            <CenterSplitWorkspace
              controlsEnabled={
                bindings.tabLayout.data?.centerRoot !== undefined &&
                !bindings.tabLayoutMutation.isPending
              }
              node={centerRoot}
              onResize={commitCenterSplitResize}
              presentationByPaneId={
                new Map(
                  renderedPresentations
                    .filter(({ pane }) => pane.region === "center")
                    .map((presentation) => [
                      presentation.pane.id,
                      presentation,
                    ]),
                )
              }
              renderPaneBody={(presentation) =>
                genericPaneBody(
                  bindingsForPresentation(presentation),
                  presentation,
                  true,
                )
              }
              renderTabStrip={(presentation) => tabStrip(presentation)}
            />
          </div>
        ) : null}
        {docked
          ? resizeControl(right, rightPreference, "right", rightFraction)
          : null}
        {docked
          ? resizeControl(bottom, bottomPreference, "bottom", bottomFraction)
          : null}
        {docked
          ? renderedPresentations.flatMap((presentation) =>
              presentation.pane.region === "center"
                ? []
                : [
                    <PaneBodyHost
                      bindings={bindingsForPresentation(presentation)}
                      key={`${presentation.pane.id}:body`}
                      presentation={presentation}
                    />,
                  ],
            )
          : null}
        {docked
          ? livePresentations.flatMap(({ activeSurface }) =>
              activeSurface?.kind === "chat"
                ? [
                    <VisibleChatLiveScope
                      chatId={activeSurface.entity.id}
                      key={activeSurface.entity.id}
                    />,
                  ]
                : [],
            )
          : null}
        <PersistentSurfaceLayer
          bindings={persistentSurfaceBindings}
          key="persistent-surface-layer"
        />
        {!docked ? <GlobalContentHost bindings={bindings} /> : null}
      </div>
      {railsVisible ? (
        <DockRail
          activeTabKey={right?.activeTabKey ?? null}
          creatingKinds={bindings.creatingSurfaceKinds}
          onCreate={(kind, target) =>
            bindings.createProjectSurface(
              bindings.selectedProject.id,
              kind,
              right?.pane.id,
              target,
              right ? undefined : "right",
            )
          }
          onClose={bindings.closeSurfaceView}
          onDelete={bindings.deleteSurfaceResource}
          onMoveToRegion={bindings.moveSurfaceToRegion}
          onSelect={selectDockRailSurface}
          pending={presentationMutationPending}
          pane={right?.pane}
          placement={bindings.selectedPlacementContext}
          projectId={bindings.selectedProject.id}
          region="right"
          surfaces={right?.surfaces ?? []}
        />
      ) : null}
      {railsVisible ? (
        <DockRail
          activeTabKey={bottom?.activeTabKey ?? null}
          creatingKinds={bindings.creatingSurfaceKinds}
          onCreate={(kind, target) =>
            bindings.createProjectSurface(
              bindings.selectedProject.id,
              kind,
              bottom?.pane.id,
              target,
              bottom ? undefined : "bottom",
            )
          }
          onClose={bindings.closeSurfaceView}
          onDelete={bindings.deleteSurfaceResource}
          onMoveToRegion={bindings.moveSurfaceToRegion}
          onSelect={selectDockRailSurface}
          pending={presentationMutationPending}
          pane={bottom?.pane}
          placement={bindings.selectedPlacementContext}
          projectId={bindings.selectedProject.id}
          region="bottom"
          surfaces={bottom?.surfaces ?? []}
        />
      ) : null}
    </div>
  );
}
