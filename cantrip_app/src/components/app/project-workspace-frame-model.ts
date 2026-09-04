import {
  PROJECT_SURFACE_DEFINITIONS,
  type ProjectPaneRegion,
  type ProjectPaneSummary,
  type ProjectSurfaceLauncher,
} from "@cantrip/protocol";

import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import type { ProjectSurface } from "@/lib/project-surface";

export interface VisibleProjectPane {
  activeSurface: ProjectSurface | undefined;
  activeTabKey: string;
  focused: boolean;
  gridArea: "center-body" | "right-body" | "bottom-body";
  pane: ProjectPaneSummary;
  surfaces: readonly ProjectSurface[];
}

export const definitionIdByCreateKind = {
  browser: "project.browser",
  chat: "project.agent",
  code: "project.code",
  explorer: "project.explorer",
  "remote-desktop": "project.remote-desktop",
  terminal: "project.terminal",
} as const satisfies Record<ProjectSurfaceCreateKind, string>;

export function dockDividerFractionForKey(
  direction: "horizontal" | "vertical",
  fraction: number,
  key: string,
): number | null {
  if (key === "Home") return 0.2;
  if (key === "End") return 0.8;
  const previous = direction === "vertical" ? "ArrowLeft" : "ArrowUp";
  const next = direction === "vertical" ? "ArrowRight" : "ArrowDown";
  if (key === previous) return fraction - 0.05;
  if (key === next) return fraction + 0.05;
  return null;
}

export function projectWorkspaceGridModel({
  bottom,
  bottomFraction,
  center,
  right,
  rightFraction,
}: {
  bottom: boolean;
  bottomFraction: number;
  center: boolean;
  right: boolean;
  rightFraction: number;
}) {
  const hasUpper = center || right;
  const splitUpper = center && right;
  return {
    gridTemplateAreas: splitUpper
      ? '"center-tabs right-divider right-tabs" "center-body right-divider right-body" "bottom-divider bottom-divider bottom-divider" "bottom-tabs bottom-tabs bottom-tabs" "bottom-body bottom-body bottom-body"'
      : center
        ? '"center-tabs" "center-body" "bottom-divider" "bottom-tabs" "bottom-body"'
        : right
          ? '"right-tabs" "right-body" "bottom-divider" "bottom-tabs" "bottom-body"'
          : '"empty-upper-tabs" "empty-upper-body" "bottom-divider" "bottom-tabs" "bottom-body"',
    gridTemplateColumns: splitUpper
      ? `${rightFraction * 100}% 6px minmax(0, 1fr)`
      : "minmax(0, 1fr)",
    gridTemplateRows:
      hasUpper && bottom
        ? `40px minmax(0, ${bottomFraction}fr) 6px 40px minmax(0, ${1 - bottomFraction}fr)`
        : hasUpper
          ? "40px minmax(0, 1fr) 0 0 0"
          : bottom
            ? "0 0 0 40px minmax(0, 1fr)"
            : "0 minmax(0, 1fr) 0 0 0",
    hasUpper,
    showBottomDivider: hasUpper && bottom,
    showRightDivider: splitUpper,
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
  focusedPaneId,
  panes,
  surfaceByPaneId,
  visiblePaneIdByRegion = {},
}: {
  activeTabByPane: Readonly<Record<string, string>>;
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
  const centerPane =
    (focusedPane?.region === "center" ? focusedPane : undefined) ??
    rememberedPane("center") ??
    panes.find(({ region }) => region === "center");
  const rightPane =
    (focusedPane?.region === "right" ? focusedPane : undefined) ??
    rememberedPane("right") ??
    panes.find(({ region }) => region === "right");
  const bottomPane =
    (focusedPane?.region === "bottom" ? focusedPane : undefined) ??
    rememberedPane("bottom") ??
    panes.find(({ region }) => region === "bottom");
  return [
    centerPane
      ? ({ pane: centerPane, gridArea: "center-body" } as const)
      : null,
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
