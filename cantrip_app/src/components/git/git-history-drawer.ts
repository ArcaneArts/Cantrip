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
  return clampResizablePanelWidth(
    width,
    DEFAULT_GIT_HISTORY_DRAWER_WIDTH,
    MIN_GIT_HISTORY_DRAWER_WIDTH,
    MAX_GIT_HISTORY_DRAWER_WIDTH,
  );
}

export function gitHistoryDrawerWidthFromPointer(
  clientX: number,
  drawerRight: number,
): number {
  return resizablePanelWidthFromPointer({
    boundary: drawerRight,
    clientX,
    defaultWidth: DEFAULT_GIT_HISTORY_DRAWER_WIDTH,
    edge: "left",
    maxWidth: MAX_GIT_HISTORY_DRAWER_WIDTH,
    minWidth: MIN_GIT_HISTORY_DRAWER_WIDTH,
  });
}

export function gitHistoryDrawerWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  return resizablePanelWidthFromKey({
    currentWidth,
    defaultWidth: DEFAULT_GIT_HISTORY_DRAWER_WIDTH,
    edge: "left",
    key,
    maxWidth: MAX_GIT_HISTORY_DRAWER_WIDTH,
    minWidth: MIN_GIT_HISTORY_DRAWER_WIDTH,
  });
}
import {
  clampResizablePanelWidth,
  resizablePanelWidthFromKey,
  resizablePanelWidthFromPointer,
} from "@/components/ui/resizable-panel";
