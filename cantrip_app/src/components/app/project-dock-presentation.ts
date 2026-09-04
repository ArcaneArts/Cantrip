import type {
  ProjectDockPresentationPreference,
  ProjectPaneRegion,
} from "@cantrip/protocol";

import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";

export type DockRegion = Extract<ProjectPaneRegion, "right" | "bottom">;

export const DEFAULT_DOCK_PRESENTATION = {
  preferredMode: "split",
  restoreFraction: 0.32,
  splitFraction: 0.32,
} as const satisfies ProjectDockPresentationPreference;

export const DOCK_SNAP_CLOSED_THRESHOLD = 0.06;
export const DOCK_SNAP_FULL_THRESHOLD = 0.94;
export const DOCK_SNAP_CLOSED_RELEASE = 0.1;
export const DOCK_SNAP_FULL_RELEASE = 0.9;

const MIN_DOCK_FRACTION = 0.05;
const MAX_DOCK_FRACTION = 0.95;

export function dockPresentationForPane(
  pane: VisibleProjectPane | undefined,
): ProjectDockPresentationPreference | null {
  if (
    !pane ||
    (pane.pane.region !== "right" && pane.pane.region !== "bottom")
  ) {
    return null;
  }
  return (
    pane.activeSurface?.member.dockPresentation ?? DEFAULT_DOCK_PRESENTATION
  );
}

export function clampSavedDockFraction(fraction: number): number {
  return Math.max(MIN_DOCK_FRACTION, Math.min(MAX_DOCK_FRACTION, fraction));
}

/**
 * Applies device-local minimums without changing the synchronized fraction.
 */
export function effectiveDockFraction(
  savedFraction: number,
  totalPixels: number,
  minimumDockPixels: number,
  minimumOtherPixels: number,
): number {
  if (totalPixels <= 0) return clampSavedDockFraction(savedFraction);
  if (totalPixels <= minimumDockPixels + minimumOtherPixels) {
    return minimumDockPixels / (minimumDockPixels + minimumOtherPixels);
  }
  const minimum = minimumDockPixels / totalPixels;
  const maximum = 1 - minimumOtherPixels / totalPixels;
  return Math.max(minimum, Math.min(maximum, savedFraction));
}

export function restoreDockPresentation(
  preference: ProjectDockPresentationPreference,
): ProjectDockPresentationPreference {
  return {
    preferredMode: "split",
    restoreFraction: preference.restoreFraction,
    splitFraction: preference.restoreFraction,
  };
}

export function revealDockPresentation(
  preference: ProjectDockPresentationPreference,
): ProjectDockPresentationPreference {
  return preference.preferredMode === "closed"
    ? restoreDockPresentation(preference)
    : preference;
}

export function dockPresentationAfterRailTabClick(
  preference: ProjectDockPresentationPreference,
  active: boolean,
): ProjectDockPresentationPreference {
  if (active && preference.preferredMode !== "closed") {
    return { ...preference, preferredMode: "closed" };
  }
  return revealDockPresentation(preference);
}

/**
 * Resolves a drag candidate with asymmetric release thresholds so an edge snap
 * does not oscillate as the pointer moves around the entry threshold.
 */
export function resizeDockPresentation(
  preference: ProjectDockPresentationPreference,
  candidateFraction: number,
): ProjectDockPresentationPreference {
  const candidate = clampSavedDockFraction(candidateFraction);
  let preferredMode: ProjectDockPresentationPreference["preferredMode"];
  if (preference.preferredMode === "closed") {
    preferredMode =
      candidate >= DOCK_SNAP_FULL_THRESHOLD
        ? "full"
        : candidate >= DOCK_SNAP_CLOSED_RELEASE
          ? "split"
          : "closed";
  } else if (preference.preferredMode === "full") {
    preferredMode =
      candidate <= DOCK_SNAP_CLOSED_THRESHOLD
        ? "closed"
        : candidate <= DOCK_SNAP_FULL_RELEASE
          ? "split"
          : "full";
  } else {
    preferredMode =
      candidate <= DOCK_SNAP_CLOSED_THRESHOLD
        ? "closed"
        : candidate >= DOCK_SNAP_FULL_THRESHOLD
          ? "full"
          : "split";
  }
  if (preferredMode !== "split") {
    return { ...preference, preferredMode };
  }
  return {
    preferredMode,
    restoreFraction: candidate,
    splitFraction: candidate,
  };
}

export function dockResizeCandidate({
  currentCoordinate,
  leadingEdge,
  preference,
  startCoordinate,
  trailingEdge,
}: {
  currentCoordinate: number;
  leadingEdge: number;
  preference: ProjectDockPresentationPreference;
  startCoordinate: number;
  trailingEdge: number;
}): number {
  const total = trailingEdge - leadingEdge;
  if (total <= 0) return preference.splitFraction;
  return preference.preferredMode === "split"
    ? (trailingEdge - currentCoordinate) / total
    : preference.restoreFraction -
        (currentCoordinate - startCoordinate) / total;
}

export function dockPresentationForKey(
  direction: "horizontal" | "vertical",
  preference: ProjectDockPresentationPreference,
  key: string,
): ProjectDockPresentationPreference | null {
  if (key === "Enter" || key === " ") {
    return restoreDockPresentation(preference);
  }
  if (key === "Home") {
    return { ...preference, preferredMode: "closed" };
  }
  if (key === "End") {
    return { ...preference, preferredMode: "full" };
  }
  const grow = direction === "vertical" ? "ArrowLeft" : "ArrowUp";
  const shrink = direction === "vertical" ? "ArrowRight" : "ArrowDown";
  if (key === grow) {
    return resizeDockPresentation(preference, preference.splitFraction + 0.05);
  }
  if (key === shrink) {
    return resizeDockPresentation(preference, preference.splitFraction - 0.05);
  }
  return null;
}

/** Only the focused dock may temporarily own the full workspace. */
export function focusedFullDockRegion(
  panes: readonly VisibleProjectPane[],
): DockRegion | null {
  const focused = panes.find(({ focused }) => focused);
  if (
    !focused ||
    (focused.pane.region !== "right" && focused.pane.region !== "bottom")
  ) {
    return null;
  }
  return dockPresentationForPane(focused)?.preferredMode === "full"
    ? focused.pane.region
    : null;
}

export function dockIsRendered(
  preference: ProjectDockPresentationPreference | null,
): boolean {
  return preference?.preferredMode !== "closed";
}

export function temporarySplitFraction(
  preference: ProjectDockPresentationPreference,
  ownsFullWorkspace: boolean,
): number {
  return preference.preferredMode === "full" && !ownsFullWorkspace
    ? preference.restoreFraction
    : preference.splitFraction;
}
