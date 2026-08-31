import type {
  ChatSummary,
  ScriptCommand,
  TerminalSummary,
} from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type WorktreeBindingTarget } from "@/components/app/application-shell-model";
import { ApplicationShellRender } from "@/components/app/application-shell-render";
import {
  createDesktopGroupSelectionCommands,
  useDesktopPopoutEffects,
  useDesktopPopoutModel,
  useDesktopPopoutStatusState,
  useDetachedDesktopGroupState,
  useOrphanedDesktopPopoutEffect,
} from "@/components/app/desktop-popout-lifecycle";
import {
  mobileProjectSurfaces,
  mobileProjectShellModel,
} from "@/components/app/mobile-project-navigation";
import {
  useBrowserCodeViewCreationOperations,
  useChatConsoleOperation,
  useExplorerCreationOperations,
  useProjectChatCreationOperation,
  useProjectTaskCreationOperation,
  useRemoteDesktopCreationOperation,
  useStandaloneChatCompletionOperation,
  useStandaloneChatOperations,
  useTerminalCreationOperation,
} from "@/components/app/surface-creation-operations";
import {
  useBrowserSurfaceOperations,
  useChatDeleteOperation,
  useChatRenameAndForkOperations,
  useCodeSurfaceOperations,
  useExplorerSurfaceOperations,
  useProjectViewSurfaceOperations,
  useTerminalSurfaceOperations,
} from "@/components/app/surface-crud-operations";
import { createSurfaceCommandController } from "@/components/app/surface-commands";
import { createSidebarExplorerCommands } from "@/components/app/sidebar-explorer-commands";
import {
  createProjectExplorerFileOpening,
  useExplorerLifecycleRefs,
  useExplorerLifecycleRegistration,
  useSidebarExplorerModel,
  useSidebarExplorerMutations,
  useSidebarExplorerProvisioning,
  useSidebarFilePinHandoffLifecycle,
  useSidebarFileState,
} from "@/components/app/sidebar-explorer-controller";
import {
  useApplicationInventory,
  useProjectInventory,
} from "@/components/app/project-inventory";
import {
  useProjectListOperations,
  useProjectSetupOperations,
} from "@/components/app/project-operations";
import { useProjectWorkspaceResources } from "@/components/app/project-workspace-resources";
import {
  projectWorkspaceSurfaceSelection,
  useActiveProjectWorkspace,
  useProjectSurfaceSelection,
  useProjectWorkspaceSelectionState,
  useWorkspaceLiveScopes,
  useWorkspaceSelectionReconciliation,
  workspaceGroupSelection,
} from "@/components/app/project-workspace-selection";
import { useShellEnvironment } from "@/components/app/shell-environment";
import {
  useShellAppearanceEffects,
  useShellAppearanceState,
} from "@/components/app/shell-appearance";
import {
  useContentScrollChrome,
  useShellChromeState,
  useSidebarResizeController,
  useSidebarWidthPersistence,
} from "@/components/app/shell-chrome";
import {
  createWorkspaceDropHandler,
  useTabLayoutOperations,
} from "@/components/app/tab-layout-operations";
import { useWorktreeOperations } from "@/components/app/worktree-operations";
import {
  createShellNavigationCommands,
  createShellProjectNavigationCommands,
  useAppDestinationPersistence,
  useProjectSelectionReconciliation,
  useShellClientControlNavigation,
  useShellNavigationState,
  useShellStartupNavigation,
} from "@/components/app/shell-navigation";
import { updateAgentInspectOpenChats } from "@/components/chat/agent-inspect-panel";
import { updateChatConsoleOpenChats } from "@/components/chat/chat-console-state";
import {
  activeChatRelocationJob,
  isChatRelocationActive,
  latestChatRelocationJob,
} from "@/components/chat/chat-relocation-dialog";
import type { CodeHeaderState } from "@/components/code/code-view";
import type {
  GitHistoryHeaderState,
  GitViewSection,
} from "@/components/git/git-history";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import { type FolderSourceMode } from "@/components/projects/folder-project-dialog";
import { terminalLinkBrowserTitle } from "@/components/terminal/terminal-links";
import { terminalCommandInput } from "@/components/terminal/terminal-command-palette";
import { errorMessage as errorText } from "@/lib/error-message";
import { openExternalUrl } from "@/lib/external-url";
import {
  APP_ACTION_IDS,
  projectIdForAppActionView,
  type AppActionContext,
  type AppActionId,
} from "@/lib/app-actions";
import { githubRepositoryOnboardingAction } from "@/lib/github-repository-onboarding";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";
import { useWorkerObservationDemands } from "@/lib/worker-observation-react";
import { type AppToastInput } from "@/components/ui/app-toast";
import { getChatRelocations } from "@/lib/api";
import { runConfigurationTargetControlForIdentity } from "@/lib/run-configuration-control-model";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";
import { scopedClientStorageKey } from "@/lib/client-session";
import { useDesktopDirectTransportTelemetry } from "@/lib/direct-transport-telemetry";
import { useAppActions } from "@/lib/use-app-actions";
import {
  runtimeForRunTerminal,
  runTerminalTargetLabel,
} from "@/lib/run-terminal-model";
import { sidebarFilePreviewIsVisible } from "@/lib/sidebar-file-tabs";
import { projectScriptCommandDestination } from "@/lib/project-script-command";
import {
  isWindowsLongPathSetupFailure,
  projectOwningWorkerId,
  projectSetupFailureKey,
} from "@/lib/project-setup-progress";
import { selectWorkspaceTab } from "@/lib/workspace-selection";
import { workspaceWorkerObservationDemands } from "@/lib/workspace-worker-observation";
import { ChatTranscript } from "@/components/chat/chat-transcript";
export { ChatTranscript };
export function App() {
  useDesktopDirectTransportTelemetry();
  const queryClient = useQueryClient();
  const activeProjectWorkspaceStorageKey = useMemo(
    () => scopedClientStorageKey("cantrip:active-project-workspace"),
    [],
  );
  const liveStatus = useAppLiveStatus();
  const projectResourcesLive = liveStatus === "live";
  const {
    compactLayout,
    compactShell,
    desktopRuntime,
    desktopSidebarDrawer,
    explorerFileTarget,
    folderRevealLabel,
    isPopout,
    narrowViewport,
    overlayTitlebar,
    popoutProjectId,
    popoutTarget,
    projectOverviewPopoutTarget,
    projectRevealButtonLabel,
    projectRevealLabel,
    showContentTitlebar,
  } = useShellEnvironment();
  const {
    appMode,
    destinationWriteRef,
    projectOverviewSection,
    projectOverviewWorktreeId,
    projectSettingsSection,
    selectedProjectId,
    selectedStandaloneChatId,
    selectedWorkflowIntentId,
    setAppMode,
    setProjectOverviewSection,
    setProjectOverviewWorktreeId,
    setProjectSettingsSection,
    setSelectedProjectId,
    setSelectedStandaloneChatId,
    setSelectedWorkflowIntentId,
    setSettingsPolicyId,
    setSettingsSection,
    setShowArchivedStandaloneChats,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
    setStandaloneFilePath,
    setStandaloneFilesOpen,
    settingsPolicyId,
    settingsSection,
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
    standaloneFilePath,
    standaloneFilesOpen,
    startupNavigationResolvedRef,
  } = useShellNavigationState({
    isPopout,
    popoutProjectId,
    projectOverviewPopoutTarget,
  });
  const [createdRepositoryOnboarding, setCreatedRepositoryOnboarding] =
    useState<{ openInitialChat: boolean; projectId: string } | null>(null);
  const [dismissedLongPathFailure, setDismissedLongPathFailure] = useState<
    string | null
  >(null);
  const {
    pendingSurfaceSelection,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
    workspaceSelection,
  } = useProjectWorkspaceSelectionState({ popoutProjectId, popoutTarget });
  const sidebarFileState = useSidebarFileState();
  const {
    explorerGraphRequest,
    setExplorerGraphRequest,
    setSidebarFilePinHandoff,
    setSidebarFilePreview,
    sidebarFilePinHandoff,
    sidebarFilePinHandoffRef,
    sidebarFilePreview,
  } = sidebarFileState;
  const [chatConsoleOpenChats, setChatConsoleOpenChats] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const setChatConsoleOpen = useCallback((chatId: string, open: boolean) => {
    setChatConsoleOpenChats((current) =>
      updateChatConsoleOpenChats(current, chatId, open),
    );
  }, []);
  const [agentInspectOpenChats, setAgentInspectOpenChats] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [projectTaskChatIds, setProjectTaskChatIds] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [taskChatViewIds, setTaskChatViewIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setAgentInspectOpen = useCallback((chatId: string, open: boolean) => {
    setAgentInspectOpenChats((current) =>
      updateAgentInspectOpenChats(current, chatId, open),
    );
  }, []);
  const [workspaceDragError, setWorkspaceDragError] = useState<string | null>(
    null,
  );
  const [appToast, setAppToast] = useState<
    (AppToastInput & { id: string }) | null
  >(null);
  const showAppToast = useCallback((toast: AppToastInput) => {
    setAppToast({ ...toast, id: crypto.randomUUID() });
  }, []);
  const {
    selectedBrowserId,
    selectedChatId,
    selectedCodeTabId,
    selectedExplorerId,
    selectedProjectViewId,
    selectedTabKey,
    selectedTerminalId,
  } = projectWorkspaceSurfaceSelection(workspaceSelection);
  useWorkspaceLiveScopes({
    appMode,
    selectedChatId,
    selectedProjectId,
    selectedStandaloneChatId,
  });
  const [folderProjectDialogOpen, setFolderProjectDialogOpen] = useState(false);
  const [folderProjectDialogMode, setFolderProjectDialogMode] =
    useState<FolderSourceMode>("create");
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const [runConfigurationEditorId, setRunConfigurationEditorId] = useState<
    string | "new" | null
  >(null);
  useEffect(() => setRunConfigurationEditorId(null), [selectedProjectId]);
  const projectOverviewSelected =
    !sidebarFilePreview?.active &&
    !showImporter &&
    !showSettings &&
    !showArchivedStandaloneChats &&
    !showServerAdmin &&
    !showProjectSettings &&
    (projectOverviewPopoutTarget !== null ||
      (!isPopout && workspaceSelection.destination === "overview"));
  const activeProjectOverviewSection =
    projectOverviewPopoutTarget?.section ?? projectOverviewSection;
  const activeProjectTaskChatId =
    projectOverviewSelected &&
    activeProjectOverviewSection === "tasks" &&
    selectedProjectId
      ? (projectTaskChatIds.get(selectedProjectId) ?? null)
      : null;
  useAppLiveScope(
    activeProjectTaskChatId
      ? { kind: "chat", chatId: activeProjectTaskChatId }
      : null,
  );
  const [activeProjectWorkspaceId, setActiveProjectWorkspaceId] = useState<
    string | null
  >(() => window.localStorage.getItem(activeProjectWorkspaceStorageKey));
  const [showCustomizations, setShowCustomizations] = useState(false);
  const [chatRelocationOpen, setChatRelocationOpen] = useState(false);
  const {
    contentRootRef,
    contentScrolled,
    desktopSidebarDrawerOpen,
    scrolledContentRef,
    setContentScrolled,
    setDesktopSidebarDrawerOpen,
    setSidebarCollapsed,
    setSidebarResizing,
    setSidebarWidth,
    sidebarCollapsed,
    sidebarRef,
    sidebarResizeBodyStyleRef,
    sidebarResizeLeftRef,
    sidebarResizePointerIdRef,
    sidebarResizeStartWidthRef,
    sidebarResizing,
    sidebarWidth,
    sidebarWidthRef,
  } = useShellChromeState({ desktopSidebarDrawer });
  const [gitHistoryHeader, setGitHistoryHeader] =
    useState<GitHistoryHeaderState | null>(null);
  const [explorerHeader, setExplorerHeader] =
    useState<ExplorerHeaderState | null>(null);
  const [sidebarFilePreviewHeader, setSidebarFilePreviewHeader] =
    useState<ExplorerHeaderState | null>(null);
  const [codeHeader, setCodeHeader] = useState<CodeHeaderState | null>(null);
  const desktopPopoutStatus = useDesktopPopoutStatusState();
  const { popoutError, popoutPending, setPopoutError } = desktopPopoutStatus;
  const [
    terminalCommandPaletteTerminalId,
    setTerminalCommandPaletteTerminalId,
  ] = useState<string | null>(null);
  const [terminalServiceTerminalId, setTerminalServiceTerminalId] = useState<
    string | null
  >(null);
  const [pendingTerminalInputs, setPendingTerminalInputs] = useState<
    Array<{
      data: string;
      id: string;
      terminalId: string;
    }>
  >([]);
  const detachedDesktopGroup = useDetachedDesktopGroupState();
  const { detachedGroupId, setDetachedGroupId } = detachedDesktopGroup;
  const explorerLifecycle = useExplorerLifecycleRefs();
  const {
    explorerLifecycleRef,
    sidebarExplorerCreationKeyRef,
    sidebarFilePreviewLifecycleRef,
  } = explorerLifecycle;
  const [worktreeCreateTarget, setWorktreeCreateTarget] =
    useState<WorktreeBindingTarget | null>(null);
  const [worktreeActionError, setWorktreeActionError] = useState<string | null>(
    null,
  );
  const { codeAppearance, proModeActive, setCodeAppearance, setProModeActive } =
    useShellAppearanceState();
  const {
    handleExplorerChanged,
    handleExplorerLifecycleChange,
    handleSidebarFilePreviewLifecycleChange,
    openExplorerFileWindow,
  } = useExplorerLifecycleRegistration({
    codeAppearance,
    lifecycle: explorerLifecycle,
    queryClient,
  });

  const {
    closeProjectTask,
    openCreatedProject,
    openCreatedTab,
    openProjectCreateSource,
    openProjectSettings,
    openProjectTask,
    openTunnelOwner,
  } = createShellProjectNavigationCommands({
    compactShell,
    getActiveProjectWorkspaceId: () => activeProjectWorkspace?.id ?? null,
    navigation: {
      setAppMode,
      setProjectOverviewSection,
      setProjectSettingsSection,
      setSelectedProjectId,
      setSelectedWorkflowIntentId,
      setShowImporter,
      setShowProjectSettings,
      setShowServerAdmin,
      setShowSettings,
    },
    persistAppDestination: (patch) => persistAppDestination(patch),
    queryClient,
    setCreatedRepositoryOnboarding,
    setDesktopSidebarDrawerOpen,
    setFolderProjectDialogMode,
    setFolderProjectDialogOpen,
    setPendingSurfaceSelection,
    setProjectTaskChatIds,
    setSidebarFilePreview,
    setWorkspaceSelection,
  });
  const applicationInventory = useApplicationInventory({
    isPopout,
    projectResourcesLive,
  });
  const { bootstrap, settings, workers } = applicationInventory;
  const persistAppDestination = useAppDestinationPersistence({
    destinationWriteRef,
    queryClient,
  });
  const saveSidebarWidth = useSidebarWidthPersistence(queryClient);
  const projectInventory = useProjectInventory({
    appMode,
    foundation: applicationInventory,
    isPopout,
    projectResourcesLive,
    selectedProjectId,
    selectedStandaloneChatId,
  });
  const {
    archivedStandaloneChats,
    folderSetupJobs,
    projectSetupJobs,
    projects,
    projectWorkspaces,
    selectedProject,
    selectedStandaloneChat,
    standaloneChatCreationAvailable,
    standaloneChatCreationUnavailableReason,
    standaloneChatWorkerAvailable,
    standaloneChats,
  } = projectInventory;
  const { createWorkspaceMutation, retryLongPathSetupMutation } =
    useProjectSetupOperations({
      activeProjectWorkspaceStorageKey,
      queryClient,
      setActiveProjectWorkspaceId,
      setDismissedLongPathFailure,
      setSelectedProjectId,
      setShowArchivedStandaloneChats,
      setShowImporter,
      setShowProjectSettings,
      setShowServerAdmin,
      setShowSettings,
      setWorkspaceSelection,
    });
  const projectWorkspaceResources = useProjectWorkspaceResources({
    activeProjectOverviewSection,
    projectOverviewSelected,
    projectResourcesLive,
    projects: projects.data,
    queryClient,
    selectedProject,
    selectedProjectId,
    selectedProjectViewId,
    workers: workers.data,
  });
  const {
    browsers,
    chats,
    codeTabs,
    explorers,
    projectTokenUsage,
    projectViews,
    remoteDesktop,
    repositoryStats,
    runConfigurationRuntimes,
    runConfigurations,
    tabLayout,
    terminals,
    worktreeStatuses,
    worktrees,
  } = projectWorkspaceResources;
  const newChat = useProjectChatCreationOperation({
    openCreatedTab,
    queryClient,
    randomAgentNames: settings.data?.preferences.randomAgentNames ?? false,
    resources: projectWorkspaceResources,
  });
  const {
    archiveStandaloneChat,
    forkStandaloneChat,
    newStandaloneChat,
    permanentlyDeleteStandaloneChat,
    renameStandaloneChat,
    restoreStandaloneChat,
  } = useStandaloneChatOperations({
    bootstrap,
    persistAppDestination,
    queryClient,
    randomAgentNames: settings.data?.preferences.randomAgentNames ?? false,
    selectedStandaloneChatId,
    setSelectedStandaloneChatId,
    setShowArchivedStandaloneChats,
    standaloneChats,
    standaloneChatWorkerAvailable,
  });
  const newTask = useProjectTaskCreationOperation({
    openProjectTask,
    queryClient,
  });
  const newTerminal = useTerminalCreationOperation({
    openCreatedTab,
    queryClient,
    setPendingTerminalInputs,
  });
  const appActionView = isPopout
    ? "popout"
    : showSettings || showServerAdmin
      ? "global"
      : showImporter || folderProjectDialogOpen
        ? "project-creation"
        : showProjectSettings
          ? "project-settings"
          : "project";
  const projectActionProjectId = projectIdForAppActionView(
    selectedProject?.id ?? null,
    appActionView,
  );
  const appActionContext = useMemo<AppActionContext>(
    () => ({
      pendingActionIds: new Set<AppActionId>([
        ...(newChat.isPending ? [APP_ACTION_IDS.newAgentChat] : []),
        ...(newTerminal.isPending ? [APP_ACTION_IDS.newTerminal] : []),
      ]),
      projectId: projectActionProjectId,
    }),
    [newChat.isPending, newTerminal.isPending, projectActionProjectId],
  );
  const executeAppAction = (actionId: AppActionId) => {
    const projectId = appActionContext.projectId;
    if (!projectId) return;
    if (actionId === APP_ACTION_IDS.newAgentChat) {
      newChat.mutate({ projectId });
    } else if (actionId === APP_ACTION_IDS.newTerminal) {
      newTerminal.mutate({ projectId });
    }
  };
  useAppActions({
    context: appActionContext,
    runtime: isPopout
      ? "disabled"
      : desktopRuntime && isMacosDesktopRuntime()
        ? "desktop"
        : "browser",
    onAction: executeAppAction,
  });
  const openChatConsole = useChatConsoleOperation({
    queryClient,
    setChatConsoleOpen,
  });
  const { newExplorer, newGraphExplorer } = useExplorerCreationOperations({
    openCreatedTab,
    queryClient,
    setExplorerGraphRequest,
    setPopoutError,
  });
  const { createSidebarExplorerMutation, pinSidebarFileMutation } =
    useSidebarExplorerMutations({
      fileState: sidebarFileState,
      lifecycle: explorerLifecycle,
      queryClient,
      setPopoutError,
    });
  const { openChatFileLink, openProjectExplorerFile } =
    createProjectExplorerFileOpening({
      codeAppearance,
      desktopRuntime,
      explorers: explorers.data,
      explorerLifecycleRef,
      openCreatedTab,
      queryClient,
      selectedProject,
      setPopoutError,
      showAppToast,
      worktrees: worktrees.data,
    });
  const { newBrowser, newCodeTab, newProjectView } =
    useBrowserCodeViewCreationOperations({
      openCreatedTab,
      queryClient,
    });
  const {
    bindWorktreeMutation,
    createWorktreeMutation,
    prepareExplorerRebind,
    requestBindWorktree,
  } = useWorktreeOperations({
    codeHeader,
    explorerLifecycleRef,
    queryClient,
    setWorktreeActionError,
  });
  const newRemoteDesktop = useRemoteDesktopCreationOperation({
    openCreatedTab,
    queryClient,
  });
  const {
    acknowledgeSelectedChatCompletion,
    forkChatMutation,
    renameChatMutation,
  } = useChatRenameAndForkOperations({
    openCreatedTab,
    queryClient,
    selectedProjectId,
  });
  const acknowledgeSelectedStandaloneChatCompletion =
    useStandaloneChatCompletionOperation(queryClient);
  const deleteChatMutation = useChatDeleteOperation({
    queryClient,
    selectedProjectId,
    setChatConsoleOpen,
    setProjectTaskChatIds,
    setTaskChatViewIds,
  });
  const {
    deleteTerminalMutation,
    renameTerminalMutation,
    stopAndDeleteRunTerminalMutation,
  } = useTerminalSurfaceOperations({
    queryClient,
    selectedProjectId,
    setPendingTerminalInputs,
    setTerminalServiceTerminalId,
    terminalServiceTerminalId,
  });
  const {
    deleteExplorerMutation,
    renameExplorerMutation,
    requestDeleteExplorer,
  } = useExplorerSurfaceOperations({
    explorerLifecycleRef,
    queryClient,
    selectedProjectId,
  });
  const { deleteBrowserMutation, updateBrowserMutation } =
    useBrowserSurfaceOperations({ queryClient, selectedProjectId });
  const { deleteCodeTabMutation, updateCodeTabMutation } =
    useCodeSurfaceOperations({ queryClient, selectedProjectId });
  const { deleteProjectViewMutation, renameProjectViewMutation } =
    useProjectViewSurfaceOperations({ queryClient, selectedProjectId });
  const {
    removeProjectMutation,
    reorderProjectsMutation,
    retryFolderSetupMutation,
  } = useProjectListOperations({
    pendingSurfaceSelection,
    queryClient,
    selectedProjectId,
    setPendingSurfaceSelection,
    setSelectedProjectId,
    setShowProjectSettings,
    setWorkspaceSelection,
    showProjectSettings,
    workspaceSelection,
  });
  const { renameTabGroupMutation, tabLayoutMutation } = useTabLayoutOperations({
    queryClient,
    setWorkspaceDragError,
  });

  const onlineWorker = workers.data?.find((worker) => worker.online) ?? null;
  const { activeProjectWorkspace, visibleProjects } = useActiveProjectWorkspace(
    {
      activeProjectWorkspaceId,
      inventory: { projects, projectWorkspaces },
    },
  );
  const selectedProjectSetupJob = selectedProject
    ? projectSetupJobs.get(selectedProject.id)
    : undefined;
  const selectedLongPathSetupJob = isWindowsLongPathSetupFailure(
    selectedProjectSetupJob,
  )
    ? selectedProjectSetupJob
    : undefined;
  const selectedLongPathFailure = selectedLongPathSetupJob
    ? projectSetupFailureKey(selectedLongPathSetupJob)
    : null;
  const selectedProjectWorkerId = projectOwningWorkerId(
    selectedProject,
    selectedProjectSetupJob,
  );
  const selectedFolderSetupJob = selectedProject
    ? folderSetupJobs.get(selectedProject.id)
    : undefined;
  const selectedFolderSetupNeedsAttention = Boolean(
    selectedProject?.originKind === "managed-folder" &&
    (selectedProject.setupStatus === "failed" ||
      selectedFolderSetupJob?.state === "blocked" ||
      selectedFolderSetupJob?.state === "failed"),
  );
  const { compactManagedHeader, mobileProjectSelectorOpen } =
    mobileProjectShellModel({
      appMode,
      compactShell,
      projectOverviewSelected,
      selectedProject: Boolean(selectedProject),
      selectedProjectId,
      showArchivedStandaloneChats,
      showImporter,
      showProjectSettings,
      showServerAdmin,
      showSettings,
    });
  const { displayTerminals, projectSurfaceIndex, selectedSurface } =
    useProjectSurfaceSelection({
      resources: projectWorkspaceResources,
      selectedTabKey,
    });
  const sidebarExplorerModel = useSidebarExplorerModel({
    detachedGroupId,
    environment: {
      explorerFileTarget,
      popoutTarget,
      projectOverviewPopoutTarget,
    },
    explorers: explorers.data,
    fileState: sidebarFileState,
    openCreatedTab,
    selectedProjectId,
    selectedSurface,
    tabLayout: tabLayout.data,
    worktrees: worktrees.data,
  });
  const {
    openCreatedTabRef,
    openExplorerIds,
    openExplorers,
    selectedProjectIdRef,
    sidebarDesiredWorktreeId,
    sidebarExplorer,
    sidebarFilePreviewRef,
    sidebarInlineExplorer,
    sidebarPreviewSuccessorExplorer,
    sidebarPreviewExplorer,
  } = sidebarExplorerModel;
  const { abandonSidebarFilePinHandoff, completeSidebarFilePinHandoff } =
    useSidebarFilePinHandoffLifecycle({
      fileState: sidebarFileState,
      lifecycle: explorerLifecycle,
      model: sidebarExplorerModel,
      queryClient,
      selectedProjectId,
      setPopoutError,
    });
  const {
    onlineWorkerIds,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
  } = useSidebarExplorerProvisioning({
    explorers: explorers.data,
    explorersIsSuccess: explorers.isSuccess,
    fileState: sidebarFileState,
    isPopout,
    lifecycle: explorerLifecycle,
    model: sidebarExplorerModel,
    mutations: { createSidebarExplorerMutation },
    selectedProject,
    selectedProjectId,
    selectedProjectWorkerId,
    tabLayoutIsSuccess: tabLayout.isSuccess,
    workers: workers.data,
  });
  const projectSurfaces = useMemo(
    () => [...projectSurfaceIndex.byTabKey.values()],
    [projectSurfaceIndex],
  );
  const mobileNavigationSurfaces = useMemo(
    () => mobileProjectSurfaces(projectSurfaces, selectedTabKey),
    [projectSurfaces, selectedTabKey],
  );
  const sidebarFilePreviewVisible = sidebarFilePreviewIsVisible({
    previewActive: sidebarFilePreview?.active ?? false,
    previewExplorerAvailable: Boolean(sidebarPreviewExplorer),
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
  });
  const {
    projectSidebarSurfaces,
    projectTabBarSurfaces,
    selectedGroupSurfaces,
    selectedTabGroup,
    showSidebarPreviewTab,
  } = workspaceGroupSelection({
    projectSurfaceIndex,
    sidebarFilePreview,
    tabLayout: tabLayout.data,
    workspaceSelection,
  });
  const selectedProjectView =
    !sidebarFilePreviewVisible &&
    (selectedSurface?.kind === "history" ||
      selectedSurface?.kind === "issues" ||
      selectedSurface?.kind === "remote-desktop")
      ? selectedSurface.entity
      : undefined;
  const gitHistoryProject =
    selectedProject?.capabilities.git &&
    (selectedProjectView?.kind === "history" ||
      selectedProjectView?.kind === "issues")
      ? selectedProject
      : undefined;
  const projectOverviewGitSection: GitViewSection | null =
    activeProjectOverviewSection === "overview" ||
    activeProjectOverviewSection === "tasks"
      ? null
      : activeProjectOverviewSection;
  const projectOverviewGitProject =
    projectOverviewSelected &&
    projectOverviewGitSection &&
    selectedProject?.capabilities.git
      ? selectedProject
      : undefined;
  const displayedGitProject = gitHistoryProject ?? projectOverviewGitProject;
  const resolvedProjectOverviewWorktreeId = (worktrees.data ?? []).some(
    ({ id }) => id === projectOverviewWorktreeId,
  )
    ? projectOverviewWorktreeId
    : (worktrees.data?.find(({ isPrimary }) => isPrimary)?.id ??
      worktrees.data?.[0]?.id ??
      null);
  const selectedChat =
    !sidebarFilePreviewVisible && selectedSurface?.kind === "chat"
      ? selectedSurface.entity
      : undefined;
  const activeProjectTaskChat = activeProjectTaskChatId
    ? chats.data?.find(({ id }) => id === activeProjectTaskChatId)
    : undefined;
  const activeProjectTaskView =
    activeProjectTaskChat && taskChatViewIds.has(activeProjectTaskChat.id)
      ? ("chat" as const)
      : ("task" as const);
  const setActiveProjectTaskView = (view: "task" | "chat") => {
    if (!activeProjectTaskChat) return;
    setTaskChatViewIds((current) => {
      const next = new Set(current);
      if (view === "chat") next.add(activeProjectTaskChat.id);
      else next.delete(activeProjectTaskChat.id);
      return next;
    });
  };
  const activeChat = activeProjectTaskChat ?? selectedChat;
  const completionAcknowledgementAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    completionAcknowledgementAttemptRef.current = null;
  }, [selectedChat?.id]);
  useEffect(() => {
    if (!selectedChat?.hasUnreadCompletion) {
      completionAcknowledgementAttemptRef.current = null;
      return;
    }
    const acknowledgeIfActive = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        completionAcknowledgementAttemptRef.current === selectedChat.id
      ) {
        return;
      }
      completionAcknowledgementAttemptRef.current = selectedChat.id;
      acknowledgeSelectedChatCompletion({
        chatId: selectedChat.id,
        projectId: selectedChat.projectId,
      });
    };
    acknowledgeIfActive();
    window.addEventListener("focus", acknowledgeIfActive);
    document.addEventListener("visibilitychange", acknowledgeIfActive);
    return () => {
      window.removeEventListener("focus", acknowledgeIfActive);
      document.removeEventListener("visibilitychange", acknowledgeIfActive);
    };
  }, [
    acknowledgeSelectedChatCompletion,
    selectedChat?.hasUnreadCompletion,
    selectedChat?.id,
    selectedChat?.projectId,
  ]);
  const standaloneCompletionAcknowledgementAttemptRef = useRef<string | null>(
    null,
  );
  useEffect(() => {
    standaloneCompletionAcknowledgementAttemptRef.current = null;
  }, [selectedStandaloneChat?.id]);
  useEffect(() => {
    if (appMode !== "chat" || !selectedStandaloneChat?.hasUnreadCompletion) {
      standaloneCompletionAcknowledgementAttemptRef.current = null;
      return;
    }
    const acknowledgeIfActive = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        standaloneCompletionAcknowledgementAttemptRef.current ===
          selectedStandaloneChat.id
      ) {
        return;
      }
      standaloneCompletionAcknowledgementAttemptRef.current =
        selectedStandaloneChat.id;
      acknowledgeSelectedStandaloneChatCompletion(selectedStandaloneChat.id);
    };
    acknowledgeIfActive();
    window.addEventListener("focus", acknowledgeIfActive);
    document.addEventListener("visibilitychange", acknowledgeIfActive);
    return () => {
      window.removeEventListener("focus", acknowledgeIfActive);
      document.removeEventListener("visibilitychange", acknowledgeIfActive);
    };
  }, [
    acknowledgeSelectedStandaloneChatCompletion,
    appMode,
    selectedStandaloneChat?.hasUnreadCompletion,
    selectedStandaloneChat?.id,
  ]);
  const selectedStandaloneTerminal =
    !sidebarFilePreviewVisible && selectedSurface?.kind === "terminal"
      ? selectedSurface.entity
      : undefined;
  const linkedConsoleTerminal =
    activeChat && chatConsoleOpenChats.has(activeChat.id)
      ? terminals.data?.find(
          (terminal) => terminal.linkedChatId === activeChat.id,
        )
      : undefined;
  const selectedTerminal = selectedStandaloneTerminal ?? linkedConsoleTerminal;
  const linkedConsoleChat = linkedConsoleTerminal ? activeChat : undefined;
  const ownedTerminals = useMemo(() => {
    const owned = new Map<string, TerminalSummary>();
    for (const surface of projectSurfaces) {
      if (
        surface.kind === "terminal" &&
        surface.entity.kind !== "run-configuration"
      ) {
        owned.set(surface.entity.id, surface.entity);
      }
    }
    for (const terminal of terminals.data ?? []) {
      if (
        terminal.linkedChatId &&
        chatConsoleOpenChats.has(terminal.linkedChatId)
      ) {
        owned.set(terminal.id, terminal);
      }
    }
    return [...owned.values()];
  }, [chatConsoleOpenChats, projectSurfaces, terminals.data]);
  const selectedRunRuntime: RunConfigurationRuntime | null = selectedTerminal
    ? runtimeForRunTerminal(
        selectedTerminal,
        runConfigurationRuntimes.data ?? [],
      )
    : null;
  const selectedRunDefinitionAvailable =
    selectedTerminal?.kind === "run-configuration" &&
    runConfigurations.isSuccess
      ? Boolean(
          runConfigurations.data.entries.some(
            (entry) =>
              entry.status === "ready" &&
              entry.id === selectedTerminal.runConfigurationId,
          ),
        )
      : null;
  const selectedRunTargetControl =
    selectedTerminal?.kind === "run-configuration" &&
    selectedTerminal.runConfigurationId &&
    workers.isSuccess &&
    worktrees.isSuccess
      ? runConfigurationTargetControlForIdentity({
          configurationId: selectedTerminal.runConfigurationId,
          inventory: runConfigurations.data,
          runtimes: runConfigurationRuntimes.data ?? [],
          workers: workers.data,
          worktreeId: selectedTerminal.worktreeId,
          worktrees: worktrees.data,
        })
      : null;
  const selectedRunTargetAvailabilityProblem =
    selectedTerminal?.kind !== "run-configuration"
      ? null
      : workers.isError
        ? `Could not load the target worker: ${errorText(workers.error)}`
        : worktrees.isError
          ? `Could not load the target worktree: ${errorText(worktrees.error)}`
          : workers.isSuccess &&
              worktrees.isSuccess &&
              !selectedRunTargetControl
            ? "The target worktree is unavailable."
            : null;
  const selectedRunLaunchAvailable =
    selectedTerminal?.kind !== "run-configuration"
      ? null
      : selectedRunDefinitionAvailable !== true
        ? selectedRunDefinitionAvailable
        : selectedRunTargetAvailabilityProblem
          ? false
          : !workers.isSuccess || !worktrees.isSuccess
            ? null
            : (selectedRunTargetControl?.available ?? false);
  const selectedRunLaunchProblem =
    selectedRunDefinitionAvailable === true
      ? (selectedRunTargetAvailabilityProblem ??
        selectedRunTargetControl?.reason ??
        null)
      : null;
  const selectedRunStopAvailable =
    selectedTerminal?.kind !== "run-configuration"
      ? null
      : selectedRunTargetAvailabilityProblem
        ? false
        : !workers.isSuccess || !worktrees.isSuccess
          ? null
          : (selectedRunTargetControl?.stopAvailable ?? false);
  const selectedRunStopProblem =
    selectedRunTargetAvailabilityProblem ??
    selectedRunTargetControl?.stopReason ??
    null;
  const selectedRunTargetLabel = selectedTerminal
    ? runTerminalTargetLabel(selectedTerminal, worktrees.data ?? [])
    : "Unavailable worktree";
  const openTerminalLink = (url: string) => {
    if (!selectedTerminal || !selectedTabGroup) return;
    newBrowser.mutate({
      projectId: selectedTerminal.projectId,
      tabGroupId: selectedTabGroup.id,
      target: {
        kind: "worker",
        projectId: selectedTerminal.projectId,
        workerId: selectedTerminal.activeWorkerId,
      },
      title: terminalLinkBrowserTitle(url),
      url,
    });
  };
  const openTerminalLinkExternally = (url: string) => {
    void openExternalUrl(url).catch((error: unknown) =>
      setPopoutError(errorText(error)),
    );
  };
  const chatRelocations = useQuery({
    enabled: Boolean(
      activeChat &&
      selectedProject?.capabilities.relocation &&
      bootstrap.data?.capabilities.workerSwitching,
    ),
    queryFn: () => getChatRelocations(activeChat!.id),
    queryKey: ["chat-relocation-jobs", activeChat?.id],
    refetchInterval: (query) =>
      projectResourcesLive
        ? false
        : query.state.data?.some((job) => isChatRelocationActive(job))
          ? 2_000
          : 10_000,
    retry: false,
  });
  const activeRelocation = activeChatRelocationJob(chatRelocations.data ?? []);
  const latestRelocation = latestChatRelocationJob(chatRelocations.data ?? []);
  const currentRelocation = activeRelocation ?? latestRelocation;
  const selectedExplorer = sidebarFilePreviewVisible
    ? (sidebarPreviewExplorer ?? undefined)
    : selectedSurface?.kind === "explorer"
      ? selectedSurface.entity
      : undefined;
  const selectedBrowser =
    !sidebarFilePreviewVisible && selectedSurface?.kind === "browser"
      ? selectedSurface.entity
      : undefined;
  const selectedCodeTab =
    !sidebarFilePreviewVisible && selectedSurface?.kind === "code"
      ? selectedSurface.entity
      : undefined;
  const visibleWorkerObservationDemands = useMemo(() => {
    const visibleWorktreeIds = new Set(
      [
        sidebarExplorer?.worktreeId,
        selectedExplorer?.worktreeId,
        selectedTerminal?.worktreeId,
        selectedCodeTab?.worktreeId,
        selectedProjectView?.worktreeId,
        projectOverviewSelected ? resolvedProjectOverviewWorktreeId : null,
      ].filter((worktreeId): worktreeId is string => Boolean(worktreeId)),
    );
    return workspaceWorkerObservationDemands({
      projectBroadWorkerIds: [
        selectedProjectWorkerId,
        selectedTerminal?.activeWorkerId,
        selectedCodeTab?.activeWorkerId,
        ...ownedTerminals.map((terminal) => terminal.activeWorkerId),
        ...(worktrees.data ?? [])
          .filter((worktree) => visibleWorktreeIds.has(worktree.id))
          .map((worktree) => worktree.workerId),
      ],
      projectChatWorkerId: activeChat?.activeWorkerId,
      projectFilesystemWorkerIds: [
        sidebarExplorer?.activeWorkerId,
        sidebarFileWorkerId,
        selectedExplorer?.activeWorkerId,
      ],
      projectVisible:
        appMode === "ide" &&
        (appActionView === "project" || appActionView === "popout"),
      standaloneChatWorkerId:
        appMode === "chat" ? selectedStandaloneChat?.activeWorkerId : null,
    });
  }, [
    activeChat?.activeWorkerId,
    appActionView,
    appMode,
    projectOverviewSelected,
    ownedTerminals,
    resolvedProjectOverviewWorktreeId,
    selectedCodeTab?.activeWorkerId,
    selectedCodeTab?.worktreeId,
    selectedExplorer?.activeWorkerId,
    selectedExplorer?.worktreeId,
    selectedProjectView?.worktreeId,
    selectedProjectWorkerId,
    selectedStandaloneChat?.activeWorkerId,
    selectedTerminal?.activeWorkerId,
    selectedTerminal?.worktreeId,
    sidebarExplorer?.activeWorkerId,
    sidebarExplorer?.worktreeId,
    sidebarFileWorkerId,
    worktrees.data,
  ]);
  useWorkerObservationDemands(visibleWorkerObservationDemands);
  const activeWorktreeTarget: WorktreeBindingTarget | null = activeChat
    ? {
        kind: "chat",
        projectId: activeChat.projectId,
        tabId: activeChat.id,
        mode: activeChat.worktreeMode,
      }
    : selectedTerminal && selectedTerminal.kind !== "run-configuration"
      ? {
          kind: "terminal",
          projectId: selectedTerminal.projectId,
          tabId: selectedTerminal.id,
        }
      : selectedExplorer
        ? {
            kind: "explorer",
            projectId: selectedExplorer.projectId,
            tabId: selectedExplorer.id,
          }
        : selectedCodeTab
          ? {
              kind: "code",
              projectId: selectedCodeTab.projectId,
              tabId: selectedCodeTab.id,
            }
          : selectedProjectView?.kind === "history"
            ? {
                kind: "history",
                projectId: selectedProjectView.projectId,
                tabId: selectedProjectView.id,
              }
            : null;
  const activeWorktreeId = activeChat
    ? activeChat.activeWorktreeId
    : selectedTerminal
      ? selectedTerminal.worktreeId
      : selectedExplorer
        ? selectedExplorer.worktreeId
        : selectedCodeTab
          ? selectedCodeTab.worktreeId
          : selectedProjectView?.kind === "history"
            ? selectedProjectView.worktreeId
            : null;
  const activeWorktree = worktrees.data?.find(
    (worktree) => worktree.id === activeWorktreeId,
  );
  const scriptCommandWorktreeId =
    appActionView === "project" ? activeWorktreeId : null;
  const runProjectScriptCommand = async (command: ScriptCommand) => {
    if (!selectedProject) {
      throw new Error("Select a project before running a project script.");
    }
    const currentSurface =
      appActionView === "project" ? (selectedSurface ?? null) : null;
    const destination = projectScriptCommandDestination({
      activeWorktreeId: scriptCommandWorktreeId,
      currentSurface,
      selectedTerminal:
        currentSurface?.kind === "terminal"
          ? selectedStandaloneTerminal?.kind === "run-configuration"
            ? null
            : (selectedStandaloneTerminal ?? null)
          : null,
    });
    const input = terminalCommandInput(command);
    if (destination.kind === "current-terminal") {
      setPendingTerminalInputs((current) => [
        ...current,
        {
          data: input,
          id: crypto.randomUUID(),
          terminalId: destination.terminalId,
        },
      ]);
      return;
    }
    await newTerminal.mutateAsync({
      initialInput: input,
      projectId: selectedProject.id,
      tabGroupId: destination.tabGroupId,
      worktreeId: destination.worktreeId,
    });
  };
  const selectedWorkerId =
    selectedProjectView?.kind === "remote-desktop"
      ? remoteDesktop.data?.workerId
      : (activeChat?.activeWorkerId ??
        selectedCodeTab?.activeWorkerId ??
        selectedBrowser?.workerId ??
        activeWorktree?.workerId ??
        selectedProjectWorkerId);
  const selectedWorker = workers.data?.find(
    (worker) => worker.workerId === selectedWorkerId,
  );
  const activeExplorerHeader = sidebarFilePreviewVisible
    ? sidebarFilePreviewHeader
    : explorerHeader;
  const explorerDisplayPath = selectedExplorer
    ? `${activeWorktree?.displayPath ?? selectedProject?.source?.displayPath ?? "Explorer"}${activeExplorerHeader?.directoryPath ? `/${activeExplorerHeader.directoryPath}` : ""}`
    : null;
  const bindChatWorktree = (
    chat: ChatSummary,
    worktreeId: string,
    mode = chat.worktreeMode,
  ) =>
    bindWorktreeMutation.mutate({
      target: {
        kind: "chat",
        projectId: chat.projectId,
        tabId: chat.id,
        mode: chat.worktreeMode,
      },
      worktreeId,
      mode,
    });
  const openChatTerminalHere = (chat: ChatSummary) =>
    newTerminal.mutate({
      projectId: chat.projectId,
      worktreeId: chat.activeWorktreeId,
    });
  const openChatExplorerHere = (chat: ChatSummary) =>
    newExplorer.mutate({
      projectId: chat.projectId,
      worktreeId: chat.activeWorktreeId,
    });
  const openChatHistoryHere = (chat: ChatSummary) =>
    newProjectView.mutate({
      projectId: chat.projectId,
      kind: "history",
      worktreeId: chat.activeWorktreeId,
    });
  const currentSurface = useMemo<{
    tabKey: string;
    title: string;
  } | null>(() => {
    if (
      showImporter ||
      showSettings ||
      showServerAdmin ||
      showProjectSettings
    ) {
      return null;
    }
    if (!selectedSurface) return null;
    return {
      tabKey: selectedSurface.tabKey,
      title:
        selectedSurface.kind === "chat" && linkedConsoleTerminal
          ? `${selectedSurface.title} · Codex console`
          : selectedSurface.title,
    };
  }, [
    linkedConsoleTerminal,
    selectedSurface,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
  ]);
  const desktopPopout = useDesktopPopoutModel({
    activeProjectOverviewSection,
    currentSurface,
    desktopRuntime,
    detached: detachedDesktopGroup,
    explorerLifecycleRef,
    isPopout,
    projectOverviewSelected,
    queryClient,
    resolvedProjectOverviewWorktreeId,
    selectedExplorer,
    selectedProject,
    selectedProjectId,
    selectedTabGroupId: selectedTabGroup?.id ?? null,
    status: desktopPopoutStatus,
  });
  const {
    activePopout,
    activeProjectOverviewPopout,
    groupOwnedElsewhere,
    popOutActiveView,
    popOutProjectOverviewView,
  } = desktopPopout;
  const activeContentKey = showImporter
    ? "importer"
    : showSettings
      ? "settings"
      : showServerAdmin
        ? "server-admin"
        : showProjectSettings
          ? `project-settings:${selectedProjectId ?? "none"}`
          : currentSurface
            ? `${currentSurface.tabKey}:${gitHistoryHeader?.section ?? "content"}`
            : `project:${selectedProjectId ?? "none"}:${activeProjectOverviewSection}`;
  useEffect(() => {
    setChatRelocationOpen(false);
  }, [activeChat?.id]);
  useDesktopPopoutEffects({
    currentSurface,
    desktopRuntime,
    detached: detachedDesktopGroup,
    isPopout,
    model: desktopPopout,
    projectOverviewPopoutTarget,
    selectedProject,
  });
  useContentScrollChrome({
    activeContentKey,
    contentRootRef,
    isPopout,
    scrolledContentRef,
    setContentScrolled,
  });
  const {
    beginSidebarResize,
    finishSidebarResize,
    moveSidebarResize,
    resizeSidebarWithKeyboard,
  } = useSidebarResizeController({
    configuredWidth: settings.data?.preferences.sidebarWidth,
    saveSidebarWidth,
    setSidebarResizing,
    setSidebarWidth,
    sidebarRef,
    sidebarResizeBodyStyleRef,
    sidebarResizeLeftRef,
    sidebarResizePointerIdRef,
    sidebarResizeStartWidthRef,
    sidebarWidthRef,
  });

  const showChatConsole = (chat: ChatSummary) => {
    const existing = terminals.data?.find(
      (terminal) => terminal.linkedChatId === chat.id,
    );
    if (existing) {
      setChatConsoleOpen(chat.id, true);
    } else {
      openChatConsole.mutate(chat.id);
    }
  };
  useShellAppearanceEffects({
    preferences: settings.data?.preferences,
    proModeActive,
    setCodeAppearance,
    setProModeActive,
  });

  useEffect(() => {
    if (!projectWorkspaces.data?.length) return;
    const resolved =
      projectWorkspaces.data.find(
        ({ id }) => id === activeProjectWorkspaceId,
      ) ??
      projectWorkspaces.data.find(({ isDefault }) => isDefault) ??
      projectWorkspaces.data[0]!;
    if (resolved.id === activeProjectWorkspaceId) return;
    setActiveProjectWorkspaceId(resolved.id);
    window.localStorage.setItem(activeProjectWorkspaceStorageKey, resolved.id);
  }, [
    activeProjectWorkspaceId,
    activeProjectWorkspaceStorageKey,
    projectWorkspaces.data,
  ]);

  useShellStartupNavigation({
    activeProjectWorkspaceStorageKey,
    isPopout,
    navigation: {
      setAppMode,
      setSelectedProjectId,
      setSelectedStandaloneChatId,
      startupNavigationResolvedRef,
    },
    popoutProjectId,
    projectWorkspaces,
    projects,
    selectedProjectId,
    setActiveProjectWorkspaceId,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
    settings,
    standaloneChats,
  });

  useProjectSelectionReconciliation({
    compactShell,
    explorerFileTarget,
    navigation: {
      appMode,
      selectedProjectId,
      setSelectedProjectId,
      setSelectedWorkflowIntentId,
      setShowImporter,
      setShowProjectSettings,
      setShowSettings,
      showServerAdmin,
      showSettings,
      startupNavigationResolvedRef,
    },
    projects: projects.data,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
    visibleProjects,
  });

  useEffect(() => {
    if (!createdRepositoryOnboarding) return;
    const action = githubRepositoryOnboardingAction(
      createdRepositoryOnboarding.projectId,
      projects.data,
    );
    if (action === "wait") return;
    const { openInitialChat, projectId } = createdRepositoryOnboarding;
    setCreatedRepositoryOnboarding(null);
    if (action === "create-chat") {
      newChat.mutate({ open: openInitialChat, projectId });
    }
  }, [createdRepositoryOnboarding, projects.data]);

  useWorkspaceSelectionReconciliation({
    layout: tabLayout.data,
    pendingSurfaceSelection,
    selectedProjectId,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
  });

  useOrphanedDesktopPopoutEffect({
    isLayoutMutationPending: tabLayoutMutation.isPending,
    layout: tabLayout.data,
    layoutIsSuccess: tabLayout.isSuccess,
    popoutTarget,
  });

  const {
    closeCompactProject,
    openCompactRootSettings,
    openServerAdmin,
    returnToCompactProjectOverview,
    revealWorkspace,
    selectProjectFromCommandBar,
    selectProjectFromSidebar,
    selectProjectWorkspace,
    selectStandaloneChat,
    switchToChat,
    switchToIde,
  } = createShellNavigationCommands({
    activeProjectWorkspace,
    activeProjectWorkspaceStorageKey,
    compactShell,
    isPopout,
    navigation: {
      selectedProjectId,
      selectedStandaloneChatId,
      setAppMode,
      setProjectOverviewSection,
      setProjectOverviewWorktreeId,
      setSelectedProjectId,
      setSelectedStandaloneChatId,
      setSelectedWorkflowIntentId,
      setSettingsSection,
      setShowArchivedStandaloneChats,
      setShowImporter,
      setShowProjectSettings,
      setShowServerAdmin,
      setShowSettings,
    },
    persistAppDestination,
    projects: projects.data,
    projectWorkspaces: projectWorkspaces.data,
    setActiveProjectWorkspaceId,
    setCommandBarOpen,
    setDesktopSidebarDrawerOpen,
    setDetachedGroupId,
    setFolderProjectDialogOpen,
    setPendingSurfaceSelection,
    setSidebarFilePreview,
    setWorkspaceSelection,
    settings: settings.data,
    visibleProjects,
  });
  useShellClientControlNavigation({
    activeProjectWorkspace,
    activeProjectWorkspaceStorageKey,
    chats: chats.data,
    openCreatedTab,
    openProjectTask,
    projectWorkspaces: projectWorkspaces.data,
    projects: projects.data,
    queryClient,
    selectProjectFromCommandBar,
    showAppToast,
  });
  const selectTopTab = (tabKey: string) => {
    setSidebarFilePreview((current) =>
      current ? { ...current, active: false } : null,
    );
    const layout = tabLayout.data;
    if (layout) {
      setWorkspaceSelection((current) =>
        selectWorkspaceTab(current, layout, tabKey),
      );
    } else if (selectedProjectId) {
      setPendingSurfaceSelection({ projectId: selectedProjectId, tabKey });
    }
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const { focusDetachedGroup, selectGroupFromSidebar } =
    createDesktopGroupSelectionCommands({
      desktopRuntime,
      detached: detachedDesktopGroup,
      isPopout,
      layout: tabLayout.data,
      model: desktopPopout,
      revealWorkspace,
      setPopoutError,
      setSidebarFilePreview,
      setWorkspaceSelection,
    });
  const {
    activateSidebarFilePreview,
    closeSidebarFilePreview,
    deleteSidebarFileEntry,
    openSidebarFilePreview,
    openSidebarFolderGraph,
    openSidebarFolderNative,
    openSidebarFolderTerminal,
    pinSidebarFile,
    pinSidebarFilePath,
    renameSidebarFileEntry,
    retrySidebarFileTree,
  } = createSidebarExplorerCommands({
    abandonSidebarFilePinHandoff,
    createSidebarExplorerMutation,
    explorers: explorers.data,
    fileState: sidebarFileState,
    lifecycle: explorerLifecycle,
    newGraphExplorer,
    newTerminal,
    openCreatedTab,
    pinSidebarFileMutation,
    projects: projects.data,
    queryClient,
    revealWorkspace,
    selectedTabGroup,
    setDesktopSidebarDrawerOpen,
    setDetachedGroupId,
    setPopoutError,
    setWorkspaceSelection,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    tabLayout: tabLayout.data,
    worktrees: worktrees.data,
  });
  const {
    createProjectSurface,
    creatingSurfaceKinds,
    deleteSurface,
    deleteSurfaceImmediately,
    renameSurface,
    surfaceCreationFailure,
  } = createSurfaceCommandController({
    creation: {
      browser: newBrowser,
      chat: newChat,
      code: newCodeTab,
      explorer: newExplorer,
      projectView: newProjectView,
      remoteDesktop: newRemoteDesktop,
      terminal: newTerminal,
    },
    crud: {
      browser: {
        delete: deleteBrowserMutation,
        rename: updateBrowserMutation,
      },
      chat: { delete: deleteChatMutation, rename: renameChatMutation },
      code: { delete: deleteCodeTabMutation, rename: updateCodeTabMutation },
      explorer: {
        delete: deleteExplorerMutation,
        rename: renameExplorerMutation,
        requestDelete: requestDeleteExplorer,
      },
      projectView: {
        delete: deleteProjectViewMutation,
        rename: renameProjectViewMutation,
      },
      terminal: {
        delete: deleteTerminalMutation,
        rename: renameTerminalMutation,
      },
    },
  });

  const selectedPlacementContext: ProjectSurfacePlacementContext | undefined =
    selectedProject
      ? {
          capabilities: selectedProject.capabilities,
          projectId: selectedProject.id,
          replicas: selectedProject.replicas,
          workers: workers.data ?? [],
          worktrees: worktrees.data ?? [],
        }
      : undefined;

  const handleWorkspaceDrop = createWorkspaceDropHandler({
    projects: projects.data ?? [],
    reorderProjectsMutation,
    setWorkspaceDragError,
    tabLayoutMutation,
  });
  // Prettier keeps this mechanical boundary compact; the renderer divides it
  // into sidebar, header, persistent-surface, content-host, and overlay views.
  // prettier-ignore
  const renderBindings = {
    activateSidebarFilePreview, activeChat, activeExplorerHeader,
    activePopout, activeProjectOverviewPopout, activeProjectOverviewSection, activeProjectTaskChat, activeProjectTaskChatId,
    activeProjectTaskView, activeProjectWorkspace, activeRelocation, activeWorktree, activeWorktreeId,
    activeWorktreeTarget, agentInspectOpenChats, appActionContext, appMode,
    appToast, archiveStandaloneChat, archivedStandaloneChats, beginSidebarResize, bindChatWorktree,
    bindWorktreeMutation, bootstrap, browsers, chatRelocationOpen, chatRelocations,
    chats, closeCompactProject, closeProjectTask, closeSidebarFilePreview, codeAppearance,
    codeHeader, codeTabs, commandBarOpen, compactManagedHeader, compactShell,
    completeSidebarFilePinHandoff, contentRootRef, contentScrolled, createProjectSurface, createSidebarExplorerMutation,
    createWorkspaceMutation, createWorktreeMutation, creatingSurfaceKinds, currentRelocation, deleteBrowserMutation,
    deleteChatMutation, deleteCodeTabMutation, deleteExplorerMutation, deleteProjectViewMutation, deleteSidebarFileEntry,
    deleteSurface, deleteSurfaceImmediately, deleteTerminalMutation, desktopRuntime, desktopSidebarDrawer,
    desktopSidebarDrawerOpen, dismissedLongPathFailure, displayTerminals, displayedGitProject, executeAppAction,
    explorerDisplayPath, explorerFileTarget, explorerGraphRequest, explorers, finishSidebarResize,
    focusDetachedGroup, folderProjectDialogMode, folderProjectDialogOpen, folderRevealLabel, folderSetupJobs,
    forkChatMutation, forkStandaloneChat, gitHistoryHeader, gitHistoryProject, groupOwnedElsewhere,
    handleExplorerChanged, handleExplorerLifecycleChange, handleSidebarFilePreviewLifecycleChange, handleWorkspaceDrop, isPopout,
    linkedConsoleChat, mobileNavigationSurfaces, mobileProjectSelectorOpen, moveSidebarResize,
    narrowViewport, newBrowser, newChat, newCodeTab, newExplorer,
    newProjectView, newRemoteDesktop, newStandaloneChat, newTask, newTerminal,
    onlineWorker, onlineWorkerIds, openChatConsole, openChatExplorerHere, openChatFileLink,
    openChatHistoryHere, openChatTerminalHere, openCompactRootSettings, openCreatedProject, openCreatedTab,
    openExplorerFileWindow, openExplorers, openProjectCreateSource, openProjectExplorerFile, ownedTerminals,
    openProjectSettings, openProjectTask, openServerAdmin, openSidebarFilePreview, openSidebarFolderGraph,
    openSidebarFolderNative, openSidebarFolderTerminal, openTerminalLink, openTerminalLinkExternally, openTunnelOwner,
    overlayTitlebar, pendingTerminalInputs, permanentlyDeleteStandaloneChat, pinSidebarFile, pinSidebarFileMutation,
    pinSidebarFilePath, popOutActiveView, popOutProjectOverviewView, popoutError, popoutPending,
    prepareExplorerRebind, projectOverviewGitProject, projectOverviewGitSection, projectOverviewPopoutTarget, projectOverviewSelected,
    projectRevealButtonLabel, projectRevealLabel, projectSettingsSection, projectSetupJobs, projectSidebarSurfaces, projectSurfaces,
    projectTabBarSurfaces, projectTaskChatIds, projectTokenUsage, projectViews, projectWorkspaces,
    projects, queryClient, remoteDesktop,
    removeProjectMutation, renameChatMutation, renameExplorerMutation, renameProjectViewMutation, renameSidebarFileEntry,
    renameStandaloneChat, renameSurface, renameTabGroupMutation, renameTerminalMutation, repositoryStats,
    requestBindWorktree, requestDeleteExplorer, resizeSidebarWithKeyboard, resolvedProjectOverviewWorktreeId, restoreStandaloneChat,
    retryFolderSetupMutation, retryLongPathSetupMutation, retrySidebarFileTree, returnToCompactProjectOverview, revealWorkspace,
    runConfigurationEditorId, runConfigurationRuntimes, runConfigurations, runProjectScriptCommand, scriptCommandWorktreeId,
    selectGroupFromSidebar, selectProjectFromCommandBar,
    selectProjectFromSidebar, selectProjectWorkspace, selectStandaloneChat, selectTopTab, selectedBrowser,
    selectedChat, selectedCodeTab, selectedExplorer, selectedFolderSetupJob, selectedFolderSetupNeedsAttention,
    selectedGroupSurfaces, selectedLongPathFailure, selectedLongPathSetupJob, selectedPlacementContext, selectedProject,
    selectedProjectId, selectedProjectSetupJob, selectedProjectView, selectedProjectWorkerId, selectedRunDefinitionAvailable,
    selectedRunLaunchAvailable, selectedRunLaunchProblem, selectedRunRuntime, selectedRunStopAvailable, selectedRunStopProblem,
    selectedRunTargetLabel, selectedStandaloneChat, selectedStandaloneChatId, selectedStandaloneTerminal, selectedSurface,
    selectedTabGroup, selectedTabKey, selectedTerminal, selectedWorker, selectedWorkflowIntentId,
    setActiveProjectTaskView, setAgentInspectOpen, setAppToast, setChatConsoleOpen, setChatRelocationOpen,
    setCodeHeader, setCommandBarOpen, setDesktopSidebarDrawerOpen, setDismissedLongPathFailure, setExplorerHeader,
    setFolderProjectDialogMode, setFolderProjectDialogOpen, setGitHistoryHeader, setPendingSurfaceSelection,
    setPendingTerminalInputs, setProjectOverviewSection, setProjectOverviewWorktreeId, setRunConfigurationEditorId, setSettingsPolicyId,
    setSettingsSection, setShowArchivedStandaloneChats, setShowCustomizations, setShowImporter, setShowProjectSettings,
    setShowServerAdmin, setShowSettings, setSidebarCollapsed, setSidebarFilePreviewHeader, setStandaloneFilePath,
    setStandaloneFilesOpen, setTerminalCommandPaletteTerminalId, setTerminalServiceTerminalId, setWorkspaceDragError, setWorktreeCreateTarget,
    settings, settingsPolicyId, settingsSection, showAppToast, showArchivedStandaloneChats,
    showChatConsole, showContentTitlebar, showCustomizations, showImporter, showProjectSettings,
    showServerAdmin, showSettings, showSidebarPreviewTab, sidebarCollapsed, sidebarExplorer,
    sidebarFilePinHandoff, sidebarFilePreview, sidebarFilePreviewVisible, sidebarFileWorkerId, sidebarFileWorkerOnline,
    sidebarInlineExplorer, sidebarPreviewExplorer, sidebarPreviewSuccessorExplorer, sidebarRef, sidebarResizing, sidebarWidth,
    standaloneChatCreationAvailable, standaloneChatCreationUnavailableReason, standaloneChatWorkerAvailable, standaloneChats, standaloneFilePath,
    standaloneFilesOpen, stopAndDeleteRunTerminalMutation, surfaceCreationFailure, switchToChat, switchToIde,
    tabLayout, terminalCommandPaletteTerminalId, terminalServiceTerminalId, updateBrowserMutation, updateCodeTabMutation,
    visibleProjects, workers, workspaceDragError, workspaceSelection, worktreeActionError,
    worktreeCreateTarget, worktreeStatuses, worktrees,
  };
  return <ApplicationShellRender bindings={renderBindings} />;
}
