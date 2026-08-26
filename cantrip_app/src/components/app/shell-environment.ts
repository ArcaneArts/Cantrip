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
  shouldUseDesktopSidebarDrawer,
  useNarrowViewport,
} from "@/lib/use-compact-layout";

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
  const popoutProjectId =
    popoutTarget?.projectId ??
    projectOverviewPopoutTarget?.projectId ??
    explorerFileTarget?.projectId ??
    null;
  const isPopout =
    popoutTarget !== null ||
    projectOverviewPopoutTarget !== null ||
    explorerFileTarget !== null;
  const narrowViewport = useNarrowViewport();
  const compactLayout = shouldUseCompactLayout(narrowViewport, desktopRuntime);
  const compactShell = compactLayout && !isPopout;
  const desktopSidebarDrawer = shouldUseDesktopSidebarDrawer(
    narrowViewport,
    desktopRuntime,
    isPopout,
  );

  return {
    compactLayout,
    compactShell,
    desktopRuntime,
    desktopSidebarDrawer,
    explorerFileTarget,
    folderRevealLabel,
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
