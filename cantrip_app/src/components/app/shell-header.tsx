import {
  FolderOpen,
  GitBranch,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";
import {
  projectOverviewSectionLabel,
  type WorktreeBindingTarget,
} from "@/components/app/application-shell-model";
import {
  ContentHeaderActions,
  ExplorerFileCloseButton,
  type ContentHeaderActionsProps,
} from "@/components/workspace/content-header-actions";
import { MobileAppModeSwitch } from "@/components/mobile/mobile-app-mode-switch";
import { MobileProjectHeader } from "@/components/mobile/mobile-project-header";
import { ProjectCreateMenu } from "@/components/projects/project-create-menu";
import { WorktreeControl } from "@/components/worktrees/worktree-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { desktopPopoutTitlebarLeftInset } from "@/lib/desktop-popout";
import { sidebarFileName } from "@/lib/sidebar-file-tabs";
import { cn } from "@/lib/utils";
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

export function ShellHeader({ bindings }: { bindings: ShellHeaderBindings }) {
  const {
    activeChat,
    activeExplorerHeader,
    activeProjectOverviewSection,
    activeProjectTaskChat,
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
    contentHeaderActions,
    contentScrolled,
    desktopSidebarDrawer,
    displayedGitProject,
    explorerDisplayPath,
    gitHistoryHeader,
    gitHistoryProject,
    isPopout,
    linkedConsoleChat,
    mobileTabGridOpen,
    mobileSettingsSectionOpen,
    narrowViewport,
    openChatExplorerHere,
    openChatHistoryHere,
    openChatTerminalHere,
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
    sidebarFilePreview,
    sidebarFilePreviewVisible,
    sidebarToggleVisible,
    standaloneFilesOpen,
    switchToChat,
    switchToIde,
    workers,
    worktreeActionError,
    worktreeStatuses,
    worktrees,
  } = bindings;
  const switchAppMode =
    isPopout || appMode === null
      ? null
      : appMode === "ide"
        ? switchToChat
        : switchToIde;
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
        mobileTabGridOpen &&
        selectedProject ? (
        <MobileProjectHeader
          actions={renderProjectRunConfigurationControl(true)}
          appMode={appMode}
          context={`Tabs · ${
            selectedProject.github?.nameWithOwner ??
            selectedProject.source?.displayPath ??
            selectedProject.name
          }`}
          onSwitchAppMode={switchAppMode ?? undefined}
          title={selectedProject.name}
        />
      ) : compactShell &&
        appMode === "ide" &&
        projectOverviewSelected &&
        selectedProject ? (
        <MobileProjectHeader
          actions={
            <>
              {activeProjectTaskChat ? (
                <ContentHeaderActions
                  compact
                  task={contentHeaderActions.task}
                />
              ) : null}
              {renderProjectRunConfigurationControl(true)}
            </>
          }
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
              {appMode === "ide" && selectedExplorer ? (
                <ExplorerFileCloseButton
                  compact={overlayTitlebar}
                  header={activeExplorerHeader}
                />
              ) : null}
              <span
                className="truncate"
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                {showImporter
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
                                : selectedProjectView?.kind === "remote-desktop"
                                  ? selectedProjectView.title
                                  : selectedCodeTab
                                    ? selectedCodeTab.title
                                    : selectedBrowser
                                      ? selectedBrowser.title
                                      : selectedExplorer
                                        ? sidebarFilePreviewVisible &&
                                          sidebarFilePreview
                                          ? sidebarFileName(
                                              sidebarFilePreview.path,
                                            )
                                          : selectedExplorer.title
                                        : selectedTerminal
                                          ? selectedTerminal.linkedChatId
                                            ? (linkedConsoleChat?.title ??
                                              "Agent")
                                            : selectedTerminal.title
                                          : selectedChat
                                            ? selectedChat.title
                                            : (selectedProject?.github
                                                ?.nameWithOwner ?? "Cantrip")}
              </span>
              {appMode === "ide" &&
              !showImporter &&
              !showSettings &&
              !showServerAdmin &&
              activeWorktreeTarget &&
              activeWorktreeId &&
              selectedProject?.capabilities.worktrees &&
              (!gitHistoryProject ||
                gitHistoryHeader?.section === "history" ||
                gitHistoryHeader?.section === "graph") ? (
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
                      ((selectedCodeTab?.status === "running" ||
                        selectedCodeTab?.status === "starting") &&
                        !codeHeader),
                    error: worktreeActionError,
                    onCreate: () =>
                      setWorktreeCreateTarget(activeWorktreeTarget),
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
                    onOpenTerminal: activeChat
                      ? () => openChatTerminalHere(activeChat)
                      : undefined,
                    onOpenExplorer: activeChat
                      ? () => openChatExplorerHere(activeChat)
                      : undefined,
                    onOpenHistory: activeChat
                      ? () => openChatHistoryHere(activeChat)
                      : undefined,
                  }}
                />
              ) : null}
              {appMode === "ide" &&
              gitHistoryProject &&
              (gitHistoryHeader?.section === "history" ||
                gitHistoryHeader?.section === "graph") ? (
                <>
                  <Badge
                    variant="secondary"
                    className="hidden shrink-0 gap-1 font-mono font-normal sm:flex"
                  >
                    <GitBranch className="size-3" />
                    {gitHistoryHeader.branch || "detached HEAD"}
                  </Badge>
                  {gitHistoryHeader.head ? (
                    <code className="hidden shrink-0 text-[11px] font-normal text-muted-foreground sm:block">
                      @ {gitHistoryHeader.head.slice(0, 8)}
                    </code>
                  ) : null}
                </>
              ) : null}
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
              {showImporter ? (
                "Add a worker-owned source"
              ) : showSettings ? (
                "Account preferences"
              ) : showArchivedStandaloneChats ? (
                "Recover or permanently delete conversations"
              ) : showServerAdmin ? (
                "Account access and server policy"
              ) : appMode === "chat" ? (
                selectedStandaloneChat ? (
                  `Standalone conversation · ${selectedStandaloneChat.status}`
                ) : (
                  "Your standalone conversations"
                )
              ) : showProjectSettings ? (
                (selectedProject?.github?.nameWithOwner ??
                selectedProject?.name ??
                "Project preferences")
              ) : projectOverviewSelected && selectedProject ? (
                activeProjectOverviewSection === "overview" ? (
                  "Project overview"
                ) : (
                  `Project ${projectOverviewSectionLabel(activeProjectOverviewSection).toLowerCase()}`
                )
              ) : gitHistoryProject ? (
                <>
                  {gitHistoryProject.github?.nameWithOwner ??
                    gitHistoryProject.name}
                  {gitHistoryHeader ? (
                    gitHistoryHeader.section === "graph" ? (
                      ` · ${gitHistoryHeader.graphNodes.toLocaleString()} repository nodes`
                    ) : gitHistoryHeader.section !== "history" ? (
                      ` · ${gitHistoryHeader.issueCount ?? "…"} ${gitHistoryHeader.issueState} ${gitHistoryHeader.section === "prs" ? "PRs" : "issues"}`
                    ) : (
                      <>
                        <span className="sm:hidden">
                          {` · ${gitHistoryHeader.branch || "detached HEAD"}${gitHistoryHeader.head ? ` @ ${gitHistoryHeader.head.slice(0, 8)}` : ""}`}
                        </span>
                        {` · ${gitHistoryHeader.commitsLoaded} commits loaded`}
                      </>
                    )
                  ) : null}
                </>
              ) : selectedProjectView?.kind === "remote-desktop" ? (
                "Managed project-worker desktop"
              ) : selectedCodeTab ? (
                `${activeWorktree?.displayPath ?? selectedProject?.source?.displayPath ?? "Code"} · ${selectedCodeTab.profileId}`
              ) : selectedBrowser ? (
                selectedBrowser.url
              ) : selectedExplorer ? (
                explorerDisplayPath
              ) : selectedTerminal ? (
                selectedTerminal.linkedChatId ? (
                  (activeWorktree?.displayPath ??
                  selectedProject?.source?.displayPath ??
                  "Agent")
                ) : (
                  (activeWorktree?.displayPath ??
                  selectedProject?.source?.displayPath ??
                  "Terminal")
                )
              ) : selectedChat ? (
                (activeWorktree?.displayPath ??
                selectedProject?.source?.displayPath ??
                "Agent")
              ) : (
                (selectedProject?.source?.displayPath ??
                "Choose a project to begin")
              )}
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
            {appMode === "ide" ? (
              <ContentHeaderActions {...contentHeaderActions} compact />
            ) : null}
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
            {appMode === "ide" ? (
              <ContentHeaderActions {...contentHeaderActions} />
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
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border transition-opacity duration-200",
              contentScrolled && !displayedGitProject
                ? "opacity-100"
                : "opacity-0",
            )}
          />
        </header>
      ) : null}
    </>
  );
}
