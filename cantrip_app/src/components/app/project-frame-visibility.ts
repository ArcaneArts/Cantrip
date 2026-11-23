export function projectFrameVisible({
  desktopProjectFrame,
  mobileProjectSelectorOpen,
  showArchivedStandaloneChats,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
}: {
  desktopProjectFrame: boolean;
  mobileProjectSelectorOpen: boolean;
  showArchivedStandaloneChats: boolean;
  showImporter: boolean;
  showProjectSettings: boolean;
  showServerAdmin: boolean;
  showSettings: boolean;
}) {
  // A pane can show its selected tab even when the project has no focused pane.
  return Boolean(
    desktopProjectFrame &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showArchivedStandaloneChats &&
    !showServerAdmin &&
    !showProjectSettings,
  );
}
