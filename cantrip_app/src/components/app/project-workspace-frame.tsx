import { useDroppable } from "@dnd-kit/core";
import {
  PROJECT_SURFACE_DEFINITIONS,
  projectBuiltinSurfaceDefinitionIdSchema,
  type ProjectSurfaceLauncher,
  type ProjectPaneRegion,
  type ProjectPaneSummary,
} from "@cantrip/protocol";
import { useQueries } from "@tanstack/react-query";
import { PanelBottom, PanelRight } from "lucide-react";
import {
  useMemo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { GlobalContentHost } from "@/components/app/global-content-host";
import { PersistentSurfaceLayer } from "@/components/app/persistent-surface-layer";
import { projectPaneRenderBindings } from "@/components/app/project-pane-render-bindings";
import {
  createKindsForPaneRegion,
  definitionIdByCreateKind,
  dockDividerFractionForKey,
  projectWorkspaceGridModel,
  railLauncherDisposition,
  visibleWorkspacePanes,
  type VisibleProjectPane,
} from "@/components/app/project-workspace-frame-model";
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

type DockRegion = Extract<ProjectPaneRegion, "right" | "bottom">;

function VisibleChatLiveScope({ chatId }: { chatId: string }) {
  useAppLiveScope({ kind: "chat", chatId });
  return null;
}

function DockSeparator({
  direction,
  fraction,
  label,
  onFractionChange,
  onPointerBegin,
  onPointerMove,
  onPointerEnd,
  style,
}: {
  direction: "horizontal" | "vertical";
  fraction: number;
  label: string;
  onFractionChange(fraction: number): void;
  onPointerBegin(event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerEnd(event: PointerEvent<HTMLDivElement>): void;
  style: CSSProperties;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = dockDividerFractionForKey(direction, fraction, event.key);
    if (next === null) return;
    event.preventDefault();
    onFractionChange(next);
  };
  return (
    <div
      aria-label={label}
      aria-orientation={direction}
      aria-valuemax={80}
      aria-valuemin={20}
      aria-valuenow={Math.round(fraction * 100)}
      className={cn(
        "group relative z-30 bg-border outline-none focus-visible:bg-ring",
        direction === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onPointerEnd}
      onPointerCancel={onPointerEnd}
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
  pane,
  projectId,
  region,
  surfaces,
}: {
  activeTabKey: string | null;
  allSurfaces: readonly ProjectSurface[];
  launchers: readonly ProjectSurfaceLauncher[];
  onOpenLauncher(launcher: ProjectSurfaceLauncher): void;
  onSelect(tabKey: string): void;
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
            onClick={() => onSelect(surface.tabKey)}
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

function clampFraction(value: number, total: number, minimum: number): number {
  if (total <= minimum * 2) return 0.5;
  const minimumFraction = minimum / total;
  return Math.max(minimumFraction, Math.min(1 - minimumFraction, value));
}

function genericPaneBody(
  bindings: Readonly<Record<string, any>>,
  presentation: VisibleProjectPane,
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
        className="grid min-h-0 min-w-0 place-items-center text-sm text-muted-foreground"
        data-project-pane-id={presentation.pane.id}
        style={{ gridArea: presentation.gridArea }}
      >
        Loading pane…
      </div>
    );
  }
  return (
    <div
      className="flex min-h-0 min-w-0 flex-col overflow-hidden"
      data-project-pane-body={presentation.pane.id}
      data-project-pane-id={presentation.pane.id}
      key={presentation.pane.id}
      style={{ gridArea: presentation.gridArea }}
    >
      <GlobalContentHost
        bindings={projectPaneRenderBindings(bindings, presentation)}
      />
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
    pointerId: number;
    separator: DockRegion;
  } | null>(null);
  const resizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);
  const [rightFraction, setRightFraction] = useState(0.68);
  const [bottomFraction, setBottomFraction] = useState(0.68);
  const [visiblePaneIdByRegion, setVisiblePaneIdByRegion] = useState<
    Partial<Record<ProjectPaneRegion, string>>
  >({});
  const focusedPane: ProjectPaneSummary | undefined =
    bindings.tabLayout.data?.panes.find(
      ({ id }: { id: string }) =>
        id === bindings.workspaceSelection.focusedPaneId,
    );
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
        focusedPaneId: bindings.workspaceSelection.focusedPaneId,
        panes: bindings.tabLayout.data?.panes ?? [],
        surfaceByPaneId: bindings.projectSurfaceIndex.byPaneId,
        visiblePaneIdByRegion,
      }),
    [
      bindings.projectSurfaceIndex,
      bindings.tabLayout.data?.panes,
      bindings.workspaceSelection.activeTabByPane,
      bindings.workspaceSelection.focusedPaneId,
      visiblePaneIdByRegion,
    ],
  );
  const center = presentations.find(({ pane }) => pane.region === "center");
  const right = presentations.find(({ pane }) => pane.region === "right");
  const bottom = presentations.find(({ pane }) => pane.region === "bottom");
  const remotePresentations = presentations.filter(
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
  const overviewPresentation = presentations.find(
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
  const setClampedRightFraction = (value: number) =>
    setRightFraction(
      clampFraction(value, frameRef.current?.clientWidth ?? 0, 240),
    );
  const setClampedBottomFraction = (value: number) =>
    setBottomFraction(
      clampFraction(value, frameRef.current?.clientHeight ?? 0, 180),
    );
  const beginResize =
    (separator: DockRegion) => (event: PointerEvent<HTMLDivElement>) => {
      resizePointerRef.current = { pointerId: event.pointerId, separator };
      resizeBodyStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor =
        separator === "right" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizePointerRef.current;
    const frame = frameRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !frame) return;
    const bounds = frame.getBoundingClientRect();
    if (resize.separator === "right") {
      setClampedRightFraction((event.clientX - bounds.left) / bounds.width);
    } else {
      setClampedBottomFraction((event.clientY - bounds.top) / bounds.height);
    }
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizePointerRef.current?.pointerId !== event.pointerId) return;
    resizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const previous = resizeBodyStyleRef.current;
    resizeBodyStyleRef.current = null;
    if (previous) {
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    }
  };
  useEffect(
    () => () => {
      const previous = resizeBodyStyleRef.current;
      if (!previous) return;
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    },
    [],
  );
  const tabStrip = (presentation: VisibleProjectPane, gridArea: string) => (
    <div
      className="min-w-0 overflow-hidden border-b"
      data-project-pane-id={presentation.pane.id}
      key={`${presentation.pane.id}:tabs`}
      style={{ gridArea }}
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
      bindings.selectTopTab(disposition.tabKey);
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
    bottom: Boolean(bottom),
    bottomFraction,
    center: Boolean(center),
    right: Boolean(right),
    rightFraction,
  });
  const focusPaneFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const paneId = target.closest<HTMLElement>("[data-project-pane-id]")
      ?.dataset.projectPaneId;
    if (!paneId || paneId === bindings.workspaceSelection.focusedPaneId) return;
    const presentation = presentations.find(({ pane }) => pane.id === paneId);
    if (presentation) bindings.selectTopTab(presentation.activeTabKey);
  };

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
          "min-h-0 min-w-0 overflow-hidden",
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
        {docked && center ? tabStrip(center, "center-tabs") : null}
        {docked && right ? tabStrip(right, "right-tabs") : null}
        {docked && bottom ? tabStrip(bottom, "bottom-tabs") : null}
        {docked && grid.showRightDivider ? (
          <DockSeparator
            direction="vertical"
            fraction={rightFraction}
            label="Right dock divider position"
            onFractionChange={setClampedRightFraction}
            onPointerBegin={beginResize("right")}
            onPointerEnd={endResize}
            onPointerMove={moveResize}
            style={{ gridArea: "right-divider" }}
          />
        ) : null}
        {docked && grid.showBottomDivider ? (
          <DockSeparator
            direction="horizontal"
            fraction={bottomFraction}
            label="Bottom dock divider position"
            onFractionChange={setClampedBottomFraction}
            onPointerBegin={beginResize("bottom")}
            onPointerEnd={endResize}
            onPointerMove={moveResize}
            style={{ gridArea: "bottom-divider" }}
          />
        ) : null}
        {docked
          ? presentations.map((presentation) =>
              genericPaneBody(
                bindingsForPresentation(presentation),
                presentation,
              ),
            )
          : null}
        {docked
          ? presentations.flatMap(({ activeSurface }) =>
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
              ? { ...bindings, dockPanePresentations: presentations }
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
          onSelect={bindings.selectTopTab}
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
          onSelect={bindings.selectTopTab}
          pane={bottom?.pane}
          projectId={bindings.selectedProject.id}
          region="bottom"
          surfaces={bottom?.surfaces ?? []}
        />
      ) : null}
    </div>
  );
}
