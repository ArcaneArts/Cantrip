import type { ProjectSummary } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { Suspense } from "react";
import {
  PersistentCodeViews,
  PersistentExplorerViews,
} from "@/components/app/application-shell-surfaces";
import { explorerRepositoryGraphAvailable } from "@/components/explorer/explorer-graph-routing";
import { ProjectTabBar } from "@/components/workspace/project-tab-bar";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import {
  sidebarExplorerPrewarmTarget,
  sidebarFileName,
} from "@/lib/sidebar-file-tabs";
type PersistentSurfaceBindings = Readonly<Record<string, any>>;

export function PersistentSurfaceLayer({
  bindings,
}: {
  bindings: PersistentSurfaceBindings;
}) {
  const {
    activateSidebarFilePreview,
    appMode,
    closeSidebarFilePreview,
    codeAppearance,
    codeSurfaceVisible,
    compactShell,
    completeSidebarFilePinHandoff,
    createProjectSurface,
    creatingSurfaceKinds,
    deleteSurface,
    deleteSurfaceImmediately,
    desktopRuntime,
    explorerGraphRequest,
    explorerSurfaceVisible,
    folderRevealLabel,
    forkChatMutation,
    groupOwnedElsewhere,
    handleExplorerChanged,
    handleExplorerLifecycleChange,
    handleSidebarFilePreviewLifecycleChange,
    updateSidebarFileWorkbenchReadiness,
    isPopout,
    mobileTabGridOpen,
    newTerminal,
    onlineWorkerIds,
    openExplorerFileWindow,
    openExplorers,
    pinSidebarFilePath,
    projectTabBarSurfaces,
    projects,
    queryClient,
    renameSurface,
    selectTopTab,
    selectedCodeTab,
    selectedExplorer,
    selectedGroupSurfaces,
    selectedPlacementContext,
    selectedProject,
    selectedProjectId,
    selectedSurface,
    selectedTabGroup,
    selectedTabKey,
    setCodeHeader,
    setExplorerHeader,
    setSidebarFilePreviewHeader,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    showSidebarPreviewTab,
    sidebarFilePinHandoff,
    sidebarFilePreview,
    sidebarFilePreviewVisible,
    sidebarInlineExplorer,
    sidebarPreviewSuccessorExplorer,
    sidebarPreviewExplorer,
    stopAndDeleteRunTerminalMutation,
    worktreeStatuses,
  } = bindings;
  return (
    <>
      {appMode === "ide" &&
      (!compactShell || !mobileTabGridOpen) &&
      !showImporter &&
      !showSettings &&
      !showArchivedStandaloneChats &&
      !showServerAdmin &&
      !showProjectSettings &&
      !groupOwnedElsewhere &&
      ((selectedTabKey &&
        selectedTabGroup &&
        selectedGroupSurfaces.length > 0) ||
        showSidebarPreviewTab) ? (
        <ProjectTabBar
          activeTabKey={selectedTabKey ?? ""}
          creatingKinds={creatingSurfaceKinds}
          surfaces={projectTabBarSurfaces}
          onCreate={(kind, target) => {
            const groupId = sidebarFilePreview?.active
              ? sidebarFilePreview.groupId
              : selectedTabGroup?.id;
            if (selectedProject && groupId) {
              createProjectSurface(selectedProject.id, kind, groupId, target);
            }
          }}
          onClose={deleteSurfaceImmediately}
          onDelete={deleteSurface}
          onDuplicate={(surface) => {
            if (surface.kind === "chat") {
              forkChatMutation.mutate(surface.tabId);
            }
          }}
          onRename={renameSurface}
          onSelect={selectTopTab}
          onStopAndCloseRunTerminal={(terminal) =>
            stopAndDeleteRunTerminalMutation
              .mutateAsync(terminal)
              .then(() => undefined)
          }
          placement={selectedPlacementContext}
          previewFile={
            showSidebarPreviewTab && sidebarFilePreview
              ? {
                  active: sidebarFilePreview.active,
                  path: sidebarFilePreview.path,
                  projectId: sidebarFilePreview.projectId,
                  title: sidebarFileName(sidebarFilePreview.path),
                  onClose: closeSidebarFilePreview,
                  onPin: () => {
                    if (sidebarPreviewExplorer) {
                      void pinSidebarFilePath(
                        sidebarPreviewExplorer,
                        sidebarFilePreview.path,
                      );
                    }
                  },
                  onSelect: activateSidebarFilePreview,
                }
              : undefined
          }
        />
      ) : null}

      <Suspense
        fallback={
          codeSurfaceVisible ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null
        }
      >
        <PersistentCodeViews
          activeTab={codeSurfaceVisible ? (selectedCodeTab ?? null) : null}
          appearance={codeAppearance}
          onChanged={(codeTab) =>
            void queryClient.invalidateQueries({
              queryKey: ["code-tabs", codeTab.projectId],
            })
          }
          onHeaderChange={setCodeHeader}
        />
      </Suspense>

      <Suspense
        fallback={
          explorerSurfaceVisible ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null
        }
      >
        <PersistentExplorerViews
          activeExplorer={
            appMode === "ide" && sidebarFilePreviewVisible
              ? (sidebarPreviewExplorer ?? null)
              : explorerSurfaceVisible
                ? (selectedExplorer ?? null)
                : null
          }
          transientFile={
            appMode === "ide" && sidebarFilePreview
              ? {
                  explorerId: sidebarFilePreview.explorerId,
                  file: {
                    close: closeSidebarFilePreview,
                    path: sidebarFilePreview.path,
                  },
                }
              : undefined
          }
          appearance={codeAppearance}
          graphRequest={explorerGraphRequest}
          gitStatuses={worktreeStatuses}
          handoffExplorer={
            sidebarFilePinHandoff?.destinationExplorer?.projectId ===
            selectedProjectId
              ? sidebarFilePinHandoff.destinationExplorer
              : null
          }
          handoffSourceExplorer={
            sidebarFilePinHandoff?.sourceExplorer.projectId ===
            selectedProjectId
              ? sidebarFilePinHandoff.sourceExplorer
              : null
          }
          key={selectedProjectId ?? "no-project"}
          onChanged={handleExplorerChanged}
          onHeaderChange={
            sidebarFilePreviewVisible
              ? setSidebarFilePreviewHeader
              : setExplorerHeader
          }
          onInlineCodeReady={completeSidebarFilePinHandoff}
          onInlineCodeWorkbenchReadinessChange={
            updateSidebarFileWorkbenchReadiness
          }
          onLifecycleChange={handleExplorerLifecycleChange}
          onTransientLifecycleChange={handleSidebarFilePreviewLifecycleChange}
          onOpenFile={desktopRuntime ? openExplorerFileWindow : undefined}
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
                  );
                }
              : undefined
          }
          revealLabel={folderRevealLabel ?? undefined}
          repositoryGraphAvailable={explorerRepositoryGraphAvailable(
            selectedProject?.capabilities,
          )}
          onOpenTerminal={(explorer, entry) => {
            if (!selectedSurface || selectedSurface.kind !== "explorer") {
              return;
            }
            newTerminal.mutate({
              projectId: explorer.projectId,
              directoryPath: entry.path,
              tabGroupId: selectedSurface.groupId,
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
          prewarmExplorer={sidebarExplorerPrewarmTarget({
            hasOpenExplorer: openExplorers.length > 0,
            isPopout,
            pinInProgress: Boolean(sidebarFilePinHandoff),
            sidebarExplorer: sidebarInlineExplorer,
          })}
          prewarmSuccessorExplorer={sidebarExplorerPrewarmTarget({
            hasOpenExplorer: openExplorers.length > 0,
            isPopout,
            pinInProgress: Boolean(sidebarFilePinHandoff),
            sidebarExplorer: sidebarPreviewSuccessorExplorer,
          })}
        />
      </Suspense>
    </>
  );
}
