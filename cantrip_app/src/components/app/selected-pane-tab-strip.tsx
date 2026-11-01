import { ProjectPaneTabStrip } from "@/components/workspace/project-tab-bar";

type Bindings = Readonly<Record<string, any>>;

export function selectedPaneTabStripVisible(bindings: Bindings): boolean {
  return Boolean(
    !bindings.dockPanePresentations &&
    bindings.appMode === "ide" &&
    !bindings.compactShell &&
    !bindings.showImporter &&
    !bindings.showSettings &&
    !bindings.showProjectOverview &&
    !bindings.showArchivedStandaloneChats &&
    !bindings.showServerAdmin &&
    !bindings.showProjectSettings &&
    !bindings.selectedPaneOwnedElsewhere &&
    bindings.selectedProject,
  );
}

export function SelectedPaneTabStrip({
  bindings,
  titlebar = false,
}: {
  bindings: Bindings;
  titlebar?: boolean;
}) {
  const surfaces = bindings.selectedPaneSurfaces ?? [];
  return (
    <ProjectPaneTabStrip
      titlebar={titlebar}
      activeTabKey={bindings.selectedTabKey ?? ""}
      creatingKinds={bindings.creatingSurfaceKinds}
      surfaces={surfaces}
      onCreate={(kind, target) => {
        const paneId = bindings.selectedPane?.id ?? surfaces.at(-1)?.paneId;
        bindings.createProjectSurface(
          bindings.selectedProject.id,
          kind,
          paneId,
          target,
          paneId ? undefined : "center",
        );
      }}
      onClose={bindings.closeSurfaceView}
      onKeepOpen={bindings.keepSurfaceOpen}
      onDelete={bindings.deleteSurfaceResource}
      onRename={bindings.renameSurface}
      onSelect={bindings.selectTopTab}
      paneId={bindings.selectedPane?.id}
      paneRegion={bindings.selectedPane?.region}
      placement={bindings.selectedPlacementContext}
      projectId={bindings.selectedProject.id}
    />
  );
}
