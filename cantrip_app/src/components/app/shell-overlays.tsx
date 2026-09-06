import { AppCommandBar } from "@/components/app/app-command-bar";
import { MobileSurfacePicker } from "@/components/mobile/mobile-surface-picker";
import { CustomizationPanel } from "@/components/chat/customization-panel";
import { ChatRelocationDialog } from "@/components/chat/chat-relocation-dialog";
import { WindowsLongPathDialog } from "@/components/projects/windows-long-path-dialog";
import {
  FolderProjectDialog,
  type FolderSourceMode,
} from "@/components/projects/folder-project-dialog";
import { WorktreeCreateDialog } from "@/components/worktrees/worktree-control";
import { errorMessage as errorText } from "@/lib/error-message";
type ShellOverlayBindings = Readonly<Record<string, any>>;

export function ShellOverlays({
  bindings,
}: {
  bindings: ShellOverlayBindings;
}) {
  const {
    activeChat,
    activeProjectWorkspace,
    appActionContext,
    appMode,
    bindWorktreeMutation,
    bootstrap,
    chatRelocationOpen,
    chatRelocations,
    closeSurfaceView,
    commandBarOpen,
    compactShell,
    createProjectSurface,
    creatingSurfaceKinds,
    createWorktreeMutation,
    dismissedLongPathFailure,
    executeAppAction,
    folderProjectDialogMode,
    folderProjectDialogOpen,
    isPopout,
    mobileSurfacePickerOpen,
    onlineWorker,
    openCreatedProject,
    openProjectExplorerFile,
    prepareExplorerRebind,
    projectWorkspaces,
    projectOverviewSelected,
    projectSurfaces,
    projects,
    queryClient,
    retryLongPathSetupMutation,
    runProjectScriptCommand,
    scriptCommandWorktreeId,
    sidebarExplorer,
    selectProjectFromCommandBar,
    selectedLongPathFailure,
    selectedLongPathSetupJob,
    selectedPlacementContext,
    selectedProject,
    selectedProjectId,
    selectedTabKey,
    selectTopTab,
    setChatRelocationOpen,
    setCommandBarOpen,
    setDismissedLongPathFailure,
    setFolderProjectDialogMode,
    setFolderProjectDialogOpen,
    setMobileSurfacePickerOpen,
    setShowCustomizations,
    setWorktreeCreateTarget,
    settings,
    showCustomizations,
    returnToCompactProjectOverview,
    workers,
    worktreeCreateTarget,
    worktreeStatuses,
    worktrees,
  } = bindings;
  return (
    <>
      <FolderProjectDialog
        activeWorkspaceId={activeProjectWorkspace?.id ?? null}
        defaultWorkerId={onlineWorker?.workerId ?? null}
        initialMode={folderProjectDialogMode}
        onCreatedProject={openCreatedProject}
        onOpenChange={setFolderProjectDialogOpen}
        open={appMode === "ide" && folderProjectDialogOpen}
        workers={workers.data ?? []}
        workspaces={projectWorkspaces.data ?? []}
      />

      {selectedProject ? (
        <MobileSurfacePicker
          activeTabKey={selectedTabKey}
          capabilities={selectedProject.capabilities}
          creatingKinds={creatingSurfaceKinds}
          onCloseSurface={closeSurfaceView}
          onCreate={(kind, target) =>
            createProjectSurface(selectedProject.id, kind, undefined, target)
          }
          onOpenChange={setMobileSurfacePickerOpen}
          onOverview={returnToCompactProjectOverview}
          onSelect={selectTopTab}
          open={compactShell && appMode === "ide" && mobileSurfacePickerOpen}
          overviewSelected={projectOverviewSelected}
          projectName={selectedProject.name}
          surfaces={projectSurfaces}
        />
      ) : null}

      <WorktreeCreateDialog
        open={appMode === "ide" && Boolean(worktreeCreateTarget)}
        pending={
          createWorktreeMutation.isPending || bindWorktreeMutation.isPending
        }
        projectId={worktreeCreateTarget?.projectId ?? null}
        sourceWorktreeId={
          worktrees.data?.find(
            ({ isPrimary }: { isPrimary: boolean }) => isPrimary,
          )?.id ?? null
        }
        onOpenChange={(open) => {
          if (!open) setWorktreeCreateTarget(null);
        }}
        onSubmit={async (input) => {
          const target = worktreeCreateTarget;
          if (!target) return;
          if (!(await prepareExplorerRebind(target))) return;
          const created = await createWorktreeMutation.mutateAsync({
            projectId: target.projectId,
            input,
          });
          await bindWorktreeMutation.mutateAsync({
            target,
            worktreeId: created.id,
          });
          await queryClient.invalidateQueries({
            queryKey: ["worktrees", target.projectId],
          });
        }}
      />

      {appMode === "ide" && activeChat ? (
        <CustomizationPanel
          key={`customization:${activeChat.id}`}
          chatId={activeChat.id}
          chatTitle={activeChat.title}
          open={showCustomizations}
          onOpenChange={setShowCustomizations}
        />
      ) : null}

      {appMode === "ide" &&
      activeChat &&
      selectedProject?.capabilities.relocation &&
      selectedPlacementContext ? (
        <ChatRelocationDialog
          key={`relocation:${activeChat.id}`}
          available={Boolean(bootstrap.data?.capabilities.workerSwitching)}
          chat={activeChat}
          jobs={chatRelocations.data ?? []}
          jobsError={chatRelocations.error}
          jobsLoading={chatRelocations.isLoading}
          open={chatRelocationOpen}
          onOpenChange={setChatRelocationOpen}
          placement={selectedPlacementContext}
          statuses={worktreeStatuses}
          synchronizationPolicy={
            settings.data?.preferences.automaticReplicaSynchronization ?? "off"
          }
        />
      ) : null}

      {!isPopout && appMode === "ide" ? (
        <AppCommandBar
          activeWorkspaceId={activeProjectWorkspace?.id ?? null}
          context={appActionContext}
          currentProjectId={selectedProjectId}
          defaultWorkerId={onlineWorker?.workerId ?? null}
          fileSearchExplorerId={sidebarExplorer?.id ?? null}
          onAction={executeAppAction}
          onCreatedProject={openCreatedProject}
          onOpenChange={setCommandBarOpen}
          onOpenFolder={() => {
            setFolderProjectDialogMode("existing");
            setFolderProjectDialogOpen(true);
          }}
          onOpenFile={(path) => {
            if (!selectedProjectId || !sidebarExplorer) return;
            openProjectExplorerFile(
              selectedProjectId,
              sidebarExplorer.worktreeId,
              path,
            );
          }}
          onRunScriptCommand={runProjectScriptCommand}
          onSelectProject={selectProjectFromCommandBar}
          open={commandBarOpen}
          projects={projects.data ?? []}
          scriptWorktreeId={scriptCommandWorktreeId}
          workers={workers.data ?? []}
          workspaces={projectWorkspaces.data ?? []}
        />
      ) : null}

      <WindowsLongPathDialog
        open={Boolean(
          appMode === "ide" &&
          selectedLongPathFailure &&
          selectedLongPathFailure !== dismissedLongPathFailure,
        )}
        pending={retryLongPathSetupMutation.isPending}
        retryError={
          retryLongPathSetupMutation.isError
            ? errorText(retryLongPathSetupMutation.error)
            : null
        }
        onOpenChange={(open) => {
          if (!open && selectedLongPathFailure) {
            setDismissedLongPathFailure(selectedLongPathFailure);
          }
        }}
        onRetry={() => {
          if (selectedLongPathSetupJob) {
            retryLongPathSetupMutation.mutate(selectedLongPathSetupJob);
          }
        }}
      />
    </>
  );
}
