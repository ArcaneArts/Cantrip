import {
  ArrowLeft,
  FolderOpen,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";
import {
  projectOverviewSectionLabel,
  type WorktreeBindingTarget,
} from "@/components/app/application-shell-model";
import { MobileAppModeSwitch } from "@/components/mobile/mobile-app-mode-switch";
import { MobileProjectHeader } from "@/components/mobile/mobile-project-header";
import { ProjectCreateMenu } from "@/components/projects/project-create-menu";
import { WorktreeControl } from "@/components/worktrees/worktree-control";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { desktopPopoutTitlebarLeftInset } from "@/lib/desktop-popout";
import { sidebarFileName } from "@/lib/sidebar-file-tabs";
import { cn } from "@/lib/utils";
import { useMouseBack } from "./use-mouse-back";
import { windowHeaderBindings } from "./window-header-bindings";
import {
  SelectedPaneTabStrip,
  selectedPaneTabStripVisible,
} from "./selected-pane-tab-strip";
type ShellHeaderBindings = Readonly<Record<string, any>>;

export function navigateMobileSettingsBack(
  sectionOpen: boolean,
  returnToRoot: () => void,
  exitSettings: () => void,
) {
  if (sectionOpen) {
    returnToRoot();
    return;
  }
  exitSettings();
}

export function ShellHeader({
  bindings: sourceBindings,
}: {
  bindings: ShellHeaderBindings;
}) {
  const bindings = windowHeaderBindings(sourceBindings);
  const {
    activeChat,
    activeExplorerHeader,
    activeProjectOverviewSection,
    activeProjectWorkspace,
    activeWorktree,
    activeWorktreeId,
    activeWorktreeTarget,
    appMode,
    bindWorktreeMutation,
    closeCompactProject,
    codeHeader,
    compactManagedHeader,
    compactShell,
    desktopSidebarDrawer,
    explorerDisplayPath,
    gitHistoryProject,
    isPopout,
    linkedConsoleChat,
    mobileSettingsSectionOpen,
    narrowViewport,
    openProjectCreateSource,
    openProjectSettings,
    overlayTitlebar,
    projectOverviewSelected,
    renderProjectRunConfigurationControl,
    requestBindWorktree,
    returnToCompactProjectOverview,
    selectedBrowser,
    selectedChat,
    selectedCodeTab,
    selectedExplorer,
    selectedFileDocument,
    selectedProject,
    selectedProjectView,
    selectedStandaloneChat,
    selectedTerminal,
    setDesktopSidebarDrawerOpen,
    setMobileSettingsSectionOpen,
    setSettingsSection,
    setShowArchivedStandaloneChats,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
    setSidebarCollapsed,
    setStandaloneFilesOpen,
    setWorktreeCreateTarget,
    showArchivedStandaloneChats,
    showContentTitlebar,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    showProjectOverview,
    setShowProjectOverview,
    sidebarToggleVisible,
    standaloneFilesOpen,
    switchToChat,
    switchToIde,
    workers,
    worktreeActionError,
    worktreeStatuses,
    worktrees,
    windowContentEmpty,
  } = bindings;
  useMouseBack(
    showSettings
      ? () => setShowSettings(false)
      : showProjectSettings
        ? () => setShowProjectSettings(false)
        : showProjectOverview
          ? () => setShowProjectOverview(false)
          : null,
  );
  const switchAppMode =
    isPopout || appMode === null
      ? null
      : appMode === "ide"
        ? switchToChat
        : switchToIde;
  const activeFilePath =
    selectedFileDocument?.path ??
    (selectedCodeTab
      ? codeHeader?.explorer?.selectedPath
      : selectedExplorer
        ? activeExplorerHeader
          ? activeExplorerHeader.selectedPath
          : selectedExplorer.selectedPath
        : null);
  const worktreeControl =
    !windowContentEmpty &&
    appMode === "ide" &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    activeWorktreeTarget &&
    activeWorktreeId &&
    selectedProject?.capabilities.worktrees &&
    !gitHistoryProject &&
    !projectOverviewSelected ? (
      <WorktreeControl
        currentWorktreeId={activeWorktreeId}
        projectId={selectedProject.id}
        worktrees={worktrees.data ?? []}
        statuses={worktreeStatuses}
        workers={workers.data ?? []}
        leaseOwner={activeChat?.title}
        actions={{
          branchDisabled:
            bindWorktreeMutation.isPending ||
            activeChat?.status === "running" ||
            selectedTerminal?.status === "running",
          chatMode: activeChat?.worktreeMode,
          pending: bindWorktreeMutation.isPending,
          disabled:
            bindWorktreeMutation.isPending ||
            activeChat?.status === "running" ||
            selectedTerminal?.status === "running" ||
            (Boolean(selectedCodeTab) && !codeHeader),
          error: worktreeActionError,
          onCreate: () => setWorktreeCreateTarget(activeWorktreeTarget),
          onSelect: (worktreeId) =>
            void requestBindWorktree({
              target: activeWorktreeTarget,
              worktreeId,
            }),
          onSetChatMode: activeChat
            ? (mode) =>
                bindWorktreeMutation.mutate({
                  target: activeWorktreeTarget,
                  worktreeId: activeChat.activeWorktreeId,
                  mode,
                })
            : undefined,
        }}
      />
    ) : null;
  if (
    ((showSettings || showProjectSettings) && !compactShell) ||
    showProjectOverview
  ) {
    return (
      <header
        className={cn(
          "relative z-30 flex shrink-0 items-center gap-4 px-4",
          compactShell && "mobile-safe-top",
          overlayTitlebar ? "h-8 text-xs" : "h-16 text-sm",
        )}
        data-slot="content-titlebar"
        data-tauri-drag-region={overlayTitlebar ? "" : undefined}
        style={{
          paddingLeft: desktopPopoutTitlebarLeftInset(true, overlayTitlebar),
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          className={overlayTitlebar ? "h-6 text-xs" : undefined}
          onClick={() =>
            showSettings
              ? setShowSettings(false)
              : showProjectSettings
                ? setShowProjectSettings(false)
                : setShowProjectOverview(false)
          }
        >
          <ArrowLeft className="size-4" />
          {showProjectSettings || appMode === "ide"
            ? "Back to Project"
            : "Back to Chat"}
        </Button>
        <span data-tauri-drag-region={overlayTitlebar ? "" : undefined}>
          {showSettings
            ? "Settings"
            : showProjectSettings
              ? "Project Settings"
              : "Overview"}
        </span>
      </header>
    );
  }
  if (isPopout && selectedPaneTabStripVisible(bindings)) {
    return (
      <header
        className="relative z-30 flex h-10 min-w-0 shrink-0 items-stretch gap-1 pr-2"
        data-slot="content-titlebar"
        data-popout-tab-titlebar=""
        data-tauri-drag-region=""
        style={{
          paddingLeft: desktopPopoutTitlebarLeftInset(true, overlayTitlebar),
        }}
      >
        <SelectedPaneTabStrip bindings={bindings} titlebar />
        <div
          aria-hidden="true"
          className="w-8 shrink-0"
          data-tauri-drag-region=""
        />
        <div
          className="flex shrink-0 items-center gap-1"
          data-tauri-drag-region=""
        >
          {worktreeControl}
          {renderProjectRunConfigurationControl?.(true)}
        </div>
      </header>
    );
  }
  return (
    <>
      {compactShell && showImporter ? (
        <MobileProjectHeader
          appMode={appMode}
          context={activeProjectWorkspace?.name ?? "Choose a repository"}
          onBack={closeCompactProject}
          onSwitchAppMode={switchAppMode ?? undefined}
          title="GitHub repositories"
        />
      ) : compactShell && showSettings ? (
        <MobileProjectHeader
          appMode={appMode}
          context="Account preferences"
          onBack={() =>
            navigateMobileSettingsBack(
              mobileSettingsSectionOpen,
              () => setMobileSettingsSectionOpen(false),
              closeCompactProject,
            )
          }
          onSwitchAppMode={switchAppMode ?? undefined}
          title="Settings"
        />
      ) : compactShell && showArchivedStandaloneChats ? (
        <MobileProjectHeader
          appMode={appMode}
          context="Recover or permanently delete conversations"
          onBack={() => setShowArchivedStandaloneChats(false)}
          onSwitchAppMode={switchAppMode ?? undefined}
          title="Archived chats"
        />
      ) : compactShell && showServerAdmin ? (
        <MobileProjectHeader
          appMode={appMode}
          context="Account access and server policy"
          onBack={closeCompactProject}
          onSwitchAppMode={switchAppMode ?? undefined}
          title="Server administration"
        />
      ) : compactShell &&
        appMode === "ide" &&
        showProjectSettings &&
        selectedProject ? (
        <MobileProjectHeader
          actions={renderProjectRunConfigurationControl(true)}
          appMode={appMode}
          context={
            selectedProject.github?.nameWithOwner ??
            selectedProject.source?.displayPath
          }
          onBack={() =>
            navigateMobileSettingsBack(
              mobileSettingsSectionOpen,
              () => setMobileSettingsSectionOpen(false),
              returnToCompactProjectOverview,
            )
          }
          onSwitchAppMode={switchAppMode ?? undefined}
          title="Project settings"
        />
      ) : compactShell &&
        appMode === "ide" &&
        projectOverviewSelected &&
        selectedProject ? (
        <MobileProjectHeader
          actions={<>{renderProjectRunConfigurationControl(true)}</>}
          appMode={appMode}
          context={
            selectedProject.github?.nameWithOwner ??
            selectedProject.source?.displayPath
          }
          onCloseProject={closeCompactProject}
          onOpenProjectSettings={() => openProjectSettings(selectedProject.id)}
          onSwitchAppMode={switchAppMode ?? undefined}
          title={selectedProject.name}
        />
      ) : null}
      {showContentTitlebar && !compactManagedHeader ? (
        <header
          className={cn(
            "relative z-30 flex shrink-0 items-center justify-between",
            compactShell && "mobile-safe-top",
            overlayTitlebar
              ? "h-8 gap-2 px-3 text-[11px] sm:px-4 [&_[data-slot=badge]]:h-5 [&_[data-slot=badge]]:gap-1 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:min-w-6 [&_[data-slot=button]]:w-auto [&_[data-slot=button]]:gap-1 [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:py-0 [&_[data-slot=button]]:text-[11px] [&_svg]:size-3"
              : "h-16 gap-4 px-4 sm:px-6",
          )}
          data-slot="content-titlebar"
          data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          style={{
            paddingLeft: desktopPopoutTitlebarLeftInset(
              isPopout,
              overlayTitlebar,
            ),
          }}
        >
          {sidebarToggleVisible ? (
            <TooltipButton
              size="icon"
              variant="ghost"
              className={cn(
                compactShell ? "relative size-9" : "absolute size-8",
                !compactShell &&
                  (overlayTitlebar ? "left-20 top-1" : "left-4 top-4"),
              )}
              onClick={() =>
                desktopSidebarDrawer
                  ? setDesktopSidebarDrawerOpen(true)
                  : setSidebarCollapsed(false)
              }
              tooltip={desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
            >
              <PanelLeftOpen className="size-4" />
              <span className="sr-only">
                {desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
              </span>
            </TooltipButton>
          ) : null}
          <div
            className={cn(
              "min-w-0",
              overlayTitlebar &&
                "flex flex-1 items-center gap-2 overflow-hidden",
              sidebarToggleVisible &&
                !compactShell &&
                (overlayTitlebar ? "pl-[6.25rem]" : "pl-10"),
            )}
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          >
            <div
              className={cn(
                "flex min-w-0 items-center font-medium",
                overlayTitlebar ? "gap-1.5 text-xs" : "gap-2 text-sm",
              )}
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <span
                className="truncate"
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                {windowContentEmpty
                  ? null
                  : showImporter
                    ? "GitHub repositories"
                    : showSettings
                      ? "Settings"
                      : showArchivedStandaloneChats
                        ? "Archived chats"
                        : showServerAdmin
                          ? "Server administration"
                          : appMode === "chat"
                            ? (selectedStandaloneChat?.title ?? "Chat")
                            : showProjectSettings
                              ? "Project settings"
                              : projectOverviewSelected && selectedProject
                                ? selectedProject.name
                                : gitHistoryProject
                                  ? (selectedProjectView?.title ?? "Git")
                                  : selectedProjectView?.kind ===
                                      "remote-desktop"
                                    ? selectedProjectView.title
                                    : selectedCodeTab
                                      ? activeFilePath
                                        ? sidebarFileName(activeFilePath)
                                        : selectedCodeTab.title
                                      : selectedBrowser
                                        ? selectedBrowser.title
                                        : selectedFileDocument
                                          ? sidebarFileName(
                                              selectedFileDocument.path,
                                            )
                                          : selectedExplorer
                                            ? activeFilePath
                                              ? sidebarFileName(activeFilePath)
                                              : selectedExplorer.title
                                            : selectedTerminal
                                              ? selectedTerminal.linkedChatId
                                                ? (linkedConsoleChat?.title ??
                                                  "Agent")
                                                : selectedTerminal.title
                                              : selectedChat
                                                ? selectedChat.title
                                                : (selectedProject?.github
                                                    ?.nameWithOwner ??
                                                  "Cantrip")}
              </span>
              {worktreeControl}
            </div>
            <p
              className={cn(
                "truncate text-muted-foreground",
                overlayTitlebar
                  ? "hidden min-w-0 flex-1 text-[10px] leading-none lg:block"
                  : "text-xs",
              )}
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              {windowContentEmpty
                ? null
                : showImporter
                  ? "Add a worker-owned source"
                  : showSettings
                    ? "Account preferences"
                    : showArchivedStandaloneChats
                      ? "Recover or permanently delete conversations"
                      : showServerAdmin
                        ? "Account access and server policy"
                        : appMode === "chat"
                          ? selectedStandaloneChat
                            ? `Standalone conversation · ${selectedStandaloneChat.status}`
                            : "Your standalone conversations"
                          : showProjectSettings
                            ? (selectedProject?.github?.nameWithOwner ??
                              selectedProject?.name ??
                              "Project preferences")
                            : projectOverviewSelected && selectedProject
                              ? activeProjectOverviewSection === "overview"
                                ? "Project overview"
                                : `Project ${projectOverviewSectionLabel(activeProjectOverviewSection).toLowerCase()}`
                              : gitHistoryProject
                                ? null
                                : selectedProjectView?.kind === "remote-desktop"
                                  ? "Managed project-worker desktop"
                                  : selectedCodeTab
                                    ? activeFilePath
                                      ? null
                                      : (activeWorktree?.displayPath ??
                                        selectedProject?.source?.displayPath ??
                                        "Code")
                                    : selectedBrowser
                                      ? selectedBrowser.url
                                      : selectedExplorer || selectedFileDocument
                                        ? activeFilePath
                                          ? null
                                          : explorerDisplayPath
                                        : selectedTerminal
                                          ? selectedTerminal.linkedChatId
                                            ? (activeWorktree?.displayPath ??
                                              selectedProject?.source
                                                ?.displayPath ??
                                              "Agent")
                                            : (activeWorktree?.displayPath ??
                                              selectedProject?.source
                                                ?.displayPath ??
                                              "Terminal")
                                          : selectedChat
                                            ? (activeWorktree?.displayPath ??
                                              selectedProject?.source
                                                ?.displayPath ??
                                              "Agent")
                                            : (selectedProject?.source
                                                ?.displayPath ??
                                              "Choose a project to begin")}
            </p>
          </div>
          <div
            className={cn(
              "flex items-center md:hidden",
              overlayTitlebar ? "gap-1" : "gap-2",
            )}
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          >
            {appMode === "chat" && selectedStandaloneChat ? (
              <TooltipButton
                aria-pressed={standaloneFilesOpen}
                onClick={() => setStandaloneFilesOpen((open: boolean) => !open)}
                size="sm"
                tooltip="Open Chat files"
                variant={standaloneFilesOpen ? "outline" : "ghost"}
              >
                <FolderOpen className="size-4" />
                Files
              </TooltipButton>
            ) : null}
            {appMode === "ide" &&
            narrowViewport &&
            !showImporter &&
            !showSettings &&
            !showServerAdmin &&
            selectedProject
              ? renderProjectRunConfigurationControl(true)
              : null}
            {compactShell && switchAppMode ? (
              <MobileAppModeSwitch
                currentMode={appMode}
                onSwitch={switchAppMode}
              />
            ) : null}
            {!isPopout && !compactShell && appMode === "ide" ? (
              <>
                <TooltipButton
                  size="icon"
                  variant="ghost"
                  tooltip="Open settings"
                  onClick={() => {
                    setSettingsSection("general");
                    setShowSettings(true);
                    setShowServerAdmin(false);
                    setShowImporter(false);
                    setShowProjectSettings(false);
                  }}
                >
                  <Settings className="size-4" />
                  <span className="sr-only">Open settings</span>
                </TooltipButton>
                <ProjectCreateMenu onSelect={openProjectCreateSource}>
                  <Button size="sm" variant="outline">
                    <Plus className="size-4" />
                    Project
                  </Button>
                </ProjectCreateMenu>
              </>
            ) : null}
          </div>
          <div
            className={cn(
              "ml-auto hidden items-center md:flex",
              overlayTitlebar ? "gap-1" : "gap-2",
            )}
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          >
            {appMode === "chat" && selectedStandaloneChat ? (
              <TooltipButton
                aria-pressed={standaloneFilesOpen}
                onClick={() => setStandaloneFilesOpen((open: boolean) => !open)}
                size="sm"
                tooltip="Open Chat files"
                variant={standaloneFilesOpen ? "outline" : "ghost"}
              >
                <FolderOpen className="size-4" />
                Files
              </TooltipButton>
            ) : null}
            {appMode === "ide" &&
            !narrowViewport &&
            !showImporter &&
            !showSettings &&
            !showServerAdmin &&
            selectedProject
              ? renderProjectRunConfigurationControl(overlayTitlebar)
              : null}
          </div>
        </header>
      ) : null}
    </>
  );
}
