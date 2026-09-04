import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";
import {
  projectBuiltInSurfaceAvailable,
  projectOverviewSectionForBuiltInDefinition,
} from "@/lib/project-tool-surfaces";
import {
  runtimeForRunTerminal,
  runTerminalTargetLabel,
} from "@/lib/run-terminal-model";

const ignoreGitHistoryHeaderChange = (_state: unknown): void => undefined;

/**
 * Adapts the focused-shell bindings for a simultaneously visible pane. The
 * focused selection remains authoritative for global header/actions, while a
 * pane body reads its own locally remembered active tab.
 */
export function projectPaneRenderBindings(
  bindings: Readonly<Record<string, any>>,
  presentation: VisibleProjectPane,
): Readonly<Record<string, any>> {
  const { activeSurface, activeTabKey, focused, pane, surfaces } = presentation;
  const selectedChat =
    activeSurface?.kind === "chat" ? activeSurface.entity : undefined;
  const selectedTerminal =
    activeSurface?.kind === "terminal" ? activeSurface.entity : undefined;
  const selectedExplorer =
    activeSurface?.kind === "explorer" ? activeSurface.entity : undefined;
  const selectedBrowser =
    activeSurface?.kind === "browser" ? activeSurface.entity : undefined;
  const selectedCodeTab =
    activeSurface?.kind === "code" ? activeSurface.entity : undefined;
  const selectedProjectView =
    activeSurface?.kind === "history" ||
    activeSurface?.kind === "issues" ||
    activeSurface?.kind === "remote-desktop"
      ? activeSurface.entity
      : undefined;
  const selectedBuiltInSurface =
    activeSurface?.kind === "builtin" ? activeSurface : undefined;
  const selectedProject = bindings.selectedProject;
  const activeProjectOverviewSection = selectedBuiltInSurface
    ? projectOverviewSectionForBuiltInDefinition(
        selectedBuiltInSurface.entity.definitionId,
      )
    : bindings.activeProjectOverviewSection;
  const projectOverviewGitSection =
    selectedBuiltInSurface &&
    activeProjectOverviewSection !== "overview" &&
    activeProjectOverviewSection !== "tasks"
      ? activeProjectOverviewSection
      : null;
  const gitHistoryProject =
    selectedProject?.capabilities.git &&
    (selectedProjectView?.kind === "history" ||
      selectedProjectView?.kind === "issues")
      ? selectedProject
      : undefined;
  const projectOverviewGitProject =
    selectedBuiltInSurface &&
    projectOverviewGitSection &&
    selectedProject?.capabilities.git
      ? selectedProject
      : undefined;
  const selectedProjectToolUnavailable = Boolean(
    selectedBuiltInSurface &&
    selectedProject &&
    !projectBuiltInSurfaceAvailable(
      selectedBuiltInSurface.entity.definitionId,
      selectedProject.capabilities,
    ),
  );
  const selectedRunRuntime = selectedTerminal
    ? runtimeForRunTerminal(
        selectedTerminal,
        bindings.runConfigurationRuntimes.data ?? [],
      )
    : null;
  const selectedRunDefinitionAvailable =
    selectedTerminal?.kind === "run-configuration" &&
    bindings.runConfigurations.isSuccess
      ? Boolean(
          bindings.runConfigurations.data.entries.some(
            (entry: { id: string | null; status: string }) =>
              entry.status === "ready" &&
              entry.id === selectedTerminal.runConfigurationId,
          ),
        )
      : null;
  const selectedRunTargetLabel = selectedTerminal
    ? runTerminalTargetLabel(selectedTerminal, bindings.worktrees.data ?? [])
    : "Unavailable worktree";
  const selectedWorkerId =
    selectedProjectView?.kind === "remote-desktop" &&
    bindings.remoteDesktop.data?.id === selectedProjectView.id
      ? bindings.remoteDesktop.data.workerId
      : (selectedChat?.activeWorkerId ??
        selectedTerminal?.activeWorkerId ??
        selectedCodeTab?.activeWorkerId ??
        selectedBrowser?.workerId ??
        selectedExplorer?.activeWorkerId);
  const inPane = (operation: any) => ({
    ...operation,
    mutate: (input: Record<string, unknown>) =>
      operation.mutate({ ...input, paneId: input.paneId ?? pane.id }),
    ...(typeof operation.mutateAsync === "function"
      ? {
          mutateAsync: (input: Record<string, unknown>) =>
            operation.mutateAsync({
              ...input,
              paneId: input.paneId ?? pane.id,
            }),
        }
      : {}),
  });

  return {
    ...bindings,
    activeChat:
      focused && bindings.activeProjectTaskChat
        ? bindings.activeProjectTaskChat
        : selectedChat,
    activeProjectOverviewSection,
    activeProjectTaskChat: focused ? bindings.activeProjectTaskChat : undefined,
    activeProjectTaskChatId: focused ? bindings.activeProjectTaskChatId : null,
    activeProjectTaskView: focused ? bindings.activeProjectTaskView : "task",
    codeSurfaceVisible: activeSurface?.kind === "code",
    currentRelocation:
      bindings.selectedSurface?.tabKey === activeTabKey
        ? bindings.currentRelocation
        : null,
    displayedGitProject: gitHistoryProject ?? projectOverviewGitProject,
    explorerSurfaceVisible: activeSurface?.kind === "explorer",
    gitHistoryProject,
    selectedPaneOwnedElsewhere: false,
    linkedConsoleChat: undefined,
    newBrowser: inPane(bindings.newBrowser),
    newChat: inPane(bindings.newChat),
    newCodeTab: inPane(bindings.newCodeTab),
    newExplorer: inPane(bindings.newExplorer),
    newRemoteDesktop: inPane(bindings.newRemoteDesktop),
    newTerminal: inPane(bindings.newTerminal),
    projectOverviewGitProject,
    projectOverviewGitSection,
    projectOverviewPopoutTarget: null,
    projectOverviewSelected: Boolean(selectedBuiltInSurface),
    selectedBrowser,
    selectedBuiltInSurface,
    selectedChat,
    selectedCodeTab,
    selectedExplorer,
    selectedPane: pane,
    selectedPaneSurfaces: surfaces,
    selectedProjectToolUnavailable,
    selectedProjectView,
    selectedRunDefinitionAvailable,
    selectedRunLaunchAvailable:
      bindings.selectedSurface?.tabKey === activeTabKey
        ? bindings.selectedRunLaunchAvailable
        : selectedRunDefinitionAvailable,
    selectedRunLaunchProblem:
      bindings.selectedSurface?.tabKey === activeTabKey
        ? bindings.selectedRunLaunchProblem
        : null,
    selectedRunRuntime,
    selectedRunStopAvailable:
      bindings.selectedSurface?.tabKey === activeTabKey
        ? bindings.selectedRunStopAvailable
        : false,
    selectedRunStopProblem:
      bindings.selectedSurface?.tabKey === activeTabKey
        ? bindings.selectedRunStopProblem
        : null,
    selectedRunTargetLabel,
    selectedStandaloneTerminal: selectedTerminal,
    selectedSurface: activeSurface,
    selectedTabKey: activeTabKey,
    selectedTerminal,
    selectedWorker:
      bindings.workers.data?.find(
        ({ workerId }: { workerId: string }) => workerId === selectedWorkerId,
      ) ?? bindings.selectedWorker,
    setCodeHeader: focused ? bindings.setCodeHeader : undefined,
    setExplorerHeader: focused ? bindings.setExplorerHeader : undefined,
    setGitHistoryHeader: focused
      ? bindings.setGitHistoryHeader
      : ignoreGitHistoryHeaderChange,
    showSidebarPreviewTab: false,
    sidebarFilePreview: null,
    sidebarFilePreviewVisible: false,
    terminalSurfaceVisible:
      activeSurface?.kind === "terminal" &&
      activeSurface.entity.kind !== "run-configuration",
  };
}
