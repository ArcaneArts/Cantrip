import type { WorkspaceSelection } from "@/lib/workspace-selection";

export function projectFrameVisibility({
  desktopProjectFrame,
  mobileProjectSelectorOpen,
  showArchivedStandaloneChats,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
  sidebarFilePreviewVisible,
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
  return {
    docked:
      railsVisible &&
      !sidebarFilePreviewVisible &&
      workspaceDestination !== "overview",
    railsVisible,
  } as const;
}
