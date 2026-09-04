import { useDroppable } from "@dnd-kit/core";
import {
  PROJECT_SURFACE_DEFINITIONS,
  projectBuiltinSurfaceDefinitionIdSchema,
  type ProjectDockPresentationPreference,
  type ProjectSurfaceLauncher,
  type ProjectPaneRegion,
  type ProjectPaneSummary,
} from "@cantrip/protocol";
import { useQueries } from "@tanstack/react-query";
import { PanelBottom, PanelRight } from "lucide-react";
import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { GlobalContentHost } from "@/components/app/global-content-host";
import { resolvedCenterLayoutRoot } from "@/components/app/center-split-layout";
import { CenterSplitWorkspace } from "@/components/app/center-split-workspace";
import { PersistentSurfaceLayer } from "@/components/app/persistent-surface-layer";
import { projectPaneRenderBindings } from "@/components/app/project-pane-render-bindings";
import {
  createKindsForPaneRegion,
  definitionIdByCreateKind,
  projectWorkspaceGridModel,
  railLauncherDisposition,
  visibleWorkspacePanes,
  type VisibleProjectPane,
} from "@/components/app/project-workspace-frame-model";
import {
  DEFAULT_DOCK_PRESENTATION,
  dockIsRendered,
  dockPresentationForKey,
  dockPresentationForPane,
  dockResizeCandidate,
  effectiveDockFraction,
  resizeDockPresentation,
  revealDockPresentation,
  restoreDockPresentation,
  temporarySplitFraction,
  type DockRegion,
} from "@/components/app/project-dock-presentation";
import { ProjectPaneTabStrip } from "@/components/workspace/project-tab-bar";
import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import { ProjectBuiltInSurfaceIcon } from "@/components/sidebar/project-tool-launchers";
import {
  getProjectRepositoryStats,
  getProjectTokenUsage,
  getRemoteDesktop,
} from "@/lib/api";
import type { ProjectSurface } from "@/lib/project-surface";
import { projectBuiltInSurfaceResourceRef } from "@/lib/project-tool-surfaces";
import { useAppLiveScope } from "@/lib/app-live-react";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspaceRegionDropId,
} from "@/lib/workspace-dnd-model";

function VisibleChatLiveScope({ chatId }: { chatId: string }) {
  useAppLiveScope({ kind: "chat", chatId });
  return null;
}

function DockResizeControl({
  direction,
  fraction,
  label,
  mode,
  onDoubleClick,
  onKeyChange,
  onPointerBegin,
  onPointerMove,
  onPointerEnd,
  onPointerCancel,
  style,
}: {
  direction: "horizontal" | "vertical";
  fraction: number;
  label: string;
  mode: ProjectDockPresentationPreference["preferredMode"];
  onDoubleClick(): void;
  onKeyChange(key: string): void;
  onPointerBegin(event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerEnd(event: PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: PointerEvent<HTMLDivElement>): void;
  style: CSSProperties;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "Enter",
        " ",
      ].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    onKeyChange(event.key);
  };
  return (
    <div
      aria-label={label}
      aria-orientation={direction}
      aria-valuemax={95}
      aria-valuemin={5}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={`${label} ${mode === "closed" ? "closed" : mode === "full" ? "full view" : `${Math.round(fraction * 100)} percent`}`}
      className={cn(
        "group relative z-30 bg-border outline-none focus-visible:bg-ring",
        direction === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      data-dock-resize-mode={mode}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onPointerEnd}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerBegin}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      role="separator"
      style={style}
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute bg-primary/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          direction === "vertical"
            ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
            : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
        )}
      />
    </div>
  );
}

function DockRail({
  activeTabKey,
  allSurfaces,
  launchers,
  onOpenLauncher,
  onSelect,
  pending,
  pane,
  projectId,
  region,
  surfaces,
}: {
  activeTabKey: string | null;
  allSurfaces: readonly ProjectSurface[];
  launchers: readonly ProjectSurfaceLauncher[];
  onOpenLauncher(launcher: ProjectSurfaceLauncher): void;
  onSelect(surface: ProjectSurface): void;
  pending: boolean;
  pane: ProjectPaneSummary | undefined;
  projectId: string;
  region: DockRegion;
  surfaces: readonly ProjectSurface[];
}) {
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
  const Icon = region === "right" ? PanelRight : PanelBottom;
  const regionLaunchers = launchers.filter(
    (launcher) =>
      launcher.location === `${region}-rail` &&
      launcher.target.kind === "definition",
  );
  const launcherSurface = (launcher: ProjectSurfaceLauncher) => {
    if (launcher.target.kind === "definition") {
      const definitionId = launcher.target.definitionId;
      return allSurfaces.find(
        (surface) => surface.definition.id === definitionId,
      );
    }
    const surfaceRef = launcher.target.surfaceRef;
    return allSurfaces.find(
      ({ resource }) =>
        JSON.stringify(resource.ref) === JSON.stringify(surfaceRef),
    );
  };
  return (
    <aside
      aria-label={`${region === "right" ? "Right" : "Bottom"} dock rail`}
      className={cn(
        "z-40 flex shrink-0 border-border bg-background",
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
      <div
        className={cn(
          "grid size-10 shrink-0 place-items-center text-muted-foreground",
          region === "right" ? "border-b" : "border-r",
        )}
        title={`Drop a tab into the ${region} dock`}
      >
        <Icon className="size-4" />
      </div>
      {surfaces.map((surface) =>
        regionLaunchers.some(
          (launcher) => launcherSurface(launcher)?.tabKey === surface.tabKey,
        ) ? null : (
          <button
            aria-label={`Focus ${surface.title} in ${region} dock`}
            aria-pressed={surface.tabKey === activeTabKey}
            className={cn(
              "grid size-10 shrink-0 place-items-center border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              region === "right" ? "border-b" : "border-r",
              surface.tabKey === activeTabKey && "bg-muted text-foreground",
            )}
            key={surface.tabKey}
            disabled={pending}
            onClick={() => onSelect(surface)}
            title={surface.title}
            type="button"
          >
            {surface.kind === "builtin" ? (
              <ProjectBuiltInSurfaceIcon
                className="size-4"
                definitionId={surface.entity.definitionId}
              />
            ) : (
              <ProjectSurfaceIcon className="size-4" kind={surface.kind} />
            )}
          </button>
        ),
      )}
      {regionLaunchers.map((launcher) => {
        if (launcher.target.kind !== "definition") return null;
        const definitionId = launcher.target.definitionId;
        const surface = launcherSurface(launcher);
        const builtIn =
          projectBuiltinSurfaceDefinitionIdSchema.safeParse(definitionId);
        const definition = PROJECT_SURFACE_DEFINITIONS.find(
          ({ id }) => id === definitionId,
        );
        return (
          <button
            aria-label={`${surface ? "Focus" : "Open"} ${definition?.label ?? "surface"} in ${region} dock`}
            aria-pressed={surface?.tabKey === activeTabKey}
            className={cn(
              "grid size-10 shrink-0 place-items-center border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              region === "right" ? "border-b" : "border-r",
              surface?.tabKey === activeTabKey && "bg-muted text-foreground",
            )}
            key={launcher.id}
            disabled={pending}
            onClick={() => onOpenLauncher(launcher)}
            title={definition?.label}
            type="button"
          >
            {builtIn.success ? (
              <ProjectBuiltInSurfaceIcon
                className="size-4"
                definitionId={builtIn.data}
              />
            ) : (
              <ProjectSurfaceIcon
                className="size-4"
                kind={
                  definitionId === "project.terminal"
                    ? "terminal"
                    : definitionId === "project.browser"
                      ? "browser"
                      : "remote-desktop"
                }
              />
            )}
          </button>
        );
      })}
    </aside>
  );
}

function genericPaneBody(
  bindings: Readonly<Record<string, any>>,
  presentation: VisibleProjectPane,
  nested = false,
): ReactNode {
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
}: {
  bindings: Readonly<Record<string, any>>;
  docked: boolean;
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
  const rightFraction = rightPreference
    ? effectiveDockFraction(
        temporarySplitFraction(rightPreference, fullRegion === "right"),
        frameSize.width,
        240,
        240,
      )
    : 0.32;
  const bottomFraction = bottomPreference
    ? effectiveDockFraction(
        temporarySplitFraction(bottomPreference, fullRegion === "bottom"),
        frameSize.height,
        180,
        180,
      )
    : 0.32;
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
    portalTarget: panePortalTarget(presentation.pane.id),
  }));
  const remotePresentations = renderedPresentations.filter(
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
  const overviewPresentation = renderedPresentations.find(
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
  const tabStrip = (presentation: VisibleProjectPane, gridArea?: string) => (
    <div
      className="min-w-0 overflow-hidden border-b"
      data-project-pane-id={presentation.pane.id}
      key={`${presentation.pane.id}:tabs`}
      style={gridArea ? { gridArea } : undefined}
    >
      <ProjectPaneTabStrip
        activeTabKey={presentation.activeTabKey}
        allowedCreateKinds={createKindsForPaneRegion(presentation.pane.region)}
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
        projectId={presentation.pane.projectId}
        surfaces={presentation.surfaces}
      />
    </div>
  );
  const focusAndRevealSurface = (surface: ProjectSurface) => {
    const pane = bindings.tabLayout.data?.panes.find(
      ({ id }: { id: string }) => id === surface.paneId,
    );
    const preference =
      surface.member.dockPresentation ?? DEFAULT_DOCK_PRESENTATION;
    if (
      (pane?.region === "right" || pane?.region === "bottom") &&
      preference.preferredMode === "closed"
    ) {
      commitDockPresentation(
        surface.projectId,
        surface.tabKey,
        revealDockPresentation(preference),
      );
    }
    bindings.selectTopTab(surface.tabKey);
  };
  const openRailLauncher = (
    launcher: ProjectSurfaceLauncher,
    region: DockRegion,
  ) => {
    const disposition = railLauncherDisposition(
      launcher,
      bindings.projectSurfaces,
    );
    if (disposition.type === "unavailable") return;
    if (disposition.type === "focus") {
      const surface = bindings.projectSurfaces.find(
        ({ tabKey }: ProjectSurface) => tabKey === disposition.tabKey,
      );
      if (surface) focusAndRevealSurface(surface);
      return;
    }
    const definitionId = disposition.definitionId;
    const builtIn =
      projectBuiltinSurfaceDefinitionIdSchema.safeParse(definitionId);
    if (builtIn.success) {
      void bindings.openOrFocusSurface(
        bindings.selectedProject.id,
        projectBuiltInSurfaceResourceRef(builtIn.data),
        undefined,
        region,
      );
      return;
    }
    const kind = (
      Object.entries(definitionIdByCreateKind) as [
        ProjectSurfaceCreateKind,
        string,
      ][]
    ).find(([, candidateId]) => candidateId === definitionId)?.[0];
    if (kind) {
      bindings.createProjectSurface(
        bindings.selectedProject.id,
        kind,
        undefined,
        undefined,
        region,
      );
    }
  };

  const grid = projectWorkspaceGridModel({
    bottom: bottomRendered,
    bottomFraction,
    center: Boolean(centerRoot && centers.length > 0),
    fullRegion,
    right: rightRendered,
    rightFraction,
  });
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
    if (presentation) bindings.selectTopTab(presentation.activeTabKey);
  };
  const presentationMutationPending = Boolean(
    bindings.dockPresentationMutation.isPending ||
    bindings.tabLayoutMutation.isPending,
  );

  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
      data-docked={docked ? "true" : "false"}
      style={{
        gridTemplateColumns: docked
          ? "minmax(0, 1fr) 2.5rem"
          : "minmax(0, 1fr) 0",
        gridTemplateRows: docked ? "minmax(0, 1fr) 2.5rem" : "minmax(0, 1fr) 0",
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
        {docked &&
        right &&
        renderedPresentations.some(({ pane }) => pane.id === right.pane.id)
          ? tabStrip(right!, "right-tabs")
          : null}
        {docked &&
        bottom &&
        renderedPresentations.some(({ pane }) => pane.id === bottom.pane.id)
          ? tabStrip(bottom!, "bottom-tabs")
          : null}
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
          ? renderedPresentations.flatMap(({ activeSurface }) =>
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
          bindings={
            docked
              ? { ...bindings, dockPanePresentations: renderedPresentations }
              : bindings
          }
          key="persistent-surface-layer"
        />
        {!docked ? <GlobalContentHost bindings={bindings} /> : null}
      </div>
      {docked ? (
        <DockRail
          activeTabKey={right?.activeTabKey ?? null}
          allSurfaces={bindings.projectSurfaces}
          launchers={bindings.surfaceLaunchers.data ?? []}
          onOpenLauncher={(launcher) => openRailLauncher(launcher, "right")}
          onSelect={focusAndRevealSurface}
          pending={presentationMutationPending}
          pane={right?.pane}
          projectId={bindings.selectedProject.id}
          region="right"
          surfaces={right?.surfaces ?? []}
        />
      ) : null}
      {docked ? (
        <DockRail
          activeTabKey={bottom?.activeTabKey ?? null}
          allSurfaces={bindings.projectSurfaces}
          launchers={bindings.surfaceLaunchers.data ?? []}
          onOpenLauncher={(launcher) => openRailLauncher(launcher, "bottom")}
          onSelect={focusAndRevealSurface}
          pending={presentationMutationPending}
          pane={bottom?.pane}
          projectId={bindings.selectedProject.id}
          region="bottom"
          surfaces={bottom?.surfaces ?? []}
        />
      ) : null}
    </div>
  );
}
