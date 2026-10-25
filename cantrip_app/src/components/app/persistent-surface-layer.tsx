import { chatConsoleTerminal } from "@/components/chat/chat-console-state";
import { PersistentChatViews } from "@/components/chat/persistent-chat-views";
import { PersistentRemoteDesktopViews } from "@/components/remote-desktop/persistent-remote-desktop-views";
import { WorkspaceChatPanel } from "@/components/chat/workspace-chat-panel";
import type { ProjectSummary } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { Suspense, useMemo, useSyncExternalStore } from "react";
import {
  PersistentCodeViews,
  PersistentExplorerViews,
  PersistentFileDocumentViews,
  PersistentTerminalViews,
  PersistentBrowserViews,
} from "@/components/app/application-shell-surfaces";
import { explorerRepositoryGraphAvailable } from "@/components/explorer/explorer-graph-routing";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import { ProjectPaneTabStrip } from "@/components/workspace/project-tab-bar";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
type PersistentSurfaceBindings = Readonly<Record<string, any>>;
const browserSessionKey = () =>
  JSON.stringify(getClientSessionIdentitySnapshot());
const subscribeBrowserSession = (listener: () => void) =>
  onClientSessionIdentityChanged(listener);

export function PersistentSurfaceLayer({
  bindings,
}: {
  bindings: PersistentSurfaceBindings;
}) {
  const sessionKey = useSyncExternalStore(
    subscribeBrowserSession,
    browserSessionKey,
    browserSessionKey,
  );
  const {
    activeProjectTaskChat,
    chatConsoleOpenChats,
    appMode,
    codeAppearance,
    codeSurfaceVisible,
    compactShell,
    closeSurfaceView,
    keepSurfaceOpen,
    createProjectSurface,
    creatingSurfaceKinds,
    deleteSurfaceResource,
    desktopRuntime,
    dockPanePresentations,
    explorerGraphRequest,
    explorerSurfaceVisible,
    excludedPersistentSurfaceIds,
    folderRevealLabel,
    selectedPaneOwnedElsewhere,
    handleExplorerChanged,
    stagedExplorerTransfers,
    stagedCodeTransfers,
    stagedTerminalTransfers,
    incomingTerminalViews,
    incomingExplorerViews,
    incomingFileDocumentViews,
    incomingCodeViews,
    migratedCodeTabIds,
    handleExplorerLifecycleChange,
    isPopout,
    newTerminal,
    onlineWorkerIds,
    openExplorerFileWindow,
    openExplorers,
    openProjectExplorerFile,
    persistFileViewMode,
    openTerminalLink,
    openTerminalLinkExternally,
    ownedTerminals,
    pendingTerminalInputs,
    selectedPaneSurfaces,
    projects,
    projectSurfaces,
    queryClient,
    renameSurface,
    selectTopTab,
    selectedCodeTab,
    selectedExplorer,
    selectedPlacementContext,
    selectedProject,
    selectedProjectId,
    selectedSurface,
    selectedPane,
    selectedTabKey,
    selectedTerminal,
    setChatConsoleOpen,
    setCodeHeader,
    setExplorerHeader,
    setPendingTerminalInputs,
    setTerminalCommandPaletteTerminalId,
    setTerminalServiceTerminalId,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    terminalCommandPaletteTerminalId,
    terminalServiceTerminalId,
    terminalSurfaceVisible,
    terminals,
    worktreeStatuses,
    worktrees,
  } = bindings;
  const surfaceDockPanePresentations = dockPanePresentations;
  const dockCodePlacements = useMemo(
    () =>
      surfaceDockPanePresentations?.flatMap((presentation: any) =>
        presentation.activeSurface?.kind === "code"
          ? [
              {
                focused: presentation.focused,
                gridArea: presentation.gridArea,
                paneId: presentation.pane.id,
                portalTarget: presentation.portalTarget,
                tab: presentation.activeSurface.entity,
              },
            ]
          : [],
      ),
    [surfaceDockPanePresentations],
  );
  const desktopOwners = useMemo(
    () =>
      projectSurfaces?.flatMap((surface: any) => {
        if (excludedPersistentSurfaceIds?.has(surface.tabKey)) return [];
        if (surface.kind === "remote-desktop")
          return [
            {
              tabId: surface.tabKey,
              resourceId: surface.entity.id,
              projectId: surface.entity.projectId,
            },
          ];
        if (
          surface.kind === "unresolved" &&
          surface.member.tabKind === "remote-desktop" &&
          selectedProjectId
        )
          return [
            {
              tabId: surface.tabKey,
              resourceId: surface.member.tabId,
              projectId: selectedProjectId,
            },
          ];
        return [];
      }) ?? [],
    [projectSurfaces, excludedPersistentSurfaceIds, selectedProjectId],
  );
  const desktopPlacements = useMemo(
    () =>
      surfaceDockPanePresentations?.flatMap((presentation: any) =>
        presentation.activeSurface?.kind === "remote-desktop"
          ? [
              {
                tabId: presentation.activeSurface.tabKey,
                portalTarget: presentation.portalTarget,
              },
            ]
          : [],
      ),
    [surfaceDockPanePresentations],
  );
  const chatOwners = useMemo(
    () =>
      projectSurfaces?.flatMap((surface: any) =>
        excludedPersistentSurfaceIds?.has(surface.tabKey)
          ? []
          : surface.kind === "chat"
            ? [
                {
                  tabId: surface.tabKey,
                  resourceId: surface.entity.id,
                  chat: surface.entity,
                },
              ]
            : surface.kind === "unresolved" && surface.member.tabKind === "chat"
              ? [{ tabId: surface.tabKey, resourceId: surface.member.tabId }]
              : [],
      ) ?? [],
    [projectSurfaces, excludedPersistentSurfaceIds],
  );
  const chatPlacements = useMemo(
    () =>
      surfaceDockPanePresentations?.flatMap((presentation: any) =>
        presentation.activeSurface?.kind === "chat"
          ? [
              {
                tabId: presentation.activeSurface.tabKey,
                portalTarget: presentation.portalTarget,
              },
            ]
          : [],
      ),
    [surfaceDockPanePresentations],
  );
  const browserOwners = useMemo(
    () =>
      projectSurfaces?.flatMap((surface: any) =>
        excludedPersistentSurfaceIds?.has(surface.tabId)
          ? []
          : surface.kind === "browser"
            ? [
                {
                  tabId: surface.tabKey,
                  resourceId: surface.entity.id,
                  browser: surface.entity,
                },
              ]
            : surface.kind === "unresolved" &&
                surface.member.tabKind === "browser"
              ? [{ tabId: surface.tabKey, resourceId: surface.member.tabId }]
              : [],
      ) ?? [],
    [projectSurfaces, excludedPersistentSurfaceIds],
  );
  const browserPlacements = useMemo(
    () =>
      surfaceDockPanePresentations?.flatMap((presentation: any) =>
        presentation.activeSurface?.kind === "browser"
          ? [
              {
                tabId: presentation.activeSurface.tabKey,
                paneId: presentation.pane.id,
                portalTarget: presentation.portalTarget,
              },
            ]
          : [],
      ),
    [surfaceDockPanePresentations],
  );
  const dockTerminalPlacements = useMemo(
    () =>
      surfaceDockPanePresentations?.flatMap((presentation: any) => {
        const surface = presentation.activeSurface;
        const chat =
          presentation.focused && activeProjectTaskChat
            ? activeProjectTaskChat
            : surface?.kind === "chat"
              ? surface.entity
              : undefined;
        const terminal =
          surface?.kind === "terminal"
            ? surface.entity
            : chatConsoleTerminal(
                chat?.id,
                chatConsoleOpenChats,
                terminals?.data,
              );
        return terminal && terminal.kind !== "run-configuration"
          ? [
              {
                focused: presentation.focused,
                gridArea: presentation.gridArea,
                paneId: presentation.pane.id,
                portalTarget: presentation.portalTarget,
                terminal,
              },
            ]
          : [];
      }),
    [
      surfaceDockPanePresentations,
      activeProjectTaskChat,
      chatConsoleOpenChats,
      terminals?.data,
    ],
  );
  const dockExplorerPlacements = useMemo(() => {
    const placements = surfaceDockPanePresentations?.flatMap(
      (presentation: any) =>
        presentation.activeSurface?.kind === "explorer"
          ? [
              {
                explorer: presentation.activeSurface.entity,
                focused: presentation.focused,
                gridArea: presentation.gridArea,
                paneId: presentation.pane.id,
                portalTarget: presentation.portalTarget,
              },
            ]
          : [],
    );
    return placements;
  }, [surfaceDockPanePresentations]);
  return (
    <>
      <PersistentRemoteDesktopViews
        key={`desktop:${sessionKey}`}
        owners={desktopOwners}
        selectedTabId={
          appMode === "ide" &&
          !showImporter &&
          !showSettings &&
          !bindings.showProjectOverview &&
          !showArchivedStandaloneChats &&
          !showServerAdmin &&
          !showProjectSettings &&
          !selectedPaneOwnedElsewhere
            ? (selectedTabKey ?? null)
            : null
        }
        placements={desktopPlacements}
        incomingViews={bindings.incomingRemoteDesktopViews}
        fleetDiscovery={
          bindings.bootstrap?.data?.capabilities.remoteDesktopFleet ?? false
        }
        onOpenFleetTarget={(tabId, projectId, workerId, desktopTarget) =>
          bindings.newRemoteDesktop.mutate({
            projectId,
            paneId: projectSurfaces?.find(
              (surface: any) => surface.tabKey === tabId,
            )?.paneId,
            target: { kind: "worker", projectId, workerId },
            desktopTarget,
          })
        }
      />
      <PersistentChatViews
        key={JSON.stringify([sessionKey, selectedProjectId])}
        owners={chatOwners}
        incomingViews={bindings.incomingChatViews}
        placements={chatPlacements}
        selectedTabId={
          appMode === "ide" &&
          !showImporter &&
          !showSettings &&
          !bindings.showProjectOverview &&
          !showArchivedStandaloneChats &&
          !showServerAdmin &&
          !showProjectSettings &&
          !selectedPaneOwnedElsewhere
            ? (selectedTabKey ?? null)
            : null
        }
        renderChat={(chat, tabId, visible, incoming) => (
          <WorkspaceChatPanel
            tabId={tabId}
            incoming={incoming}
            chat={chat}
            visible={visible && selectedTabKey === tabId}
            bindings={bindings}
          />
        )}
      />
      <Suspense fallback={null}>
        <PersistentBrowserViews
          incomingViews={bindings.incomingBrowserViews}
          key={JSON.stringify([sessionKey, selectedProjectId])}
          owners={browserOwners}
          placements={browserPlacements}
          selectedTabId={
            appMode === "ide" &&
            !showImporter &&
            !showSettings &&
            !bindings.showProjectOverview &&
            !showArchivedStandaloneChats &&
            !showServerAdmin &&
            !showProjectSettings &&
            !selectedPaneOwnedElsewhere
              ? (selectedTabKey ?? null)
              : null
          }
          fleetDiscovery={
            bindings.bootstrap?.data?.capabilities.browserFleetDiscovery ??
            false
          }
          onOpenService={(browser, service, paneId) =>
            bindings.newBrowser.mutate({
              projectId: browser.projectId,
              paneId,
              target: {
                kind: "worker",
                projectId: browser.projectId,
                workerId: service.workerId,
              },
              title:
                service.title ?? service.processName ?? `Port ${service.port}`,
              url: service.url,
            })
          }
          onPageState={(browser, pageState) =>
            bindings.updateBrowserMutation.mutate({
              browserId: browser.id,
              projectId: browser.projectId,
              pageState,
            })
          }
        />
      </Suspense>
      {!dockPanePresentations &&
      appMode === "ide" &&
      !compactShell &&
      !showImporter &&
      !showSettings &&
      !bindings.showProjectOverview &&
      !showArchivedStandaloneChats &&
      !showServerAdmin &&
      !showProjectSettings &&
      !selectedPaneOwnedElsewhere &&
      Boolean(selectedProject) ? (
        <ProjectPaneTabStrip
          activeTabKey={selectedTabKey ?? ""}
          creatingKinds={creatingSurfaceKinds}
          surfaces={selectedPaneSurfaces}
          onCreate={(kind, target) => {
            const paneId =
              selectedPane?.id ?? selectedPaneSurfaces.at(-1)?.paneId;
            if (selectedProject) {
              createProjectSurface(
                selectedProject.id,
                kind,
                paneId,
                target,
                paneId ? undefined : "center",
              );
            }
          }}
          onClose={closeSurfaceView}
          onKeepOpen={keepSurfaceOpen}
          onDelete={deleteSurfaceResource}
          onRename={renameSurface}
          onSelect={selectTopTab}
          paneId={selectedPane?.id}
          paneRegion={selectedPane?.region}
          placement={selectedPlacementContext}
          projectId={selectedProject.id}
        />
      ) : null}

      <Suspense
        fallback={
          !dockPanePresentations && codeSurfaceVisible ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null
        }
      >
        <PersistentCodeViews
          migratedIds={
            new Set(
              projectSurfaces?.flatMap((surface: any) =>
                migratedCodeTabIds?.has(surface.tabId) &&
                surface.member.tabKind === "code"
                  ? [surface.member.tabId]
                  : [],
              ),
            )
          }
          incomingViews={incomingCodeViews}
          unresolvedIds={
            new Set<string>(
              projectSurfaces?.flatMap((surface: any) =>
                surface.kind === "unresolved" &&
                surface.member.tabKind === "code"
                  ? [surface.tabId]
                  : [],
              ),
            )
          }
          openTabs={projectSurfaces?.flatMap((surface: any) =>
            surface.kind === "code" ? [surface.entity] : [],
          )}
          initialTransfers={stagedCodeTransfers}
          activeTab={codeSurfaceVisible ? (selectedCodeTab ?? null) : null}
          appearance={codeAppearance}
          onChanged={(codeTab) =>
            void queryClient.invalidateQueries({
              queryKey: ["code-tabs", codeTab.projectId],
            })
          }
          onHeaderChange={setCodeHeader}
          onOpenFile={(codeTab, entry) =>
            openProjectExplorerFile(
              codeTab.projectId,
              codeTab.worktreeId,
              entry.path,
            )
          }
          visiblePlacements={dockCodePlacements}
          excludedIds={excludedPersistentSurfaceIds}
        />
      </Suspense>

      <Suspense
        fallback={
          !dockPanePresentations && terminalSurfaceVisible ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null
        }
      >
        <PersistentTerminalViews
          incomingViews={incomingTerminalViews}
          initialTransfers={stagedTerminalTransfers}
          transferTabIds={
            new Map<string, string>(
              projectSurfaces?.flatMap((surface: any) =>
                surface.kind === "terminal"
                  ? [[surface.entity.id, surface.tabKey] as [string, string]]
                  : surface.kind === "unresolved" &&
                      surface.member.tabKind === "terminal"
                    ? [
                        [surface.member.tabId, surface.tabKey] as [
                          string,
                          string,
                        ],
                      ]
                    : [],
              ),
            )
          }
          active={terminalSurfaceVisible}
          commandPaletteTerminalId={terminalCommandPaletteTerminalId}
          key={selectedProjectId ?? "no-project"}
          onCommandPaletteOpenChange={(terminalId, open) =>
            setTerminalCommandPaletteTerminalId(open ? terminalId : null)
          }
          onLinkedConsoleExit={(chatId) => setChatConsoleOpen(chatId, false)}
          onOpenExternalLink={openTerminalLinkExternally}
          onOpenLink={openTerminalLink}
          onPendingInputSent={(inputId) =>
            setPendingTerminalInputs(
              (current: Array<{ id: string; terminalId: string }>) =>
                current.filter(({ id }) => id !== inputId),
            )
          }
          onServicePanelOpenChange={(terminalId, open) =>
            setTerminalServiceTerminalId(open ? terminalId : null)
          }
          renderAgentActions={(chatId) => {
            const chat =
              bindings.chats?.data?.find(
                (entry: { id: string }) => entry.id === chatId,
              ) ??
              (activeProjectTaskChat?.id === chatId
                ? activeProjectTaskChat
                : undefined);
            return chat ? bindings.renderAgentPanelActions?.(chat) : null;
          }}
          ownedTerminals={ownedTerminals}
          pendingInputs={pendingTerminalInputs}
          selectedTerminal={
            selectedTerminal?.kind === "run-configuration"
              ? null
              : (selectedTerminal ?? null)
          }
          servicePanelTerminalId={terminalServiceTerminalId}
          visiblePlacements={dockTerminalPlacements}
          excludedIds={excludedPersistentSurfaceIds}
        />
      </Suspense>

      <Suspense
        fallback={
          !dockPanePresentations && explorerSurfaceVisible ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null
        }
      >
        <PersistentFileDocumentViews
          incomingViews={incomingFileDocumentViews}
          key={`documents:${sessionKey}:${selectedProjectId}`}
          surfaces={(projectSurfaces ?? []).filter(
            (surface: any) =>
              !excludedPersistentSurfaceIds?.has(surface.tabKey) &&
              !excludedPersistentSurfaceIds?.has(surface.tabId),
          )}
          placements={surfaceDockPanePresentations?.flatMap(
            (presentation: any) =>
              presentation.activeSurface?.definition?.id === "project.file"
                ? [
                    {
                      tabId: presentation.activeSurface.tabKey,
                      paneId: presentation.pane.id,
                      portalTarget: presentation.portalTarget,
                      focused: presentation.focused,
                    },
                  ]
                : [],
          )}
          activeTabId={selectedTabKey}
          appearance={codeAppearance}
          onlineWorkerIds={onlineWorkerIds}
          onOpenFile={openProjectExplorerFile}
          onModeChange={persistFileViewMode}
          onHeaderChange={setExplorerHeader}
          onLifecycleChange={handleExplorerLifecycleChange}
        />
        <PersistentExplorerViews
          incomingViews={incomingExplorerViews}
          initialTransfers={stagedExplorerTransfers}
          activeExplorer={
            explorerSurfaceVisible ? (selectedExplorer ?? null) : null
          }
          appearance={codeAppearance}
          graphRequest={explorerGraphRequest}
          gitStatuses={worktreeStatuses}
          key={selectedProjectId ?? "no-project"}
          onChanged={handleExplorerChanged}
          onHeaderChange={setExplorerHeader}
          onLifecycleChange={handleExplorerLifecycleChange}
          onOpenFile={desktopRuntime ? openExplorerFileWindow : undefined}
          onOpenGraphFile={(explorer, path) =>
            openProjectExplorerFile(
              explorer.projectId,
              explorer.worktreeId,
              path,
            )
          }
          onRevealFolder={
            folderRevealLabel && selectedProject?.source
              ? async (explorer, entry, localFolder) => {
                  const project = projects.data?.find(
                    (candidate: ProjectSummary) =>
                      candidate.id === explorer.projectId,
                  );
                  if (!project?.source) return;
                  await revealProjectInNativeFileManager(
                    project,
                    localFolder,
                    entry.path,
                    worktrees.data?.find(
                      ({ id }: { id: string }) => id === explorer.worktreeId,
                    ),
                  );
                }
              : undefined
          }
          revealLabel={folderRevealLabel ?? undefined}
          repositoryGraphAvailable={explorerRepositoryGraphAvailable(
            selectedProject?.capabilities,
          )}
          visiblePlacements={dockExplorerPlacements}
          excludedIds={excludedPersistentSurfaceIds}
          onOpenTerminal={(explorer, entry) => {
            if (!selectedSurface || selectedSurface.kind !== "explorer") {
              return;
            }
            newTerminal.mutate({
              projectId: explorer.projectId,
              directoryPath: entry.path,
              paneId: selectedSurface.paneId,
              title: `Terminal · ${entry.name}`,
              target: {
                kind: "worktree",
                projectId: explorer.projectId,
                worktreeId: explorer.worktreeId,
              },
            });
          }}
          onlineWorkerIds={onlineWorkerIds}
          openExplorers={openExplorers}
        />
      </Suspense>
    </>
  );
}
