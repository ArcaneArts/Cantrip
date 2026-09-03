import { useMemo } from "react";
import {
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  parseDesktopProjectOverviewTarget,
  isDesktopRuntime,
  shouldUseOverlayTitlebar,
} from "@/lib/desktop-popout";
import {
  desktopFolderRevealLabel,
  desktopProjectRevealButtonLabel,
  desktopProjectRevealLabel,
} from "@/lib/desktop-project-share";
import {
  shouldUseCompactLayout,
  shouldUseSidebarDrawer,
  useNarrowViewport,
} from "@/lib/use-compact-layout";
import { parseGitHistoryRoute } from "@/lib/git-history-navigation";

export function useShellEnvironment() {
  const desktopRuntime = useMemo(() => isDesktopRuntime(), []);
  const projectRevealLabel = useMemo(
    () => desktopProjectRevealLabel(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const projectRevealButtonLabel = useMemo(
    () => desktopProjectRevealButtonLabel(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const folderRevealLabel = useMemo(
    () => desktopFolderRevealLabel(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const overlayTitlebar = useMemo(
    () => shouldUseOverlayTitlebar(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const popoutTarget = useMemo(
    () =>
      desktopRuntime
        ? parseDesktopPopoutGroupTarget(window.location.search)
        : null,
    [desktopRuntime],
  );
  const projectOverviewPopoutTarget = useMemo(
    () =>
      desktopRuntime
        ? parseDesktopProjectOverviewTarget(window.location.search)
        : null,
    [desktopRuntime],
  );
  const explorerFileTarget = useMemo(
    () =>
      desktopRuntime
        ? parseDesktopExplorerFileTarget(window.location.search)
        : null,
    [desktopRuntime],
  );
  const gitHistoryTarget = useMemo(
    () => parseGitHistoryRoute(window.location.search),
    [],
  );
  const hasGitHistoryTarget = Boolean(
    gitHistoryTarget.projectId && gitHistoryTarget.worktreeId,
  );
  const popoutProjectId =
    popoutTarget?.projectId ??
    projectOverviewPopoutTarget?.projectId ??
    explorerFileTarget?.projectId ??
    (hasGitHistoryTarget ? gitHistoryTarget.projectId : null) ??
    null;
  const isPopout =
    popoutTarget !== null ||
    projectOverviewPopoutTarget !== null ||
    explorerFileTarget !== null;
  const narrowViewport = useNarrowViewport();
  const compactLayout = shouldUseCompactLayout(narrowViewport, desktopRuntime);
  const compactShell = compactLayout && !isPopout;
  const sidebarDrawer = shouldUseSidebarDrawer(narrowViewport, isPopout);

  return {
    compactLayout,
    compactShell,
    desktopRuntime,
    desktopSidebarDrawer: sidebarDrawer,
    explorerFileTarget,
    folderRevealLabel,
    gitHistoryTarget: hasGitHistoryTarget ? gitHistoryTarget : null,
    isPopout,
    narrowViewport,
    overlayTitlebar,
    popoutProjectId,
    popoutTarget,
    projectOverviewPopoutTarget,
    projectRevealButtonLabel,
    projectRevealLabel,
    showContentTitlebar: !isPopout || desktopRuntime,
  } as const;
}

export type ShellEnvironment = ReturnType<typeof useShellEnvironment>;
