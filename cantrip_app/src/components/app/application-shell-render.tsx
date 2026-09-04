import { DEFAULT_ELITE_REVEAL_CONFIG } from "@cantrip/glitch";
import { useCallback, useEffect, useState } from "react";
import { RunConfigurationControl } from "@/components/run/run-configuration-control";
import { ExplorerFilePopout } from "@/components/explorer/explorer-file-popout";
import { type ContentHeaderActionsProps } from "@/components/workspace/content-header-actions";
import { WorkspaceDndProvider } from "@/components/workspace/workspace-dnd-provider";
import { EliteGlobalEffects } from "@/components/elite/elite-global-effects";
import { AppToast } from "@/components/ui/app-toast";
import { errorMessage as errorText } from "@/lib/error-message";
import { projectSurfaceTabKey } from "@/lib/project-surface";
import { GlobalContentHost } from "@/components/app/global-content-host";
import { PersistentSurfaceLayer } from "@/components/app/persistent-surface-layer";
import { ProjectWorkspaceFrame } from "@/components/app/project-workspace-frame";
import { projectFrameVisibility } from "@/components/app/project-frame-visibility";
import { ShellHeader } from "@/components/app/shell-header";
import { ShellOverlays } from "@/components/app/shell-overlays";
import { ShellSidebar } from "@/components/app/shell-sidebar";
import type { useTabLayoutOperations } from "@/components/app/tab-layout-operations";

type ApplicationShellRenderBindings = Readonly<Record<string, any>> & {
  tabLayoutMutation: ReturnType<
    typeof useTabLayoutOperations
  >["tabLayoutMutation"];
};

function ShellContent({
  bindings,
}: {
  bindings: ApplicationShellRenderBindings;
}) {
  const {
    appMode,
    compactShell,
    contentRootRef,
    isPopout,
    mobileProjectSelectorOpen,
    selectedProject,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    sidebarFilePreviewVisible,
    tabLayout,
    workspaceSelection,
  } = bindings;
  const desktopProjectFrame = Boolean(
    appMode === "ide" &&
    !compactShell &&
    !isPopout &&
    selectedProject &&
    tabLayout.data,
  );
  const { docked, railsVisible } = projectFrameVisibility({
    desktopProjectFrame,
    mobileProjectSelectorOpen,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    sidebarFilePreviewVisible,
    workspaceDestination: workspaceSelection.destination,
  });
  return (
    <section
      ref={contentRootRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <ShellHeader bindings={bindings} />
      {desktopProjectFrame ? (
        <ProjectWorkspaceFrame
          bindings={bindings}
          docked={docked}
          railsVisible={railsVisible}
        />
      ) : (
        <>
          <PersistentSurfaceLayer bindings={bindings} />
          <GlobalContentHost bindings={bindings} />
        </>
      )}
    </section>
  );
}

export function ApplicationShellRender({
  bindings,
}: {
  bindings: ApplicationShellRenderBindings;
}) {
  const {
    activeChat,
    activeExplorerHeader,
    activePopout,
    activeProjectOverviewPopout,
    activeProjectTaskChat,
    activeProjectTaskView,
    activeRelocation,
    agentInspectOpenChats,
    appMode,
    appToast,
    bootstrap,
    chatRelocationOpen,
    codeAppearance,
    codeHeader,
    compactShell,
    currentRelocation,
    desktopSidebarDrawer,
    desktopSidebarDrawerOpen,
    explorerFileTarget,
    explorers,
    gitHistoryHeader,
    gitHistoryProject,
    selectedPaneOwnedElsewhere,
    handleWorkspaceDrop,
    isPopout,
    linkedConsoleChat,
    mobileProjectSelectorOpen,
    openChatConsole,
    overlayTitlebar,
    popOutActiveView,
    popOutProjectOverviewView,
    popoutError,
    popoutPending,
    projectSettingsSection,
    revealWorkspace,
    runConfigurationEditorId,
    runConfigurationRuntimes,
    runConfigurations,
    selectedCodeTab,
    selectedExplorer,
    selectedPlacementContext,
    selectedProject,
    selectedStandaloneTerminal,
    selectedTerminal,
    setActiveProjectTaskView,
    setAgentInspectOpen,
    setAppToast,
    setChatConsoleOpen,
    setChatRelocationOpen,
    setPendingSurfaceSelection,
    setRunConfigurationEditorId,
    setShowCustomizations,
    setTerminalServiceTerminalId,
    setWorkspaceDragError,
    settings,
    settingsSection,
    showImporter,
    showChatConsole,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    sidebarCollapsed,
    surfaceCreationFailure,
    tabLayout,
    terminalServiceTerminalId,
    visibleProjects,
    workers,
    workspaceDragError,
    worktrees,
  } = bindings;
  const mobileSettingsDestination = showSettings
    ? "global"
    : showProjectSettings && selectedProject
      ? `project:${selectedProject.id}`
      : null;
  const mobileSettingsInitiallyOpen = showSettings
    ? settingsSection !== "general"
    : showProjectSettings
      ? projectSettingsSection !== "general"
      : false;
  const [mobileSettingsNavigation, setMobileSettingsNavigation] = useState<{
    destination: string | null;
    sectionOpen: boolean;
  }>(() => ({
    destination: mobileSettingsDestination,
    sectionOpen: mobileSettingsInitiallyOpen,
  }));
  const mobileSettingsSectionOpen =
    mobileSettingsDestination !== null &&
    mobileSettingsNavigation.destination === mobileSettingsDestination
      ? mobileSettingsNavigation.sectionOpen
      : mobileSettingsInitiallyOpen;
  const setMobileSettingsSectionOpen = useCallback(
    (sectionOpen: boolean) => {
      if (!mobileSettingsDestination) return;
      setMobileSettingsNavigation({
        destination: mobileSettingsDestination,
        sectionOpen,
      });
    },
    [mobileSettingsDestination],
  );
  useEffect(() => {
    if (mobileSettingsDestination !== null) return;
    setMobileSettingsNavigation((current) =>
      current.destination === null
        ? current
        : { destination: null, sectionOpen: false },
    );
  }, [mobileSettingsDestination]);
  const contentHeaderActions = {
    git:
      gitHistoryProject &&
      (gitHistoryHeader?.section === "history" ||
        gitHistoryHeader?.section === "graph")
        ? gitHistoryHeader
        : null,
    explorer: selectedExplorer ? activeExplorerHeader : null,
    code: selectedCodeTab ? { header: codeHeader } : null,
    terminalService:
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings &&
      selectedStandaloneTerminal &&
      selectedStandaloneTerminal.kind !== "run-configuration"
        ? {
            active: terminalServiceTerminalId === selectedStandaloneTerminal.id,
            open: () =>
              setTerminalServiceTerminalId((current: string | null) =>
                current === selectedStandaloneTerminal.id
                  ? null
                  : selectedStandaloneTerminal.id,
              ),
          }
        : null,
    popout: activeProjectOverviewPopout
      ? {
          error: popoutError,
          pending: popoutPending,
          open: popOutProjectOverviewView,
        }
      : activePopout
        ? {
            error: popoutError,
            pending: popoutPending,
            open: popOutActiveView,
          }
        : null,
    task: activeProjectTaskChat
      ? {
          change: setActiveProjectTaskView,
          view: activeProjectTaskView,
        }
      : null,
    chat:
      appMode === "ide" &&
      activeChat &&
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings
        ? {
            consoleActive: Boolean(linkedConsoleChat),
            consolePending: openChatConsole.isPending,
            inspectActive: agentInspectOpenChats.has(activeChat.id),
            inspectCustomizations: () => setShowCustomizations(true),
            relocation: {
              active: Boolean(activeRelocation),
              available: Boolean(
                selectedProject?.capabilities.relocation &&
                bootstrap.data?.capabilities.workerSwitching &&
                selectedPlacementContext &&
                (selectedPlacementContext.workers.length > 1 ||
                  currentRelocation),
              ),
              open: chatRelocationOpen,
              problem: Boolean(
                currentRelocation &&
                (currentRelocation.state === "blocked" ||
                  currentRelocation.state === "failed"),
              ),
              show: () => setChatRelocationOpen(true),
            },
            toggleConsole: () =>
              linkedConsoleChat
                ? setChatConsoleOpen(activeChat.id, false)
                : showChatConsole(activeChat),
            toggleInspect: () =>
              setAgentInspectOpen(
                activeChat.id,
                !agentInspectOpenChats.has(activeChat.id),
              ),
          }
        : null,
  } satisfies Omit<ContentHeaderActionsProps, "compact">;
  const codeSurfaceVisible = Boolean(
    appMode === "ide" &&
    selectedCodeTab &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !selectedPaneOwnedElsewhere,
  );
  const explorerSurfaceVisible = Boolean(
    appMode === "ide" &&
    selectedExplorer &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !selectedPaneOwnedElsewhere,
  );
  const terminalSurfaceVisible = Boolean(
    appMode === "ide" &&
    selectedTerminal &&
    selectedTerminal.kind !== "run-configuration" &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !selectedPaneOwnedElsewhere,
  );
  if (explorerFileTarget) {
    const explorer =
      explorers.data?.find(
        ({ id }: { id: string }) => id === explorerFileTarget.explorerId,
      ) ?? null;
    const explorerError = explorers.isError
      ? errorText(explorers.error)
      : explorers.isSuccess && !explorer
        ? "This Explorer is no longer available."
        : null;
    return (
      <ExplorerFilePopout
        appearance={codeAppearance}
        error={explorerError}
        explorer={explorer}
        loading={explorers.isLoading}
        overlayTitlebar={overlayTitlebar}
        path={explorerFileTarget.path}
        projectTitle={
          selectedProject?.github?.nameWithOwner ?? selectedProject?.name
        }
      />
    );
  }
  const sidebarExpanded = desktopSidebarDrawer
    ? desktopSidebarDrawerOpen
    : !sidebarCollapsed;
  const sidebarToggleVisible =
    !isPopout && (desktopSidebarDrawer || sidebarCollapsed);
  const focusRunTerminal = (terminalId: string) => {
    if (!selectedProject) return;
    setPendingSurfaceSelection({
      projectId: selectedProject.id,
      tabKey: projectSurfaceTabKey("terminal", terminalId),
    });
    revealWorkspace();
  };
  const renderProjectRunConfigurationControl = (compact: boolean) =>
    selectedProject ? (
      <RunConfigurationControl
        compact={compact}
        editorConfigurationId={runConfigurationEditorId}
        error={
          runConfigurations.isError ? errorText(runConfigurations.error) : null
        }
        inventory={runConfigurations.data}
        loading={runConfigurations.isLoading}
        projectId={selectedProject.id}
        renderEditor
        runtimes={runConfigurationRuntimes.data ?? []}
        workers={workers.data ?? []}
        worktrees={worktrees.data ?? []}
        onEditorConfigurationChange={setRunConfigurationEditorId}
        onFocusTerminal={focusRunTerminal}
      />
    ) : null;
  const renderBindings = {
    ...bindings,
    codeSurfaceVisible,
    contentHeaderActions,
    explorerSurfaceVisible,
    mobileSettingsSectionOpen,
    renderProjectRunConfigurationControl,
    setMobileSettingsSectionOpen,
    sidebarExpanded,
    sidebarToggleVisible,
    terminalSurfaceVisible,
  };

  return (
    <WorkspaceDndProvider
      className={`flex h-svh overflow-hidden bg-background text-foreground${
        settings.data?.preferences.contentGutters ? " content-gutters" : ""
      }`}
      layout={tabLayout.data}
      projects={visibleProjects}
      onOperation={handleWorkspaceDrop}
      tauriTitlebar={overlayTitlebar ? "overlay" : undefined}
    >
      <EliteGlobalEffects
        config={
          settings.data?.preferences.eliteRevealConfig ??
          DEFAULT_ELITE_REVEAL_CONFIG
        }
        enabled={settings.data?.preferences.eliteMode ?? false}
      />
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed right-3 top-3 z-[100] flex max-h-[calc(100vh-1.5rem)] flex-col items-end gap-2 overflow-hidden"
        data-slot="app-toast-viewport"
      >
        {appToast ? (
          <AppToast
            key={appToast.id}
            message={appToast.message}
            onDismiss={() => setAppToast(null)}
            title={appToast.title}
            tone={appToast.tone}
          />
        ) : null}
        {workspaceDragError ? (
          <AppToast
            dismissLabel="Dismiss workspace error"
            message={workspaceDragError}
            onDismiss={() => setWorkspaceDragError(null)}
            title="Workspace action failed"
            tone="error"
          />
        ) : null}
        {surfaceCreationFailure ? (
          <AppToast
            dismissLabel="Dismiss surface creation error"
            message={errorText(surfaceCreationFailure.error)}
            onDismiss={surfaceCreationFailure.dismiss}
            title={`Could not create ${surfaceCreationFailure.label}`}
            tone="error"
          />
        ) : null}
      </div>
      <ShellSidebar bindings={renderBindings} />
      <ShellContent bindings={renderBindings} />
      <ShellOverlays bindings={renderBindings} />
    </WorkspaceDndProvider>
  );
}
