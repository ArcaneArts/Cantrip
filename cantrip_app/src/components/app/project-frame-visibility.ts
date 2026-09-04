import type { WorkspaceSelection } from "@/lib/workspace-selection";

export function projectFrameVisibility({
  desktopProjectFrame,
  mobileProjectSelectorOpen,
  showArchivedStandaloneChats,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
  sidebarFilePreviewVisible: _sidebarFilePreviewVisible,
  workspaceDestination,
}: {
  desktopProjectFrame: boolean;
  mobileProjectSelectorOpen: boolean;
  showArchivedStandaloneChats: boolean;
  showImporter: boolean;
  showProjectSettings: boolean;
  showServerAdmin: boolean;
  showSettings: boolean;
  sidebarFilePreviewVisible: boolean;
  workspaceDestination: WorkspaceSelection["destination"];
}) {
  const railsVisible = Boolean(
    desktopProjectFrame &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showArchivedStandaloneChats &&
    !showServerAdmin &&
    !showProjectSettings,
  );
  // A transient file preview owns its target pane instead of switching the
  // whole frame back to the legacy single-surface host.
  return {
    docked: railsVisible && workspaceDestination !== "overview",
    railsVisible,
  } as const;
}
