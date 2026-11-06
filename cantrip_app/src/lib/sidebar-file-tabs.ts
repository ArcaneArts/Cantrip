import {
  sameOsFilePlacement,
  surfaceRemoteDesktop,
  type OsFilePlacement,
} from "./os-file-placement";
import type {
  ExplorerSummary,
  ProjectPaneSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  RemoteDesktopSummary,
} from "@cantrip/protocol";

import type { ProjectSurface } from "./project-surface";

export function sidebarFileName(path: string): string {
  return path.split("/").at(-1) || path;
}

export function sidebarPathAtOrBelow(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

export function moveSidebarPath(
  path: string,
  previousRootPath: string,
  nextRootPath: string,
): string {
  return sidebarPathAtOrBelow(path, previousRootPath)
    ? `${nextRootPath}${path.slice(previousRootPath.length)}`
    : path;
}

export function sidebarFileTargetPaneId({
  activePaneId,
  panes,
}: {
  activePaneId: string | null | undefined;
  panes: readonly Pick<ProjectPaneSummary, "id" | "region">[];
}): string | null {
  const centerPaneIds = new Set(
    panes.filter(({ region }) => region === "center").map(({ id }) => id),
  );
  if (activePaneId && centerPaneIds.has(activePaneId)) return activePaneId;
  return panes.find(({ region }) => region === "center")?.id ?? null;
}

export function tabbedExplorerIds(
  layout: ProjectTabLayoutSummary | null | undefined,
  paneIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    layout?.panes.flatMap((pane) =>
      paneIds && !paneIds.has(pane.id)
        ? []
        : pane.members.flatMap((member) =>
            member.tabKind === "explorer" ? [member.tabId] : [],
          ),
    ) ?? [],
  );
}

export function surfaceWorktreeId(
  surface: ProjectSurface | undefined,
  remoteDesktop?: RemoteDesktopSummary,
) {
  if (!surface) return null;
  if (surface.kind === "remote-desktop") {
    const desktop = surfaceRemoteDesktop(surface, remoteDesktop);
    return desktop
      ? (desktop.osSource?.worktreeId ?? surface.entity.worktreeId)
      : null;
  }
  if (surface.kind === "chat") return surface.entity.activeWorktreeId;
  if (
    surface.kind === "terminal" ||
    surface.kind === "explorer" ||
    surface.kind === "file" ||
    surface.kind === "code"
  ) {
    return surface.entity.worktreeId;
  }
  if (surface.kind === "history") return surface.entity.worktreeId;
  if (surface.kind === "graph") return surface.entity.worktreeId;
  if (surface.kind === "issues") return surface.entity.worktreeId;
  if (surface.kind === "prs") return surface.entity.worktreeId;
  if (surface.kind === "actions") return surface.entity.worktreeId;
  return null;
}

export function preferredSidebarExplorer({
  desiredOsPlacement = {},
  desiredWorktreeId,
  explorers,
  layout,
}: {
  desiredWorktreeId: string | null;
  desiredOsPlacement?: OsFilePlacement;
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
}): ExplorerSummary | null {
  const tabbed = tabbedExplorerIds(layout);
  const candidates = desiredWorktreeId
    ? explorers.filter((explorer) => explorer.worktreeId === desiredWorktreeId)
    : [...explorers];
  return (
    candidates.find(
      (explorer) =>
        !tabbed.has(explorer.id) &&
        sameOsFilePlacement(explorer, desiredOsPlacement),
    ) ?? null
  );
}

export function primaryWorktreeId(
  worktrees: readonly ProjectWorktreeSummary[],
): string | null {
  return worktrees.find((worktree) => worktree.isPrimary)?.id ?? null;
}

export function pinnedExplorerForPath({
  explorers,
  layout,
  path,
  worktreeId,
}: {
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
  path: string;
  worktreeId: string;
}): ExplorerSummary | null {
  const tabbed = tabbedExplorerIds(layout);
  return (
    explorers.find(
      (explorer) =>
        tabbed.has(explorer.id) &&
        explorer.worktreeId === worktreeId &&
        explorer.selectedPath === path,
    ) ?? null
  );
}
