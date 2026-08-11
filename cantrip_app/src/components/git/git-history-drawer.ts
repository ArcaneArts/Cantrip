export const DEFAULT_GIT_HISTORY_DRAWER_WIDTH = 768;
export const MIN_GIT_HISTORY_DRAWER_WIDTH = 360;
export const MAX_GIT_HISTORY_DRAWER_WIDTH = 1_200;
export const GIT_HISTORY_DRAWER_WIDTH_STORAGE_KEY =
  "cantrip:git-history-drawer-width";

export type GitHistoryToolDrawer =
  "branches" | "changes" | "compare" | "operations" | "repository" | "stashes";

export type GitHistoryDrawer =
  { kind: "commit"; revision: string } | { kind: GitHistoryToolDrawer };

export function toggleGitHistoryToolDrawer(
  current: GitHistoryDrawer | null,
  kind: GitHistoryToolDrawer,
): GitHistoryDrawer | null {
  return current?.kind === kind ? null : { kind };
}

export function clampGitHistoryDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_GIT_HISTORY_DRAWER_WIDTH;
  return Math.min(
    MAX_GIT_HISTORY_DRAWER_WIDTH,
    Math.max(MIN_GIT_HISTORY_DRAWER_WIDTH, Math.round(width)),
  );
}

export function gitHistoryDrawerWidthFromPointer(
  clientX: number,
  drawerRight: number,
): number {
  return clampGitHistoryDrawerWidth(drawerRight - clientX);
}

export function gitHistoryDrawerWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  if (key === "Home") return MIN_GIT_HISTORY_DRAWER_WIDTH;
  if (key === "End") return MAX_GIT_HISTORY_DRAWER_WIDTH;
  if (key === "ArrowLeft") {
    return clampGitHistoryDrawerWidth(currentWidth + 16);
  }
  if (key === "ArrowRight") {
    return clampGitHistoryDrawerWidth(currentWidth - 16);
  }
  return null;
}
