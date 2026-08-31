import {
  MessageSquare,
  PanelLeftClose,
  Settings,
  WandSparkles,
} from "lucide-react";
import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import { StatusDot } from "@/components/app/status-dot";
import { explorerRepositoryGraphAvailable } from "@/components/explorer/explorer-graph-routing";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { StandaloneChatSidebar } from "@/components/sidebar/standalone-chat-sidebar";
import { ProjectSwitcher } from "@/components/projects/project-switcher";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import { errorMessage as errorText } from "@/lib/error-message";
import { Button } from "@/components/ui/button";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/lib/sidebar-resize";
import { cn } from "@/lib/utils";
type ShellSidebarBindings = Readonly<Record<string, any>>;

export function ShellSidebar({ bindings }: { bindings: ShellSidebarBindings }) {
  const {
    activeProjectWorkspace,
    appMode,
    archiveStandaloneChat,
    archivedStandaloneChats,
    beginSidebarResize,
    bindChatWorktree,
    bootstrap,
    browsers,
    chats,
    codeTabs,
    createProjectSurface,
    createSidebarExplorerMutation,
    creatingSurfaceKinds,
    deleteBrowserMutation,
    deleteChatMutation,
    deleteCodeTabMutation,
    deleteExplorerMutation,
    deleteProjectViewMutation,
    deleteSidebarFileEntry,
    deleteTerminalMutation,
    desktopSidebarDrawer,
    desktopSidebarDrawerOpen,
    displayTerminals,
    explorers,
    finishSidebarResize,
    folderSetupJobs,
    forkChatMutation,
    forkStandaloneChat,
    isPopout,
    moveSidebarResize,
    newStandaloneChat,
    onlineWorker,
    openChatExplorerHere,
    openChatHistoryHere,
    openChatTerminalHere,
    openProjectCreateSource,
    openProjectSettings,
    openServerAdmin,
    openSidebarFilePreview,
    openSidebarFolderGraph,
    openSidebarFolderNative,
    openSidebarFolderTerminal,
    overlayTitlebar,
    permanentlyDeleteStandaloneChat,
    pinSidebarFile,
    pinSidebarFileMutation,
    projectOverviewSelected,
    projectSidebarSurfaces,
    projectRevealButtonLabel,
    projectRevealLabel,
    projectSetupJobs,
    projectViews,
    projectWorkspaces,
    projects,
    removeProjectMutation,
    renameChatMutation,
    renameExplorerMutation,
    renameProjectViewMutation,
    renameSidebarFileEntry,
    renameStandaloneChat,
    renameTerminalMutation,
    requestDeleteExplorer,
    resizeSidebarWithKeyboard,
    restoreStandaloneChat,
    retrySidebarFileTree,
    selectTopTab,
    selectProjectFromSidebar,
    selectProjectWorkspace,
    selectStandaloneChat,
    selectedExplorer,
    selectedPlacementContext,
    selectedProject,
    selectedProjectId,
    selectedStandaloneChatId,
    selectedTabKey,
    setDesktopSidebarDrawerOpen,
    setSettingsSection,
    setShowArchivedStandaloneChats,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
    setSidebarCollapsed,
    setWorktreeCreateTarget,
    showArchivedStandaloneChats,
    sidebarCollapsed,
    sidebarExpanded,
    sidebarExplorer,
    sidebarFilePinHandoff,
    sidebarFilePreview,
    sidebarFileWorkbenchReady,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
    sidebarRef,
    sidebarResizing,
    sidebarWidth,
    standaloneChatCreationAvailable,
    standaloneChatCreationUnavailableReason,
    standaloneChats,
    stopAndDeleteRunTerminalMutation,
    switchToChat,
    switchToIde,
    tabLayout,
    updateBrowserMutation,
    updateCodeTabMutation,
    workers,
    worktreeStatuses,
    worktrees,
  } = bindings;
  return (
    <>
      {!isPopout ? (
        <div
          data-slot="app-sidebar-shell"
          role={desktopSidebarDrawer ? "dialog" : undefined}
          aria-label={desktopSidebarDrawer ? "Cantrip sidebar" : undefined}
          aria-modal={desktopSidebarDrawer ? true : undefined}
          className={cn(
            "group/sidebar-shell shrink-0",
            desktopSidebarDrawer
              ? desktopSidebarDrawerOpen
                ? "fixed inset-0 z-[80] block"
                : "hidden"
              : "relative hidden md:block",
            sidebarResizing
              ? "transition-none"
              : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            width: desktopSidebarDrawer
              ? undefined
              : sidebarCollapsed
                ? 0
                : sidebarWidth,
          }}
        >
          {desktopSidebarDrawer ? (
            <button
              type="button"
              aria-label="Close sidebar"
              className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
              onClick={() => setDesktopSidebarDrawerOpen(false)}
              tabIndex={-1}
            />
          ) : null}
          <aside
            ref={sidebarRef}
            data-slot="app-sidebar"
            data-state={sidebarExpanded ? "expanded" : "collapsed"}
            aria-hidden={!sidebarExpanded}
            inert={!sidebarExpanded}
            tabIndex={desktopSidebarDrawer ? -1 : undefined}
            className={cn(
              "group/sidebar absolute inset-y-0 left-0 z-10 flex flex-col bg-background transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
              desktopSidebarDrawer &&
                "max-w-[calc(100vw-3rem)] border-r shadow-2xl",
              sidebarExpanded
                ? "translate-x-0 opacity-100"
                : "pointer-events-none -translate-x-2 opacity-0",
            )}
            style={{ width: sidebarWidth }}
          >
            <div
              className={
                overlayTitlebar
                  ? "flex h-8 items-center gap-1.5 pl-20 pr-2"
                  : "flex h-16 items-center gap-3 px-4"
              }
              data-slot="sidebar-titlebar"
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <div
                className={
                  overlayTitlebar
                    ? "grid size-5 place-items-center"
                    : "grid size-9 place-items-center"
                }
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                <WandSparkles
                  className={overlayTitlebar ? "size-3" : "size-4"}
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                />
              </div>
              <div
                className="min-w-0 flex-1"
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                <p
                  className={cn(
                    "font-semibold tracking-tight",
                    overlayTitlebar && "text-xs leading-none",
                  )}
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                >
                  Cantrip
                </p>
              </div>
              {!overlayTitlebar ? (
                <StatusDot online={Boolean(onlineWorker)} />
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className={overlayTitlebar ? "size-6" : "size-8"}
                onClick={() =>
                  desktopSidebarDrawer
                    ? setDesktopSidebarDrawerOpen(false)
                    : setSidebarCollapsed(true)
                }
                title={
                  desktopSidebarDrawer ? "Close sidebar" : "Collapse sidebar"
                }
              >
                <PanelLeftClose
                  className={overlayTitlebar ? "size-3" : "size-4"}
                />
                <span className="sr-only">
                  {desktopSidebarDrawer ? "Close sidebar" : "Collapse sidebar"}
                </span>
              </Button>
            </div>

            {appMode === "chat" ? (
              <StandaloneChatSidebar
                archivedCount={archivedStandaloneChats.data?.length ?? 0}
                archivedSelected={showArchivedStandaloneChats}
                chats={standaloneChats.data ?? []}
                creationDisabled={!standaloneChatCreationAvailable}
                creationUnavailableReason={
                  standaloneChatCreationUnavailableReason
                }
                creating={newStandaloneChat.isPending}
                error={
                  standaloneChats.error ??
                  newStandaloneChat.error ??
                  renameStandaloneChat.error ??
                  forkStandaloneChat.error ??
                  archiveStandaloneChat.error ??
                  restoreStandaloneChat.error ??
                  permanentlyDeleteStandaloneChat.error
                }
                selectedChatId={
                  showArchivedStandaloneChats ? null : selectedStandaloneChatId
                }
                workers={workers.data ?? []}
                onArchive={(chat) => archiveStandaloneChat.mutate(chat)}
                onFork={(chat) => forkStandaloneChat.mutate(chat)}
                onNewChat={() => newStandaloneChat.mutate()}
                onOpenArchived={() => {
                  setDesktopSidebarDrawerOpen(false);
                  setShowArchivedStandaloneChats(true);
                  setShowSettings(false);
                  setShowServerAdmin(false);
                }}
                onOpenSettings={() => {
                  setDesktopSidebarDrawerOpen(false);
                  setSettingsSection("general");
                  setShowSettings(true);
                  setShowArchivedStandaloneChats(false);
                  setShowServerAdmin(false);
                }}
                onRename={(chat, title) =>
                  renameStandaloneChat.mutate({ chatId: chat.id, title })
                }
                onSelect={selectStandaloneChat}
                onSwitchIde={switchToIde}
              />
            ) : (
              <>
                <div className="px-3 pb-0 pt-4">
                  <Button
                    className="w-full justify-start"
                    variant="ghost"
                    onClick={switchToChat}
                  >
                    <MessageSquare className="size-4" /> Chats
                  </Button>
                </div>
                <div className="px-3 pb-2 pt-2">
                  <ProjectSwitcher
                    activeWorkspaceId={activeProjectWorkspace?.id ?? null}
                    projects={projects.data ?? []}
                    selectedProjectId={selectedProjectId}
                    workspaces={projectWorkspaces.data ?? []}
                    onSelectWorkspace={selectProjectWorkspace}
                    onSelectProject={selectProjectFromSidebar}
                    creatingTabKinds={creatingSurfaceKinds}
                    onAddProject={openProjectCreateSource}
                    onCreateTab={(kind, target) => {
                      if (selectedProject) {
                        createProjectSurface(
                          selectedProject.id,
                          kind,
                          undefined,
                          target,
                        );
                      }
                    }}
                    onManageWorkspaces={() => {
                      setDesktopSidebarDrawerOpen(false);
                      setSettingsSection("workspaces");
                      setShowSettings(true);
                      setShowServerAdmin(false);
                      setShowImporter(false);
                      setShowProjectSettings(false);
                    }}
                    tabPlacement={selectedPlacementContext}
                  />
                </div>

                <nav
                  className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
                  data-slot="sidebar-scroll-region"
                >
                  <ProjectChatList
                    browsers={browsers.data ?? []}
                    folderSetupJobs={folderSetupJobs}
                    projects={projects.data ?? []}
                    projectSetupJobs={projectSetupJobs}
                    chats={chats.data ?? []}
                    codeTabs={codeTabs.data ?? []}
                    explorers={explorers.data ?? []}
                    projectViews={projectViews.data ?? []}
                    surfaces={projectSidebarSurfaces}
                    terminals={displayTerminals}
                    workers={workers.data ?? []}
                    worktrees={worktrees.data ?? []}
                    worktreeStatuses={worktreeStatuses}
                    overviewSelected={projectOverviewSelected}
                    selectedProjectId={selectedProjectId}
                    selectedTabKey={selectedTabKey}
                    tabLayout={tabLayout.data ?? null}
                    fileExplorer={sidebarExplorer}
                    filePreviewReady={sidebarFileWorkbenchReady}
                    fileGraphAvailable={explorerRepositoryGraphAvailable(
                      selectedProject?.capabilities,
                    )}
                    filePreviewPath={
                      sidebarFilePreview &&
                      sidebarFilePreview.explorerId === sidebarExplorer?.id
                        ? sidebarFilePreview.path
                        : (selectedExplorer?.selectedPath ?? null)
                    }
                    fileTreeError={
                      !sidebarExplorer && createSidebarExplorerMutation.isError
                        ? errorText(createSidebarExplorerMutation.error)
                        : null
                    }
                    fileTreeLoading={
                      explorers.isLoading ||
                      createSidebarExplorerMutation.isPending ||
                      pinSidebarFileMutation.isPending
                    }
                    fileTreePinningPath={
                      pinSidebarFileMutation.isPending
                        ? (pinSidebarFileMutation.variables?.path ?? null)
                        : (sidebarFilePinHandoff?.sourcePath ?? null)
                    }
                    fileTreeWorkerId={sidebarFileWorkerId}
                    fileTreeWorkerOnline={sidebarFileWorkerOnline}
                    fileRevealLabel={projectRevealButtonLabel ?? undefined}
                    onChangeChatWorktree={(chatId, worktreeId, mode) => {
                      const chat = chats.data?.find(
                        ({ id }: { id: string }) => id === chatId,
                      );
                      if (chat) bindChatWorktree(chat, worktreeId, mode);
                    }}
                    onRequestChatWorktreeCreate={(chat) =>
                      setWorktreeCreateTarget({
                        kind: "chat",
                        projectId: chat.projectId,
                        tabId: chat.id,
                        mode: chat.worktreeMode,
                      })
                    }
                    onOpenChatTerminal={openChatTerminalHere}
                    onOpenChatExplorer={openChatExplorerHere}
                    onOpenChatHistory={openChatHistoryHere}
                    onFilePin={pinSidebarFile}
                    onFileDelete={deleteSidebarFileEntry}
                    onFileOpenGraph={openSidebarFolderGraph}
                    onFileOpenNative={openSidebarFolderNative}
                    onFileOpenTerminal={openSidebarFolderTerminal}
                    onFilePreview={openSidebarFilePreview}
                    onFileRename={renameSidebarFileEntry}
                    onFileTreeRetry={retrySidebarFileTree}
                    onRenameChat={(chatId, title) =>
                      renameChatMutation.mutate({ chatId, title })
                    }
                    onDuplicateChat={(chatId) =>
                      forkChatMutation.mutate(chatId)
                    }
                    onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
                    onRenameCode={(codeTabId, title) =>
                      updateCodeTabMutation.mutate({ codeTabId, title })
                    }
                    onDeleteCode={(codeTabId) =>
                      deleteCodeTabMutation.mutate(codeTabId)
                    }
                    onRenameBrowser={(browserId, title) =>
                      updateBrowserMutation.mutate({
                        browserId,
                        input: { title },
                      })
                    }
                    onDeleteBrowser={(browserId) =>
                      deleteBrowserMutation.mutate(browserId)
                    }
                    onRenameExplorer={(explorerId, title) =>
                      renameExplorerMutation.mutate({ explorerId, title })
                    }
                    onDeleteExplorer={requestDeleteExplorer}
                    onCloseExplorer={(explorerId) =>
                      deleteExplorerMutation.mutate(explorerId)
                    }
                    onRenameProjectView={(viewId, title) =>
                      renameProjectViewMutation.mutate({ viewId, title })
                    }
                    onDeleteProjectView={(viewId) =>
                      deleteProjectViewMutation.mutate(viewId)
                    }
                    onRenameTerminal={(terminalId, title) =>
                      renameTerminalMutation.mutate({ terminalId, title })
                    }
                    onDeleteTerminal={(terminalId) =>
                      deleteTerminalMutation.mutate(terminalId)
                    }
                    onStopAndCloseRunTerminal={(terminal) =>
                      stopAndDeleteRunTerminalMutation
                        .mutateAsync(terminal)
                        .then(() => undefined)
                    }
                    onRemoveProject={(projectId, deleteLocalFiles) =>
                      removeProjectMutation
                        .mutateAsync({ projectId, deleteLocalFiles })
                        .then(() => undefined)
                    }
                    onOpenProjectSettings={openProjectSettings}
                    projectRevealLabel={projectRevealLabel ?? undefined}
                    onRevealProject={(project, localFolder) =>
                      revealProjectInNativeFileManager(
                        project,
                        localFolder,
                        "",
                        worktrees.data?.find(
                          (worktree: ProjectWorktreeSummary) =>
                            worktree.projectSourceId === project.source?.id &&
                            worktree.isPrimary,
                        ),
                      )
                    }
                    onSelectProject={selectProjectFromSidebar}
                    onSelectTab={selectTopTab}
                  />
                </nav>
              </>
            )}

            <div className="p-3">
              <div className="flex items-center gap-1">
                <ServerSwitcher
                  currentUserName={
                    bootstrap.data?.auth.currentUser?.displayName ??
                    "Cantrip User"
                  }
                  onOpenAdmin={openServerAdmin}
                  workerName={onlineWorker?.name ?? "Worker offline"}
                />
                {appMode === "ide" ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    onClick={() => {
                      setDesktopSidebarDrawerOpen(false);
                      setSettingsSection("general");
                      setShowSettings(true);
                      setShowServerAdmin(false);
                      setShowImporter(false);
                      setShowProjectSettings(false);
                    }}
                  >
                    <Settings className="size-4" />
                    <span className="sr-only">Open settings</span>
                  </Button>
                ) : null}
              </div>
            </div>
          </aside>
          {!desktopSidebarDrawer ? (
            <div
              data-slot="sidebar-resize-handle"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuenow={sidebarWidth}
              tabIndex={sidebarCollapsed ? -1 : 0}
              title="Drag to resize sidebar"
              className={cn(
                "absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize touch-none outline-none",
                "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:opacity-0 after:transition-opacity after:duration-150",
                "group-hover/sidebar-shell:after:opacity-100 hover:after:opacity-100 focus-visible:after:opacity-100",
                sidebarCollapsed && "pointer-events-none opacity-0",
                sidebarResizing && "after:opacity-100",
              )}
              onKeyDown={resizeSidebarWithKeyboard}
              onPointerDown={beginSidebarResize}
              onPointerMove={moveSidebarResize}
              onPointerUp={(event) => finishSidebarResize(event, true)}
              onPointerCancel={(event) => finishSidebarResize(event, false)}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
