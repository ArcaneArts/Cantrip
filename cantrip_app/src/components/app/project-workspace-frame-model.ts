import {
  PROJECT_SURFACE_DEFINITIONS,
  type ProjectPaneRegion,
  type ProjectPaneSummary,
  type ProjectSurfaceLauncher,
} from "@cantrip/protocol";

import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import {
  centerLayoutPaneIds,
  resolvedCenterLayoutRoot,
  type CenterLayoutNode,
} from "@/components/app/center-split-layout";
import type { ProjectSurface } from "@/lib/project-surface";
import type { SidebarFilePreviewState } from "@/lib/sidebar-file-tabs";
import { effectiveDockFraction } from "./project-dock-presentation";

export interface VisibleProjectPane {
  activeSurface: ProjectSurface | undefined;
  activeTabKey: string;
  focused: boolean;
  gridArea: "center-body" | "right-body" | "bottom-body";
  pane: ProjectPaneSummary;
  portalTarget?: Element | null;
  surfaces: readonly ProjectSurface[];
}

export function partitionVisibleWorkspacePanes(
  presentations: readonly VisibleProjectPane[],
  paneOwnedElsewhere: (paneId: string) => boolean,
) {
  return {
    detached: presentations.filter(({ pane }) => paneOwnedElsewhere(pane.id)),
    live: presentations.filter(({ pane }) => !paneOwnedElsewhere(pane.id)),
  } as const;
}

export function legacyTopStripPresentation(
  presentations: readonly VisibleProjectPane[],
): VisibleProjectPane | undefined {
  return (
    presentations.find(
      ({ focused, pane }) => focused && pane.region === "center",
    ) ?? presentations.find(({ pane }) => pane.region === "center")
  );
}

export function legacyTopStripShowsSidebarPreview(
  presentation: VisibleProjectPane | undefined,
  preview: SidebarFilePreviewState | null,
): boolean {
  return Boolean(
    presentation &&
    preview &&
    (preview.active ||
      (preview.paneId !== null && preview.paneId === presentation.pane.id)),
  );
}

export const definitionIdByCreateKind = {
  browser: "project.browser",
  chat: "project.agent",
  code: "project.code",
  explorer: "project.explorer",
  "remote-desktop": "project.remote-desktop",
  terminal: "project.terminal",
} as const satisfies Record<ProjectSurfaceCreateKind, string>;

export function projectWorkspaceGridModel({
  bottom,
  bottomFraction,
  center,
  fullRegion = null,
  right,
  rightFraction,
}: {
  bottom: boolean;
  bottomFraction: number;
  center: boolean;
  fullRegion?: "right" | "bottom" | null;
  right: boolean;
  rightFraction: number;
}) {
  if (fullRegion) {
    return {
      gridTemplateAreas:
        fullRegion === "right" ? '"right-body"' : '"bottom-body"',
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "minmax(0, 1fr)",
      hasUpper: fullRegion === "right",
      showBottomDivider: false,
      showRightDivider: false,
      visibleRegions: [fullRegion],
    } as const;
  }
  const hasUpper = center || right;
  const splitUpper = center && right;
  return {
    gridTemplateAreas: splitUpper
      ? '"center-root right-divider right-body" "bottom-divider bottom-divider bottom-divider" "bottom-body bottom-body bottom-body"'
      : center
        ? '"center-root" "bottom-divider" "bottom-body"'
        : right
          ? '"right-body" "bottom-divider" "bottom-body"'
          : '"empty-upper-body" "bottom-divider" "bottom-body"',
    gridTemplateColumns: splitUpper
      ? `minmax(0, calc(${(1 - rightFraction) * 100}% - 3px)) 6px minmax(0, calc(${rightFraction * 100}% - 3px))`
      : "minmax(0, 1fr)",
    gridTemplateRows:
      hasUpper && bottom
        ? `minmax(0, calc(${(1 - bottomFraction) * 100}% - 3px)) 6px minmax(0, calc(${bottomFraction * 100}% - 3px))`
        : hasUpper
          ? "minmax(0, 1fr) 0 0"
          : bottom
            ? "0 0 minmax(0, 1fr)"
            : "0 minmax(0, 1fr) 0",
    hasUpper,
    showBottomDivider: hasUpper && bottom,
    showRightDivider: splitUpper,
    visibleRegions: [
      ...(center ? (["center"] as const) : []),
      ...(right ? (["right"] as const) : []),
      ...(bottom ? (["bottom"] as const) : []),
    ],
  } as const;
}

export function responsiveProjectWorkspaceGridModel({
  bottom,
  center,
  frameHeight,
  frameWidth,
  fullRegion = null,
  right,
  savedBottomFraction,
  savedRightFraction,
}: {
  bottom: boolean;
  center: boolean;
  frameHeight: number;
  frameWidth: number;
  fullRegion?: "right" | "bottom" | null;
  right: boolean;
  savedBottomFraction: number;
  savedRightFraction: number;
}) {
  const rightFraction = effectiveDockFraction(
    savedRightFraction,
    frameWidth,
    240,
    240,
  );
  const bottomFraction = effectiveDockFraction(
    savedBottomFraction,
    frameHeight,
    180,
    180,
  );
  return {
    bottomFraction,
    grid: projectWorkspaceGridModel({
      bottom,
      bottomFraction,
      center,
      fullRegion,
      right,
      rightFraction,
    }),
    rightFraction,
  } as const;
}

export function railLauncherDisposition(
  launcher: ProjectSurfaceLauncher,
  surfaces: readonly ProjectSurface[],
):
  | { type: "focus"; tabKey: string }
  | { type: "open"; definitionId: string }
  | { type: "unavailable" } {
  if (launcher.target.kind !== "definition") return { type: "unavailable" };
  const definitionId = launcher.target.definitionId;
  const existing = surfaces.find(
    ({ definition }) => definition.id === definitionId,
  );
  return existing
    ? { type: "focus", tabKey: existing.tabKey }
    : { type: "open", definitionId };
}

export function createKindsForPaneRegion(
  region: ProjectPaneRegion,
): ReadonlySet<ProjectSurfaceCreateKind> {
  return new Set(
    (
      Object.keys(definitionIdByCreateKind) as ProjectSurfaceCreateKind[]
    ).filter(
      (kind) =>
        PROJECT_SURFACE_DEFINITIONS.find(
          ({ id }) => id === definitionIdByCreateKind[kind],
        )?.supportedPlacements.includes(region) ?? false,
    ),
  );
}

export function visibleWorkspacePanes({
  activeTabByPane,
  centerRoot,
  focusedPaneId,
  panes,
  surfaceByPaneId,
  visiblePaneIdByRegion = {},
}: {
  activeTabByPane: Readonly<Record<string, string>>;
  centerRoot?: CenterLayoutNode | null;
  focusedPaneId: string | null;
  panes: readonly ProjectPaneSummary[];
  surfaceByPaneId: ReadonlyMap<string, readonly ProjectSurface[]>;
  visiblePaneIdByRegion?: Readonly<Partial<Record<ProjectPaneRegion, string>>>;
}): VisibleProjectPane[] {
  const focusedPane = panes.find(({ id }) => id === focusedPaneId);
  const rememberedPane = (region: ProjectPaneRegion) =>
    panes.find(
      ({ id, region: candidateRegion }) =>
        candidateRegion === region && id === visiblePaneIdByRegion[region],
    );
  const centerPanes = panes.filter(({ region }) => region === "center");
  const resolvedCenterRoot = resolvedCenterLayoutRoot({
    centerPaneIds: centerPanes.map(({ id }) => id),
    preferredPaneId:
      (focusedPane?.region === "center" ? focusedPane.id : undefined) ??
      rememberedPane("center")?.id,
    root: centerRoot,
  });
  const centerPaneIds = centerLayoutPaneIds(resolvedCenterRoot);
  const rightPane =
    (focusedPane?.region === "right" ? focusedPane : undefined) ??
    rememberedPane("right") ??
    panes.find(({ region }) => region === "right");
  const bottomPane =
    (focusedPane?.region === "bottom" ? focusedPane : undefined) ??
    rememberedPane("bottom") ??
    panes.find(({ region }) => region === "bottom");
  return [
    ...centerPaneIds.flatMap((paneId) => {
      const pane = centerPanes.find(({ id }) => id === paneId);
      return pane ? [{ pane, gridArea: "center-body" } as const] : [];
    }),
    rightPane ? ({ pane: rightPane, gridArea: "right-body" } as const) : null,
    bottomPane
      ? ({ pane: bottomPane, gridArea: "bottom-body" } as const)
      : null,
  ].flatMap((entry) => {
    if (!entry) return [];
    const surfaces = surfaceByPaneId.get(entry.pane.id) ?? [];
    const remembered = activeTabByPane[entry.pane.id];
    const activeTabKey = surfaces.some(({ tabKey }) => tabKey === remembered)
      ? remembered!
      : entry.pane.anchorTabKey;
    return [
      {
        ...entry,
        activeSurface: surfaces.find(({ tabKey }) => tabKey === activeTabKey),
        activeTabKey,
        focused: entry.pane.id === focusedPaneId,
        surfaces,
      },
    ];
  });
}
