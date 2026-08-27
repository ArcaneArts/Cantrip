import { DEFAULT_ELITE_REVEAL_CONFIG } from "@cantrip/glitch";
import type {
  BrowserFleetService,
  ProjectViewSummary,
  RemoteDesktopTarget,
  TaskDetail,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Code2,
  ExternalLink,
  Folder,
  FolderTree,
  Globe2,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  SquareTerminal,
  WifiOff,
} from "lucide-react";
import { Suspense, type ReactNode } from "react";
import {
  BrowserView,
  RemoteDesktopView,
  RunTerminalView,
  TerminalView,
} from "@/components/app/application-shell-surfaces";
import { ArchivedStandaloneChatsPage } from "@/components/chat/archived-standalone-chats-page";
import {
  GitHistoryView,
  type GitHistoryHeaderState,
  type GitViewSection,
} from "@/components/git/git-history";
import {
  IDE_CHAT_SURFACE_CAPABILITIES,
  STANDALONE_CHAT_SURFACE_CAPABILITIES,
} from "@/components/chat/chat-surface-capabilities";
import { MobileBottomNavigation } from "@/components/mobile/mobile-bottom-navigation";
import { MobileProjectSelector } from "@/components/mobile/mobile-project-selector";
import { MobileProjectTabGrid } from "@/components/mobile/mobile-project-tab-grid";
import { ProjectSettingsPage } from "@/components/projects/project-settings-page";
import { ProjectOverview } from "@/components/projects/project-overview";
import { ProjectOverviewNavigation } from "@/components/projects/project-overview-navigation";
import {
  ProjectTasksDashboard,
  projectTaskIsUnqueuedDraft,
} from "@/components/projects/project-tasks-dashboard";
import { ProjectCreateMenu } from "@/components/projects/project-create-menu";
import { RepositoryImporter } from "@/components/projects/repository-importer";
import { SettingsPage } from "@/components/settings/settings-page";
import { ServerAdminPage } from "@/components/servers/server-admin-page";
import { errorMessage as errorText } from "@/lib/error-message";
import { PRIMARY_MOBILE_BOTTOM_TAB_ID } from "@/lib/mobile-navigation";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { resolveStandaloneChatFilePath } from "@/lib/api";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import { cn } from "@/lib/utils";
import { projectSetupPercent } from "@/lib/project-setup-progress";
import { projectHasGithubCapability } from "@/lib/project-capabilities";
import {
  projectFolderSetupErrorMessage,
  projectReplicaProgressMessage,
  projectSetupErrorMessage,
} from "@/lib/job-status-message";
import { ChatTranscript } from "@/components/chat/chat-transcript";
type GlobalContentBindings = Readonly<Record<string, any>>;

function StandaloneChatHost({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function ProjectSurfaceHost({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function ProjectOverviewHost({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function DetachedGroupPlaceholder({ onFocus }: { onFocus(): void }) {
  return (
    <EmptyState>
      <EmptyStateContent>
        <EmptyStateIcon>
          <ExternalLink className="size-5" />
        </EmptyStateIcon>
        <EmptyStateTitle as="h1">Open in another window</EmptyStateTitle>
        <EmptyStateDescription>
          This tab group is attached to its desktop pop-out.
        </EmptyStateDescription>
        <EmptyStateActions>
          <Button variant="outline" onClick={onFocus}>
            <ExternalLink className="size-4" />
            Focus window
          </Button>
        </EmptyStateActions>
      </EmptyStateContent>
    </EmptyState>
  );
}

export function GlobalContentHost({
  bindings,
}: {
  bindings: GlobalContentBindings;
}) {
  const {
    activeMobileBottomTab,
    activeMobileBottomTabId,
    activeProjectOverviewSection,
    activeProjectTaskChat,
    activeProjectTaskChatId,
    activeProjectTaskView,
    activeProjectWorkspace,
    addMobileBottomTab,
    agentInspectOpenChats,
    appMode,
    archiveStandaloneChat,
    archivedStandaloneChats,
    bindWorktreeMutation,
    bootstrap,
    chats,
    closeProjectTask,
    codeAppearance,
    codeTabs,
    compactShell,
    contentScrolled,
    createProjectSurface,
    createWorkspaceMutation,
    creatingSurfaceKinds,
    currentRelocation,
    deleteChatMutation,
    desktopRuntime,
    displayTerminals,
    displayedGitProject,
    explorers,
    focusDetachedGroup,
    folderSetupJobs,
    groupOwnedElsewhere,
    isPopout,
    linkedConsoleChat,
    mobileBottomNavigationItems,
    mobileProjectSelectorOpen,
    mobileTabGridOpen,
    narrowViewport,
    newBrowser,
    newChat,
    newCodeTab,
    newExplorer,
    newProjectView,
    newRemoteDesktop,
    newStandaloneChat,
    newTask,
    newTerminal,
    onlineWorker,
    openChatFileLink,
    openCompactRootSettings,
    openCreatedProject,
    openCreatedTab,
    openMobileBottomTabSwitcher,
    openProjectCreateSource,
    openProjectExplorerFile,
    openProjectSettings,
    openProjectTask,
    openServerAdmin,
    openTerminalLink,
    openTerminalLinkExternally,
    openTunnelOwner,
    pendingTerminalInputs,
    permanentlyDeleteStandaloneChat,
    projectOverviewGitProject,
    projectOverviewGitSection,
    projectOverviewPopoutTarget,
    projectOverviewSelected,
    projectRevealButtonLabel,
    projectRevealLabel,
    projectSettingsSection,
    projectSetupJobs,
    projectSurfaces,
    projectTaskChatIds,
    projectTokenUsage,
    projectViews,
    projectWorkspaces,
    projects,
    queryClient: untypedQueryClient,
    remoteDesktop,
    removeActiveMobileBottomTab,
    removeMobileBottomTabById,
    renameChatMutation,
    renameStandaloneChat,
    repositoryStats,
    resolvedProjectOverviewWorktreeId,
    restoreStandaloneChat,
    retryFolderSetupMutation,
    runConfigurations,
    selectGroupFromMobileSwitcher,
    selectMobileBottomTab,
    selectMobileOverview,
    selectProjectFromSidebar,
    selectProjectWorkspace,
    selectStandaloneChat,
    selectTopTab,
    selectedBrowser,
    selectedChat,
    selectedCodeTab,
    selectedExplorer,
    selectedFolderSetupJob,
    selectedFolderSetupNeedsAttention,
    selectedLongPathSetupJob,
    selectedPlacementContext,
    selectedProject,
    selectedProjectSetupJob,
    selectedProjectView,
    selectedProjectWorkerId,
    selectedRunDefinitionAvailable,
    selectedRunLaunchAvailable,
    selectedRunLaunchProblem,
    selectedRunRuntime,
    selectedRunStopAvailable,
    selectedRunStopProblem,
    selectedRunTargetLabel,
    selectedStandaloneChat,
    selectedTabGroup,
    selectedTerminal,
    selectedWorker,
    selectedWorkflowIntentId,
    setAgentInspectOpen,
    setChatConsoleOpen,
    setChatRelocationOpen,
    setGitHistoryHeader,
    setMobileTabGridOpen,
    setPendingTerminalInputs,
    setProjectOverviewSection,
    setProjectOverviewWorktreeId,
    setRunConfigurationEditorId,
    setSettingsPolicyId,
    setSettingsSection,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
    setStandaloneFilePath,
    setStandaloneFilesOpen,
    setTerminalCommandPaletteTerminalId,
    setTerminalServiceTerminalId,
    settings,
    settingsPolicyId,
    settingsSection,
    showAppToast,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    standaloneChatCreationAvailable,
    standaloneChatCreationUnavailableReason,
    standaloneChatWorkerAvailable,
    standaloneChats,
    standaloneFilePath,
    standaloneFilesOpen,
    tabLayout,
    terminalCommandPaletteTerminalId,
    terminalServiceTerminalId,
    updateBrowserMutation,
    workers,
    workspaceSelection,
    worktreeStatuses,
    worktrees,
  } = bindings;
  const queryClient = untypedQueryClient as QueryClient;
  return (
    <>
      {mobileProjectSelectorOpen ? (
        <MobileProjectSelector
          activeWorkspace={activeProjectWorkspace}
          currentUserName={
            bootstrap.data?.auth.currentUser?.displayName ?? "Cantrip User"
          }
          error={projects.isError ? errorText(projects.error) : null}
          loading={projects.isLoading || projectWorkspaces.isLoading}
          folderSetupJobs={folderSetupJobs}
          projects={projects.data ?? []}
          projectSetupJobs={projectSetupJobs}
          workers={workers.data ?? []}
          workspaces={projectWorkspaces.data ?? []}
          onCreateWorkspace={async (name) => {
            await createWorkspaceMutation.mutateAsync(name);
          }}
          onManageWorkspaces={() => openCompactRootSettings("workspaces")}
          onNewProject={(source) => openProjectCreateSource(source, true)}
          onOpenAdmin={openServerAdmin}
          onOpenSettings={() => openCompactRootSettings()}
          onSelectProject={selectProjectFromSidebar}
          onSelectWorkspace={selectProjectWorkspace}
        />
      ) : showSettings ? (
        <SettingsPage
          appearance={codeAppearance}
          initialSection={settingsSection}
          initialPolicyId={settingsPolicyId}
          onEliteOpen={() => setSettingsSection("elite")}
          onPolicyOpenHandled={() => setSettingsPolicyId(null)}
          onOpenTunnelOwner={openTunnelOwner}
        />
      ) : showArchivedStandaloneChats ? (
        <ArchivedStandaloneChatsPage
          chats={archivedStandaloneChats.data ?? []}
          deleting={permanentlyDeleteStandaloneChat.isPending}
          error={
            archivedStandaloneChats.error ??
            restoreStandaloneChat.error ??
            permanentlyDeleteStandaloneChat.error
          }
          loading={archivedStandaloneChats.isLoading}
          restoring={restoreStandaloneChat.isPending}
          onPermanentlyDelete={(chat) =>
            permanentlyDeleteStandaloneChat.mutate(chat)
          }
          onRestore={(chat) => restoreStandaloneChat.mutate(chat)}
        />
      ) : showServerAdmin ? (
        <ServerAdminPage />
      ) : appMode === "chat" ? (
        <StandaloneChatHost>
          {selectedStandaloneChat ? (
            <ChatTranscript
              key={selectedStandaloneChat.id}
              capabilities={STANDALONE_CHAT_SURFACE_CAPABILITIES}
              chat={selectedStandaloneChat}
              desktopRuntime={desktopRuntime}
              filesOpen={standaloneFilesOpen}
              filesRequestedPath={standaloneFilePath}
              githubEnabled={false}
              inspectOpen={false}
              inspectOverlay={narrowViewport}
              settings={settings.data}
              syncEnabled={false}
              onCreateChat={() => newStandaloneChat.mutate()}
              onDelete={() =>
                archiveStandaloneChat.mutate(selectedStandaloneChat)
              }
              onForked={(forked) => {
                if (forked.contextKind === "standalone") {
                  selectStandaloneChat(forked);
                }
              }}
              onFilesOpenChange={setStandaloneFilesOpen}
              onInspectOpenChange={() => undefined}
              onOpenFile={(reference) => {
                void resolveStandaloneChatFilePath(
                  selectedStandaloneChat.id,
                  reference,
                )
                  .then((path) => {
                    setStandaloneFilePath(path);
                    setStandaloneFilesOpen(true);
                  })
                  .catch((error: unknown) =>
                    showAppToast({
                      message: errorText(error),
                      title: "Could not open Chat file",
                      tone: "error",
                    }),
                  );
              }}
              onOpenWorkflow={() => undefined}
              onOpenRelocation={() => undefined}
              onToast={showAppToast}
              onRename={(title) =>
                renameStandaloneChat.mutate({
                  chatId: selectedStandaloneChat.id,
                  title,
                })
              }
              relocationJob={null}
              refocusOnWindowActivation={desktopRuntime}
            />
          ) : (
            <EmptyState>
              <EmptyStateContent>
                <EmptyStateIcon>
                  {standaloneChats.isLoading ||
                  appMode === null ||
                  !bootstrap.isSuccess ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : !standaloneChatWorkerAvailable ? (
                    <WifiOff className="size-5 text-amber-500" />
                  ) : (
                    <MessageSquare className="size-5" />
                  )}
                </EmptyStateIcon>
                <EmptyStateTitle as="h1">Start a new Chat</EmptyStateTitle>
                <EmptyStateDescription>
                  {!standaloneChatCreationAvailable
                    ? standaloneChatCreationUnavailableReason
                    : "Chat with Cantrip without attaching the conversation to a project."}
                </EmptyStateDescription>
                {standaloneChatCreationAvailable ? (
                  <EmptyStateActions>
                    <Button
                      disabled={newStandaloneChat.isPending}
                      onClick={() => newStandaloneChat.mutate()}
                    >
                      <Plus className="size-4" /> New Chat
                    </Button>
                  </EmptyStateActions>
                ) : null}
              </EmptyStateContent>
            </EmptyState>
          )}
        </StandaloneChatHost>
      ) : showProjectSettings && selectedProject ? (
        <ProjectSettingsPage
          desktopRuntime={desktopRuntime && projectRevealLabel !== null}
          initialSection={projectSettingsSection}
          initialWorkflowId={selectedWorkflowIntentId}
          project={selectedProject}
          chats={chats.data ?? []}
          codeTabs={codeTabs.data ?? []}
          terminals={displayTerminals}
          explorers={explorers.data ?? []}
          projectViews={projectViews.data ?? []}
          workers={workers.data ?? []}
          worktrees={worktrees.data ?? []}
          statuses={worktreeStatuses}
          onCreateChat={(worktreeId) =>
            newChat.mutate({
              projectId: selectedProject.id,
              worktreeId,
              worktreeMode: "pinned",
            })
          }
          onCreateCode={(worktreeId) =>
            newCodeTab.mutate({
              projectId: selectedProject.id,
              worktreeId,
            })
          }
          onCreateTerminal={(worktreeId) =>
            newTerminal.mutate({
              projectId: selectedProject.id,
              worktreeId,
            })
          }
          onCreateExplorer={(worktreeId) =>
            newExplorer.mutate({
              projectId: selectedProject.id,
              worktreeId,
            })
          }
          onCreateHistory={(worktreeId) =>
            newProjectView.mutate({
              projectId: selectedProject.id,
              kind: "history",
              worktreeId,
            })
          }
          onRestoreChat={(chat) =>
            chat.experience === "task"
              ? openProjectTask(chat.projectId, chat.id)
              : openCreatedTab(chat.projectId, "chat", chat.id)
          }
          onOpenTunnelOwner={openTunnelOwner}
          onOpenImportedChat={(chatId) =>
            openCreatedTab(selectedProject.id, "chat", chatId)
          }
          onOpenPolicySettings={(policyId) => {
            setSettingsPolicyId(policyId ?? null);
            setSettingsSection("policies");
            setShowSettings(true);
            setShowServerAdmin(false);
            setShowImporter(false);
            setShowProjectSettings(false);
          }}
        />
      ) : showImporter ? (
        <RepositoryImporter
          activeWorkspaceId={activeProjectWorkspace?.id ?? null}
          onCreatedProject={openCreatedProject}
          projects={projects.data ?? []}
          projectSetupJobs={projectSetupJobs}
          workerId={onlineWorker?.workerId ?? null}
          workers={workers.data ?? []}
          workspaces={projectWorkspaces.data ?? []}
        />
      ) : compactShell && mobileTabGridOpen && selectedProject ? (
        <MobileProjectTabGrid
          activeGroupId={activeMobileBottomTab?.groupId}
          activeTabByGroup={workspaceSelection.activeTabByGroup}
          creatingKinds={creatingSurfaceKinds}
          layout={tabLayout.data}
          surfaces={projectSurfaces}
          onCreate={(kind, target) =>
            createProjectSurface(selectedProject.id, kind, undefined, target)
          }
          placement={selectedPlacementContext}
          onRemoveBottomTab={
            activeMobileBottomTabId === PRIMARY_MOBILE_BOTTOM_TAB_ID
              ? undefined
              : removeActiveMobileBottomTab
          }
          onSelectGroup={selectGroupFromMobileSwitcher}
        />
      ) : groupOwnedElsewhere && selectedTabGroup ? (
        <DetachedGroupPlaceholder
          onFocus={() => focusDetachedGroup(selectedTabGroup.id)}
        />
      ) : (
        <ProjectSurfaceHost>
          {selectedProjectView?.kind === "remote-desktop" ? (
            remoteDesktop.data ? (
              <Suspense
                fallback={
                  <div className="grid flex-1 place-items-center text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                }
              >
                <RemoteDesktopView
                  desktop={remoteDesktop.data}
                  fleetDiscovery={
                    bootstrap.data?.capabilities.remoteDesktopFleet ?? false
                  }
                  workerName={selectedWorker?.name}
                  onOpenFleetTarget={(
                    workerId: string,
                    desktopTarget: RemoteDesktopTarget,
                  ) =>
                    newRemoteDesktop.mutate({
                      projectId: remoteDesktop.data.projectId,
                      tabGroupId: selectedTabGroup?.id,
                      target: {
                        kind: "worker",
                        projectId: remoteDesktop.data.projectId,
                        workerId,
                      },
                      desktopTarget,
                    })
                  }
                />
              </Suspense>
            ) : remoteDesktop.isError ? (
              <div className="grid flex-1 place-items-center p-6 text-center text-sm text-destructive">
                {errorText(remoteDesktop.error)}
              </div>
            ) : (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )
          ) : displayedGitProject ? (
            <GitHistoryView
              key={
                projectOverviewGitProject
                  ? `overview:${projectOverviewGitProject.id}`
                  : selectedProjectView?.id
              }
              activeSection={projectOverviewGitSection ?? undefined}
              chats={chats.data ?? []}
              contentScrolled={contentScrolled}
              includeOverviewTab={Boolean(
                projectOverviewGitProject && !projectOverviewPopoutTarget,
              )}
              view={
                projectOverviewGitSection === "issues"
                  ? "issues"
                  : (selectedProjectView?.kind ?? "history")
              }
              standalone={isPopout || Boolean(projectOverviewGitProject)}
              project={displayedGitProject}
              showSectionTabs={!projectOverviewPopoutTarget}
              worktreeId={
                projectOverviewGitProject
                  ? (resolvedProjectOverviewWorktreeId ?? "")
                  : (selectedProjectView?.worktreeId ??
                    worktrees.data?.find(
                      ({ isPrimary }: { isPrimary: boolean }) => isPrimary,
                    )?.id ??
                    "")
              }
              worktrees={worktrees.data ?? []}
              statuses={worktreeStatuses}
              workers={workers.data ?? []}
              onSelectWorktree={(worktreeId) => {
                if (projectOverviewGitProject) {
                  setProjectOverviewWorktreeId(worktreeId);
                  return;
                }
                if (
                  !selectedProjectView ||
                  selectedProjectView.kind !== "history"
                )
                  return;
                queryClient.setQueryData<ProjectViewSummary[]>(
                  ["project-views", selectedProjectView.projectId],
                  (current = []) =>
                    current.map((view) =>
                      view.id === selectedProjectView.id
                        ? { ...view, worktreeId }
                        : view,
                    ),
                );
                bindWorktreeMutation.mutate({
                  target: {
                    kind: "history",
                    projectId: selectedProjectView.projectId,
                    tabId: selectedProjectView.id,
                  },
                  worktreeId,
                });
              }}
              onSectionChange={
                projectOverviewGitProject && !projectOverviewPopoutTarget
                  ? setProjectOverviewSection
                  : undefined
              }
              onCreateChat={(worktreeId) =>
                newChat.mutate({
                  projectId: displayedGitProject.id,
                  worktreeId,
                  worktreeMode: "pinned",
                })
              }
              onCreateTerminal={(worktreeId) =>
                newTerminal.mutate({
                  projectId: displayedGitProject.id,
                  worktreeId,
                })
              }
              onCreateExplorer={(worktreeId) =>
                newExplorer.mutate({
                  projectId: displayedGitProject.id,
                  worktreeId,
                })
              }
              onCreateHistory={(worktreeId) =>
                newProjectView.mutate({
                  projectId: displayedGitProject.id,
                  kind: "history",
                  worktreeId,
                })
              }
              onOpenChat={(chatId) =>
                openCreatedTab(displayedGitProject.id, "chat", chatId)
              }
              onOpenGraphFile={(worktreeId, path) =>
                openProjectExplorerFile(
                  displayedGitProject.id,
                  worktreeId,
                  path,
                )
              }
              onHeaderChange={setGitHistoryHeader}
            />
          ) : selectedCodeTab ? null : selectedBrowser ? (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              }
            >
              <BrowserView
                browser={selectedBrowser}
                fleetDiscovery={
                  bootstrap.data?.capabilities.browserFleetDiscovery ?? false
                }
                onOpenService={(service: BrowserFleetService) =>
                  newBrowser.mutate({
                    projectId: selectedBrowser.projectId,
                    tabGroupId: selectedTabGroup?.id,
                    target: {
                      kind: "worker",
                      projectId: selectedBrowser.projectId,
                      workerId: service.workerId,
                    },
                    title:
                      service.title ??
                      service.processName ??
                      `Port ${service.port}`,
                    url: service.url,
                  })
                }
                onPageState={(state) => {
                  const input = browserUpdateForPageState(
                    selectedBrowser,
                    state,
                  );
                  if (input) {
                    updateBrowserMutation.mutate({
                      browserId: selectedBrowser.id,
                      input: {
                        ...input,
                        stateRevision: selectedBrowser.stateRevision,
                      },
                    });
                  }
                }}
              />
            </Suspense>
          ) : selectedExplorer ? null : selectedTerminal ? (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              }
            >
              {selectedTerminal.kind === "run-configuration" ? (
                <RunTerminalView
                  definitionAvailable={selectedRunDefinitionAvailable}
                  definitionProblem={
                    runConfigurations.isError
                      ? errorText(runConfigurations.error)
                      : null
                  }
                  launchAvailable={selectedRunLaunchAvailable}
                  launchProblem={selectedRunLaunchProblem}
                  runtime={selectedRunRuntime}
                  stopAvailable={selectedRunStopAvailable}
                  stopProblem={selectedRunStopProblem}
                  targetLabel={selectedRunTargetLabel}
                  terminal={selectedTerminal}
                  onEdit={
                    selectedRunDefinitionAvailable === true &&
                    selectedTerminal.runConfigurationId
                      ? () =>
                          setRunConfigurationEditorId(
                            selectedTerminal.runConfigurationId!,
                          )
                      : undefined
                  }
                />
              ) : linkedConsoleChat ? (
                <TerminalView
                  eliteContentGlitchEnabled={
                    (settings.data?.preferences.eliteMode ?? false) &&
                    (settings.data?.preferences.eliteRevealConfig
                      ?.glitchTerminalContents ??
                      DEFAULT_ELITE_REVEAL_CONFIG.glitchTerminalContents)
                  }
                  eliteRevealConfig={
                    settings.data?.preferences.eliteRevealConfig ??
                    DEFAULT_ELITE_REVEAL_CONFIG
                  }
                  terminal={selectedTerminal}
                  onExit={() => setChatConsoleOpen(linkedConsoleChat.id, false)}
                  onOpenExternalLink={openTerminalLinkExternally}
                  onOpenLink={openTerminalLink}
                />
              ) : (
                <TerminalView
                  eliteContentGlitchEnabled={
                    (settings.data?.preferences.eliteMode ?? false) &&
                    (settings.data?.preferences.eliteRevealConfig
                      ?.glitchTerminalContents ??
                      DEFAULT_ELITE_REVEAL_CONFIG.glitchTerminalContents)
                  }
                  eliteRevealConfig={
                    settings.data?.preferences.eliteRevealConfig ??
                    DEFAULT_ELITE_REVEAL_CONFIG
                  }
                  terminal={selectedTerminal}
                  commandPaletteOpen={
                    terminalCommandPaletteTerminalId === selectedTerminal.id
                  }
                  onCommandPaletteOpenChange={(open) =>
                    setTerminalCommandPaletteTerminalId(
                      open ? selectedTerminal.id : null,
                    )
                  }
                  servicePanelOpen={
                    terminalServiceTerminalId === selectedTerminal.id
                  }
                  onServicePanelOpenChange={(open) =>
                    setTerminalServiceTerminalId(
                      open ? selectedTerminal.id : null,
                    )
                  }
                  pendingInput={
                    pendingTerminalInputs.find(
                      ({ terminalId }: { terminalId: string }) =>
                        terminalId === selectedTerminal.id,
                    ) ?? null
                  }
                  onPendingInputSent={(inputId) =>
                    setPendingTerminalInputs(
                      (current: Array<{ id: string; terminalId: string }>) =>
                        current.filter(({ id }) => id !== inputId),
                    )
                  }
                  onOpenExternalLink={openTerminalLinkExternally}
                  onOpenLink={openTerminalLink}
                />
              )}
            </Suspense>
          ) : selectedChat ? (
            <ChatTranscript
              key={selectedChat.id}
              capabilities={IDE_CHAT_SURFACE_CAPABILITIES}
              chat={selectedChat}
              githubEnabled={selectedProject?.capabilities.github ?? false}
              inspectOnly={selectedChat.experience === "task"}
              inspectOpen={agentInspectOpenChats.has(selectedChat.id)}
              inspectOverlay={narrowViewport}
              settings={settings.data}
              syncEnabled
              onCreateChat={() =>
                newChat.mutate({ projectId: selectedChat.projectId })
              }
              onDelete={() => {
                setAgentInspectOpen(selectedChat.id, false);
                deleteChatMutation.mutate(selectedChat.id);
              }}
              onForked={(forked) => {
                if (forked.contextKind !== "standalone") {
                  openCreatedTab(forked.projectId, "chat", forked.id);
                }
              }}
              onInspectOpenChange={(open) =>
                setAgentInspectOpen(selectedChat.id, open)
              }
              onOpenFile={(reference) =>
                openChatFileLink(selectedChat, reference)
              }
              onOpenWorkflow={(workflowId) =>
                openProjectSettings(selectedChat.projectId, workflowId)
              }
              onOpenRelocation={() => setChatRelocationOpen(true)}
              onToast={showAppToast}
              onRename={(title) =>
                renameChatMutation.mutate({ chatId: selectedChat.id, title })
              }
              relocationJob={
                selectedProject?.capabilities.relocation
                  ? currentRelocation
                  : null
              }
              refocusOnWindowActivation={desktopRuntime}
            />
          ) : selectedProject ? (
            <ProjectOverviewHost>
              {selectedProject.setupStatus !== "ready" ? (
                <EmptyState>
                  <EmptyStateContent>
                    <EmptyStateIcon>
                      {selectedProject.setupStatus === "cloning" ||
                      (selectedProject.setupStatus === "preparing" &&
                        !selectedFolderSetupNeedsAttention) ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : selectedFolderSetupJob?.error?.code ===
                        "worker-offline" ? (
                        <WifiOff className="size-5 text-amber-500" />
                      ) : (
                        <CircleAlert className="size-5 text-destructive" />
                      )}
                    </EmptyStateIcon>
                    <EmptyStateTitle as="h1">
                      {selectedProject.setupStatus === "cloning"
                        ? "Cloning repository…"
                        : selectedProject.setupStatus === "preparing" &&
                            !selectedFolderSetupNeedsAttention
                          ? "Preparing folder…"
                          : selectedFolderSetupJob?.error?.code ===
                              "worker-offline"
                            ? "Owning worker offline"
                            : selectedProject.originKind === "managed-folder"
                              ? "Folder setup needs attention"
                              : "Repository setup failed"}
                    </EmptyStateTitle>
                    <EmptyStateDescription className="max-w-md">
                      {selectedProject.setupStatus === "cloning"
                        ? `${selectedProject.github?.nameWithOwner ?? selectedProject.name} is being prepared on the worker. You can keep adding other projects while it finishes.`
                        : selectedProject.setupStatus === "preparing" &&
                            !selectedFolderSetupNeedsAttention
                          ? `${selectedProject.name} is getting a new empty directory on its owning worker.`
                          : selectedLongPathSetupJob
                            ? "Git for Windows needs long-path support before this repository can be stored in Cantrip's managed AppData directory."
                            : selectedFolderSetupJob?.error
                              ? projectFolderSetupErrorMessage(
                                  selectedFolderSetupJob.error.code,
                                )
                              : (projectSetupErrorMessage(
                                  selectedProject.setupError,
                                ) ??
                                "The worker could not prepare this project.")}
                    </EmptyStateDescription>
                    {selectedProject.setupStatus === "cloning" ? (
                      <div className="mx-auto mt-4 w-full max-w-sm text-left">
                        <div
                          aria-label="Repository clone progress"
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={projectSetupPercent(
                            selectedProjectSetupJob,
                          )}
                          className="h-1.5 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                        >
                          <div
                            className={cn(
                              "h-full rounded-full bg-primary transition-[width] duration-500",
                              !selectedProjectSetupJob && "animate-pulse",
                            )}
                            style={{
                              width: `${projectSetupPercent(selectedProjectSetupJob)}%`,
                            }}
                          />
                        </div>
                        <div className="mt-2 flex items-start justify-between gap-3 text-xs text-muted-foreground">
                          <span>
                            {selectedProjectSetupJob
                              ? projectReplicaProgressMessage(
                                  selectedProjectSetupJob.progress.stage,
                                )
                              : "Waiting for the worker to start cloning."}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {selectedProjectSetupJob
                              ? `${selectedProjectSetupJob.progress.percent}%`
                              : "Starting"}
                          </span>
                        </div>
                      </div>
                    ) : selectedProject.originKind === "managed-folder" &&
                      selectedFolderSetupNeedsAttention ? (
                      <div className="mx-auto mt-4 max-w-md space-y-3">
                        <p className="text-xs leading-5 text-muted-foreground">
                          This folder is worker-bound. Cantrip will not move it
                          to another worker;{" "}
                          {selectedFolderSetupJob?.error?.code ===
                          "worker-offline"
                            ? "bring the owning worker online and retry."
                            : "resolve the reported setup problem on the owning worker."}
                        </p>
                        {selectedFolderSetupJob?.error?.retryable ? (
                          <Button
                            disabled={retryFolderSetupMutation.isPending}
                            onClick={() =>
                              retryFolderSetupMutation.mutate({
                                projectId: selectedProject.id,
                                stateRevision:
                                  selectedFolderSetupJob.stateRevision,
                              })
                            }
                          >
                            {retryFolderSetupMutation.isPending ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <RefreshCw className="size-4" />
                            )}
                            Retry on owning worker
                          </Button>
                        ) : null}
                        {retryFolderSetupMutation.isError ? (
                          <p className="text-xs text-destructive">
                            {errorText(retryFolderSetupMutation.error)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </EmptyStateContent>
                </EmptyState>
              ) : projectOverviewSelected ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  {!projectOverviewPopoutTarget ? (
                    <div className="relative flex h-10 shrink-0 items-center px-3">
                      <ProjectOverviewNavigation
                        activeTab={activeProjectOverviewSection}
                        githubEnabled={projectHasGithubCapability(
                          selectedProject,
                        )}
                        gitEnabled={selectedProject.capabilities.git}
                        onTabChange={(section) => {
                          if (
                            section === "tasks" &&
                            activeProjectOverviewSection === "tasks" &&
                            activeProjectTaskChatId &&
                            !projectTaskIsUnqueuedDraft(
                              queryClient.getQueryData<TaskDetail>([
                                "task",
                                activeProjectTaskChatId,
                              ]),
                            )
                          ) {
                            closeProjectTask(selectedProject.id);
                            return;
                          }
                          setProjectOverviewSection(section);
                        }}
                      />
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" />
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "min-h-0 flex-1 flex-col",
                      activeProjectOverviewSection === "tasks" &&
                        activeProjectTaskView === "task"
                        ? "flex"
                        : "hidden",
                    )}
                  >
                    <ProjectTasksDashboard
                      active={
                        activeProjectOverviewSection === "tasks" &&
                        activeProjectTaskView === "task"
                      }
                      activeTaskChatId={
                        projectTaskChatIds.get(selectedProject.id) ?? null
                      }
                      chats={chats.data ?? []}
                      creatingTask={newTask.isPending}
                      projectId={selectedProject.id}
                      settings={settings.data}
                      taskCreationError={newTask.error}
                      workers={workers.data ?? []}
                      onConfigureWorkers={() =>
                        openCompactRootSettings("tasks")
                      }
                      onCreateTask={() =>
                        newTask.mutate({ projectId: selectedProject.id })
                      }
                      onCloseTask={() => closeProjectTask(selectedProject.id)}
                      onOpenTask={(chatId) =>
                        openProjectTask(selectedProject.id, chatId)
                      }
                      onRenameTask={(chatId, title) =>
                        renameChatMutation.mutate({ chatId, title })
                      }
                    />
                  </div>
                  {activeProjectOverviewSection === "tasks" &&
                  activeProjectTaskView === "chat" &&
                  activeProjectTaskChat ? (
                    <ChatTranscript
                      key={`task-chat-${activeProjectTaskChat.id}`}
                      capabilities={IDE_CHAT_SURFACE_CAPABILITIES}
                      chat={activeProjectTaskChat}
                      githubEnabled={
                        selectedProject?.capabilities.github ?? false
                      }
                      inspectOnly
                      inspectOpen={agentInspectOpenChats.has(
                        activeProjectTaskChat.id,
                      )}
                      inspectOverlay={narrowViewport}
                      settings={settings.data}
                      syncEnabled
                      onCreateChat={() =>
                        newChat.mutate({
                          projectId: activeProjectTaskChat.projectId,
                        })
                      }
                      onDelete={() => {
                        setAgentInspectOpen(activeProjectTaskChat.id, false);
                        deleteChatMutation.mutate(activeProjectTaskChat.id);
                      }}
                      onForked={(forked) => {
                        if (forked.contextKind !== "standalone") {
                          openCreatedTab(forked.projectId, "chat", forked.id);
                        }
                      }}
                      onInspectOpenChange={(open) =>
                        setAgentInspectOpen(activeProjectTaskChat.id, open)
                      }
                      onOpenFile={(reference) =>
                        openChatFileLink(activeProjectTaskChat, reference)
                      }
                      onOpenWorkflow={(workflowId) =>
                        openProjectSettings(
                          activeProjectTaskChat.projectId,
                          workflowId,
                        )
                      }
                      onOpenRelocation={() => setChatRelocationOpen(true)}
                      onToast={showAppToast}
                      onRename={(title) =>
                        renameChatMutation.mutate({
                          chatId: activeProjectTaskChat.id,
                          title,
                        })
                      }
                      relocationJob={
                        selectedProject?.capabilities.relocation
                          ? currentRelocation
                          : null
                      }
                      refocusOnWindowActivation={desktopRuntime}
                    />
                  ) : null}
                  {activeProjectOverviewSection !== "tasks" ? (
                    <ProjectOverview
                      compact={compactShell}
                      creatingKinds={creatingSurfaceKinds}
                      project={selectedProject}
                      stats={repositoryStats.data}
                      statsError={
                        repositoryStats.isError
                          ? errorText(repositoryStats.error)
                          : null
                      }
                      statsLoading={repositoryStats.isLoading}
                      usage={projectTokenUsage.data}
                      usageError={
                        projectTokenUsage.isError
                          ? errorText(projectTokenUsage.error)
                          : null
                      }
                      usageLoading={projectTokenUsage.isLoading}
                      surfaces={projectSurfaces}
                      workerOnline={Boolean(
                        workers.data?.find(
                          ({ workerId }: { workerId: string }) =>
                            workerId === selectedProjectWorkerId,
                        )?.online,
                      )}
                      worktrees={worktrees.data ?? []}
                      onCreateSurface={(kind, target) =>
                        createProjectSurface(
                          selectedProject.id,
                          kind,
                          undefined,
                          target,
                        )
                      }
                      placement={selectedPlacementContext}
                      onOpenSurface={selectTopTab}
                      onOpenTabs={() => setMobileTabGridOpen(true)}
                      onRevealProject={(preferLocalFolder) =>
                        revealProjectInNativeFileManager(
                          selectedProject,
                          preferLocalFolder,
                        )
                      }
                      revealLabel={projectRevealButtonLabel ?? undefined}
                    />
                  ) : null}
                </div>
              ) : (
                <EmptyState>
                  <EmptyStateContent>
                    <EmptyStateIcon>
                      <SquareTerminal className="size-5" />
                    </EmptyStateIcon>
                    <EmptyStateTitle as="h1">No tabs yet</EmptyStateTitle>
                    <EmptyStateDescription>
                      Start a Codex agent, shell, file explorer, Code workspace,
                      or browser in {selectedProject.name}.
                    </EmptyStateDescription>
                    <EmptyStateActions>
                      <Button
                        disabled={newChat.isPending || !selectedProject.source}
                        onClick={() =>
                          newChat.mutate({ projectId: selectedProject.id })
                        }
                      >
                        {newChat.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Plus className="size-4" />
                        )}
                        Agent
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          newTerminal.isPending || !selectedProject.source
                        }
                        onClick={() =>
                          newTerminal.mutate({ projectId: selectedProject.id })
                        }
                      >
                        {newTerminal.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Plus className="size-4" />
                        )}
                        Terminal
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          newExplorer.isPending || !selectedProject.source
                        }
                        onClick={() =>
                          newExplorer.mutate({ projectId: selectedProject.id })
                        }
                      >
                        {newExplorer.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <FolderTree className="size-4" />
                        )}
                        Explorer
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          newBrowser.isPending || !selectedProject.source
                        }
                        onClick={() =>
                          newBrowser.mutate({ projectId: selectedProject.id })
                        }
                      >
                        {newBrowser.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Globe2 className="size-4" />
                        )}
                        Browser
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          newCodeTab.isPending || !selectedProject.source
                        }
                        onClick={() =>
                          newCodeTab.mutate({ projectId: selectedProject.id })
                        }
                      >
                        {newCodeTab.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Code2 className="size-4" />
                        )}
                        Code
                      </Button>
                    </EmptyStateActions>
                  </EmptyStateContent>
                </EmptyState>
              )}
            </ProjectOverviewHost>
          ) : (
            <EmptyState>
              <EmptyStateContent>
                <EmptyStateIcon>
                  <Folder className="size-5" />
                </EmptyStateIcon>
                <EmptyStateTitle as="h1">
                  Add your first project
                </EmptyStateTitle>
                <EmptyStateDescription>
                  Create a new worker-bound folder or clone an accessible GitHub
                  repository.
                </EmptyStateDescription>
                <EmptyStateActions>
                  <ProjectCreateMenu onSelect={openProjectCreateSource}>
                    <Button>
                      <Plus className="size-4" />
                      New project
                    </Button>
                  </ProjectCreateMenu>
                </EmptyStateActions>
              </EmptyStateContent>
            </EmptyState>
          )}
        </ProjectSurfaceHost>
      )}
      {appMode === "ide" &&
      compactShell &&
      selectedProject &&
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings ? (
        <MobileBottomNavigation
          activeItemId={activeMobileBottomTabId}
          gridOpen={mobileTabGridOpen}
          items={mobileBottomNavigationItems}
          onAdd={addMobileBottomTab}
          onOverview={selectMobileOverview}
          onRemove={removeMobileBottomTabById}
          onReset={openMobileBottomTabSwitcher}
          onSelect={selectMobileBottomTab}
          overviewSelected={
            !mobileTabGridOpen && workspaceSelection.destination === "overview"
          }
        />
      ) : null}
    </>
  );
}
