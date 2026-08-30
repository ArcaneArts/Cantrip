import type {
  ExplorerSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";

import type { ProjectSurface } from "./project-surface";

export interface SidebarFilePreviewState {
  active: boolean;
  explorerId: string;
  groupId: string | null;
  path: string;
  projectId: string;
}

export const SIDEBAR_EXPLORER_POOL_SIZE = 2;

export function sidebarFilePreviewMatches(
  preview: SidebarFilePreviewState | null,
  target: Omit<SidebarFilePreviewState, "active">,
): boolean {
  return Boolean(
    preview?.active &&
    preview.explorerId === target.explorerId &&
    preview.groupId === target.groupId &&
    preview.path === target.path &&
    preview.projectId === target.projectId,
  );
}

export function sidebarExplorerPrewarmTarget({
  isPopout,
  sidebarExplorer,
}: {
  hasOpenExplorer: boolean;
  pinInProgress: boolean;
  isPopout: boolean;
  sidebarExplorer: ExplorerSummary | null;
}): ExplorerSummary | null {
  return !isPopout ? sidebarExplorer : null;
}

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

export function sidebarFilePreviewViewKey(
  preview: Pick<SidebarFilePreviewState, "explorerId" | "path">,
): string {
  return `sidebar-file-preview:${preview.explorerId}`;
}

export function sidebarFileTargetGroupId({
  activeGroupId,
  explorerId,
  fallbackGroupId,
  preview,
}: {
  activeGroupId: string | null | undefined;
  explorerId: string;
  fallbackGroupId: string | null | undefined;
  preview: SidebarFilePreviewState | null;
}): string | null {
  if (activeGroupId) return activeGroupId;
  if (preview?.explorerId === explorerId && preview.groupId) {
    return preview.groupId;
  }
  return fallbackGroupId ?? null;
}

export function sidebarFilePreviewIsVisible({
  previewActive,
  previewExplorerAvailable,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
}: {
  previewActive: boolean;
  previewExplorerAvailable: boolean;
  showImporter: boolean;
  showProjectSettings: boolean;
  showServerAdmin: boolean;
  showSettings: boolean;
}): boolean {
  return Boolean(
    previewActive &&
    previewExplorerAvailable &&
    !showImporter &&
    !showProjectSettings &&
    !showServerAdmin &&
    !showSettings,
  );
}

export function tabbedExplorerIds(
  layout: ProjectTabLayoutSummary | null | undefined,
  groupIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    layout?.groups.flatMap((group) =>
      groupIds && !groupIds.has(group.id)
        ? []
        : group.members.flatMap((member) =>
            member.tabKind === "explorer" ? [member.tabId] : [],
          ),
    ) ?? [],
  );
}

export function surfaceWorktreeId(surface: ProjectSurface | undefined) {
  if (!surface) return null;
  if (surface.kind === "chat") return surface.entity.activeWorktreeId;
  if (
    surface.kind === "terminal" ||
    surface.kind === "explorer" ||
    surface.kind === "code"
  ) {
    return surface.entity.worktreeId;
  }
  if (surface.kind === "history") return surface.entity.worktreeId;
  return null;
}

export function preferredSidebarExplorer({
  desiredWorktreeId,
  explorers,
  layout,
  previewExplorerId,
}: {
  desiredWorktreeId: string | null;
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
  previewExplorerId?: string | null;
}): ExplorerSummary | null {
  const tabbed = tabbedExplorerIds(layout);
  const preview = previewExplorerId
    ? explorers.find((explorer) => explorer.id === previewExplorerId)
    : undefined;
  if (preview && !tabbed.has(preview.id)) return preview;

  const candidates = desiredWorktreeId
    ? explorers.filter((explorer) => explorer.worktreeId === desiredWorktreeId)
    : [...explorers];
  return candidates.find((explorer) => !tabbed.has(explorer.id)) ?? null;
}

export function sidebarExplorerCanOwnPreview({
  explorerId,
  layout,
  pinInProgress,
  workbenchReady = true,
}: {
  explorerId: string;
  layout: ProjectTabLayoutSummary | null | undefined;
  pinInProgress: boolean;
  workbenchReady?: boolean;
}): boolean {
  return (
    workbenchReady &&
    !pinInProgress &&
    !tabbedExplorerIds(layout).has(explorerId)
  );
}

export function dedicatedSidebarExplorers({
  desiredWorktreeId,
  explorers,
  layout,
}: {
  desiredWorktreeId: string | null;
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
}): ExplorerSummary[] {
  const tabbed = tabbedExplorerIds(layout);
  return explorers
    .filter(
      (explorer) =>
        !tabbed.has(explorer.id) &&
        (!desiredWorktreeId || explorer.worktreeId === desiredWorktreeId),
    )
    .slice(0, SIDEBAR_EXPLORER_POOL_SIZE);
}

export function dedicatedSidebarExplorer({
  desiredWorktreeId,
  explorers,
  layout,
}: {
  desiredWorktreeId: string | null;
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
}): ExplorerSummary | null {
  return (
    dedicatedSidebarExplorers({ desiredWorktreeId, explorers, layout })[0] ??
    null
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
