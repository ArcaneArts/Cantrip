import { DEFAULT_ELITE_REVEAL_CONFIG } from "@cantrip/protocol";
import type {
  BrowserFleetService,
  ChatSummary,
  ProjectViewSummary,
  RemoteDesktopTarget,
  ScriptCommand,
  TaskDetail,
} from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Code2,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe2,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  WandSparkles,
  WifiOff,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EliteGlobalEffects } from "@/components/elite/elite-global-effects";
import { RunConfigurationControl } from "@/components/run/run-configuration-control";
import { AppCommandBar } from "@/components/app/app-command-bar";
import {
  projectOverviewSectionLabel,
  type WorktreeBindingTarget,
} from "@/components/app/application-shell-model";
import {
  createDesktopGroupSelectionCommands,
  useDesktopPopoutEffects,
  useDesktopPopoutModel,
  useDesktopPopoutStatusState,
  useDetachedDesktopGroupState,
  useOrphanedDesktopPopoutEffect,
} from "@/components/app/desktop-popout-lifecycle";
import {
  createMobileProjectNavigationCommands,
  mobileProjectShellModel,
  resetMobileProjectNavigation,
  useMobileBottomTabsPersistence,
  useMobileProjectNavigationEffects,
  useMobileProjectNavigationModel,
  useMobileProjectNavigationRefs,
  useMobileProjectNavigationState,
} from "@/components/app/mobile-project-navigation";
import {
  BrowserView,
  PersistentCodeViews,
  PersistentExplorerViews,
  RemoteDesktopView,
  RunTerminalView,
  TerminalView,
} from "@/components/app/application-shell-surfaces";
import { StatusDot } from "@/components/app/status-dot";
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
import { ArchivedStandaloneChatsPage } from "@/components/chat/archived-standalone-chats-page";
import { updateAgentInspectOpenChats } from "@/components/chat/agent-inspect-panel";

import { CustomizationPanel } from "@/components/chat/customization-panel";
import { updateChatConsoleOpenChats } from "@/components/chat/chat-console-state";
import {
  activeChatRelocationJob,
  ChatRelocationDialog,
  isChatRelocationActive,
  latestChatRelocationJob,
} from "@/components/chat/chat-relocation-dialog";
import type { CodeHeaderState } from "@/components/code/code-view";

import {
  GitHistoryView,
  type GitHistoryHeaderState,
  type GitViewSection,
} from "@/components/git/git-history";
import { ExplorerFilePopout } from "@/components/explorer/explorer-file-popout";

import { explorerRepositoryGraphAvailable } from "@/components/explorer/explorer-graph-routing";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { StandaloneChatSidebar } from "@/components/sidebar/standalone-chat-sidebar";

import { ProjectTabBar } from "@/components/workspace/project-tab-bar";

import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import {
  ContentHeaderActions,
  ExplorerFileCloseButton,
  type ContentHeaderActionsProps,
} from "@/components/workspace/content-header-actions";
import { WorkspaceDndProvider } from "@/components/workspace/workspace-dnd-provider";
import { ProjectSwitcher } from "@/components/projects/project-switcher";
import {
  IDE_CHAT_SURFACE_CAPABILITIES,
  STANDALONE_CHAT_SURFACE_CAPABILITIES,
} from "@/components/chat/chat-surface-capabilities";
import { MobileBottomNavigation } from "@/components/mobile/mobile-bottom-navigation";
import { MobileProjectHeader } from "@/components/mobile/mobile-project-header";
import { MobileProjectSelector } from "@/components/mobile/mobile-project-selector";
import { MobileProjectTabGrid } from "@/components/mobile/mobile-project-tab-grid";
import { ProjectSettingsPage } from "@/components/projects/project-settings-page";
import { ProjectOverview } from "@/components/projects/project-overview";
import { ProjectOverviewNavigation } from "@/components/projects/project-overview-navigation";
import {
  ProjectTasksDashboard,
  projectTaskIsUnqueuedDraft,
} from "@/components/projects/project-tasks-dashboard";
import { WindowsLongPathDialog } from "@/components/projects/windows-long-path-dialog";
import {
  FolderProjectDialog,
  type FolderSourceMode,
} from "@/components/projects/folder-project-dialog";
import { ProjectCreateMenu } from "@/components/projects/project-create-menu";
import { RepositoryImporter } from "@/components/projects/repository-importer";
import { terminalLinkBrowserTitle } from "@/components/terminal/terminal-links";
import { terminalCommandInput } from "@/components/terminal/terminal-command-palette";
import { SettingsPage } from "@/components/settings/settings-page";
import { ServerAdminPage } from "@/components/servers/server-admin-page";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import {
  WorktreeControl,
  WorktreeCreateDialog,
} from "@/components/worktrees/worktree-control";
import { errorMessage as errorText } from "@/lib/error-message";
import { openExternalUrl } from "@/lib/external-url";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  APP_ACTION_IDS,
  projectIdForAppActionView,
  type AppActionContext,
  type AppActionId,
} from "@/lib/app-actions";
import { githubRepositoryOnboardingAction } from "@/lib/github-repository-onboarding";
import { PRIMARY_MOBILE_BOTTOM_TAB_ID } from "@/lib/mobile-navigation";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppToast, type AppToastInput } from "@/components/ui/app-toast";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { getChatRelocations, resolveStandaloneChatFilePath } from "@/lib/api";

import { runConfigurationTargetControlForIdentity } from "@/lib/run-configuration-control-model";

import {
  desktopPopoutTitlebarLeftInset,
  isMacosDesktopRuntime,
} from "@/lib/desktop-popout";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import { scopedClientStorageKey } from "@/lib/client-session";
import { useDesktopDirectTransportTelemetry } from "@/lib/direct-transport-telemetry";
import { useAppActions } from "@/lib/use-app-actions";
import { projectSurfaceTabKey } from "@/lib/project-surface";
import {
  runtimeForRunTerminal,
  runTerminalTargetLabel,
} from "@/lib/run-terminal-model";
import {
  sidebarFileName,
  sidebarFilePreviewIsVisible,
} from "@/lib/sidebar-file-tabs";
import { projectScriptCommandDestination } from "@/lib/project-script-command";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/lib/sidebar-resize";
import { cn } from "@/lib/utils";

import {
  isWindowsLongPathSetupFailure,
  projectOwningWorkerId,
  projectSetupFailureKey,
  projectSetupPercent,
} from "@/lib/project-setup-progress";
import {
  projectFolderSetupErrorMessage,
  projectReplicaProgressMessage,
  projectSetupErrorMessage,
} from "@/lib/job-status-message";

import { selectWorkspaceTab } from "@/lib/workspace-selection";
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
  const mobileProjectNavigation = useMobileProjectNavigationState();
  const { activeMobileBottomTabId, mobileTabGridOpen, setMobileTabGridOpen } =
    mobileProjectNavigation;
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
  const mobileProjectNavigationRefs = useMobileProjectNavigationRefs();

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

  const resetMobileBottomTabs = () => {
    resetMobileProjectNavigation(
      mobileProjectNavigation,
      mobileProjectNavigationRefs,
    );
  };

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
    resetMobileBottomTabs,
    setCreatedRepositoryOnboarding,
    setDesktopSidebarDrawerOpen,
    setFolderProjectDialogMode,
    setFolderProjectDialogOpen,
    setMobileTabGridOpen,
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
  const saveMobileBottomTabs = useMobileBottomTabsPersistence(queryClient);
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
      resetMobileBottomTabs,
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
      mobileTabGridOpen,
      projectOverviewSelected,
      selectedProject: Boolean(selectedProject),
      selectedProjectId,
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
  const mobileProjectNavigationModel = useMobileProjectNavigationModel({
    projectSurfaceIndex,
    selectedProjectId,
    state: mobileProjectNavigation,
    tabLayout: tabLayout.data,
    workspaceSelection,
  });
  const { activeMobileBottomTab, mobileBottomNavigationItems } =
    mobileProjectNavigationModel;
  const projectSurfaces = useMemo(
    () => [...projectSurfaceIndex.byTabKey.values()],
    [projectSurfaceIndex],
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

  useMobileProjectNavigationEffects({
    compactShell,
    model: mobileProjectNavigationModel,
    refs: mobileProjectNavigationRefs,
    saveMobileBottomTabs,
    selectedProjectId,
    settings,
    state: mobileProjectNavigation,
    tabLayout: tabLayout.data,
    workspaceSelection,
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
    resetMobileBottomTabs,
    setActiveProjectWorkspaceId,
    setCommandBarOpen,
    setDesktopSidebarDrawerOpen,
    setDetachedGroupId,
    setFolderProjectDialogOpen,
    setMobileTabGridOpen,
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
    setMobileTabGridOpen(false);
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
    setMobileTabGridOpen,
    setPopoutError,
    setWorkspaceSelection,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    tabLayout: tabLayout.data,
  });
  const {
    addMobileBottomTab,
    openMobileBottomTabSwitcher,
    removeActiveMobileBottomTab,
    removeMobileBottomTabById,
    selectGroupFromMobileSwitcher,
    selectMobileBottomTab,
    selectMobileOverview,
  } = createMobileProjectNavigationCommands({
    refs: mobileProjectNavigationRefs,
    selectGroup: selectGroupFromSidebar,
    selectedProjectId,
    setWorkspaceSelection,
    state: mobileProjectNavigation,
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
              setTerminalServiceTerminalId((current) =>
                current === selectedStandaloneTerminal.id
                  ? null
                  : selectedStandaloneTerminal.id,
              ),
          }
        : null,
    terminalCommandPalette:
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings &&
      selectedStandaloneTerminal &&
      selectedStandaloneTerminal.kind !== "run-configuration"
        ? {
            active:
              terminalCommandPaletteTerminalId ===
              selectedStandaloneTerminal.id,
            open: () =>
              setTerminalCommandPaletteTerminalId(
                selectedStandaloneTerminal.id,
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
    !(compactShell && mobileTabGridOpen) &&
    !groupOwnedElsewhere,
  );
  const explorerSurfaceVisible = Boolean(
    appMode === "ide" &&
    selectedExplorer &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !(compactShell && mobileTabGridOpen) &&
    !groupOwnedElsewhere,
  );
  if (explorerFileTarget) {
    const explorer =
      explorers.data?.find(({ id }) => id === explorerFileTarget.explorerId) ??
      null;
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
  return (
    <WorkspaceDndProvider
      className="flex h-svh overflow-hidden bg-background text-foreground"
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
                    onCreateWorkspace={async (name) => {
                      await createWorkspaceMutation.mutateAsync(name);
                    }}
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
                    terminals={displayTerminals}
                    workers={workers.data ?? []}
                    worktrees={worktrees.data ?? []}
                    worktreeStatuses={worktreeStatuses}
                    overviewSelected={projectOverviewSelected}
                    selectedProjectId={selectedProjectId}
                    selectedTabKey={selectedTabKey}
                    tabLayout={tabLayout.data ?? null}
                    fileExplorer={sidebarExplorer}
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
                      createSidebarExplorerMutation.isPending
                    }
                    fileTreePinningPath={
                      pinSidebarFileMutation.isPending
                        ? (pinSidebarFileMutation.variables?.path ?? null)
                        : null
                    }
                    fileTreeWorkerId={sidebarFileWorkerId}
                    fileTreeWorkerOnline={sidebarFileWorkerOnline}
                    fileRevealLabel={projectRevealButtonLabel ?? undefined}
                    onChangeChatWorktree={(chatId, worktreeId, mode) => {
                      const chat = chats.data?.find(({ id }) => id === chatId);
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
                    onRenameGroup={(groupId, title) => {
                      if (!selectedProjectId) return;
                      renameTabGroupMutation.mutate({
                        groupId,
                        projectId: selectedProjectId,
                        title,
                      });
                    }}
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
                    onRevealProject={revealProjectInNativeFileManager}
                    onSelectProject={selectProjectFromSidebar}
                    onSelectGroup={selectGroupFromSidebar}
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

      <section
        ref={contentRootRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {compactShell && showImporter ? (
          <MobileProjectHeader
            context={activeProjectWorkspace?.name ?? "Choose a repository"}
            onBack={closeCompactProject}
            title="GitHub repositories"
          />
        ) : compactShell && showSettings ? (
          <MobileProjectHeader
            context="Account preferences"
            onBack={closeCompactProject}
            title="Settings"
          />
        ) : compactShell && showArchivedStandaloneChats ? (
          <MobileProjectHeader
            context="Recover or permanently delete conversations"
            onBack={() => setShowArchivedStandaloneChats(false)}
            title="Archived chats"
          />
        ) : compactShell && showServerAdmin ? (
          <MobileProjectHeader
            context="Account access and server policy"
            onBack={closeCompactProject}
            title="Server administration"
          />
        ) : compactShell && showProjectSettings && selectedProject ? (
          <MobileProjectHeader
            actions={renderProjectRunConfigurationControl(true)}
            context={
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath
            }
            onBack={returnToCompactProjectOverview}
            title="Project settings"
          />
        ) : compactShell && mobileTabGridOpen && selectedProject ? (
          <MobileProjectHeader
            actions={renderProjectRunConfigurationControl(true)}
            context={`Tabs · ${
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath ??
              selectedProject.name
            }`}
            title={selectedProject.name}
          />
        ) : compactShell && projectOverviewSelected && selectedProject ? (
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
            context={
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath
            }
            onCloseProject={closeCompactProject}
            onOpenProjectSettings={() =>
              openProjectSettings(selectedProject.id)
            }
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
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "absolute size-8",
                  overlayTitlebar ? "left-20 top-1" : "left-4 top-4",
                )}
                onClick={() =>
                  desktopSidebarDrawer
                    ? setDesktopSidebarDrawerOpen(true)
                    : setSidebarCollapsed(false)
                }
                title={desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
              >
                <PanelLeftOpen className="size-4" />
                <span className="sr-only">
                  {desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
                </span>
              </Button>
            ) : null}
            <div
              className={cn(
                "min-w-0",
                overlayTitlebar &&
                  "flex flex-1 items-center gap-2 overflow-hidden",
                sidebarToggleVisible &&
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
                                  : selectedProjectView?.kind ===
                                      "remote-desktop"
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
                <Button
                  aria-pressed={standaloneFilesOpen}
                  onClick={() => setStandaloneFilesOpen((open) => !open)}
                  size="sm"
                  title="Open Chat files"
                  variant={standaloneFilesOpen ? "outline" : "ghost"}
                >
                  <FolderOpen className="size-4" />
                  Files
                </Button>
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
              {!isPopout && !compactShell && appMode === "ide" ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
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
                  </Button>
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
                <Button
                  aria-pressed={standaloneFilesOpen}
                  onClick={() => setStandaloneFilesOpen((open) => !open)}
                  size="sm"
                  title="Open Chat files"
                  variant={standaloneFilesOpen ? "outline" : "ghost"}
                >
                  <FolderOpen className="size-4" />
                  Files
                </Button>
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
            onLifecycleChange={handleExplorerLifecycleChange}
            onTransientLifecycleChange={handleSidebarFilePreviewLifecycleChange}
            onOpenFile={desktopRuntime ? openExplorerFileWindow : undefined}
            onRevealFolder={
              folderRevealLabel && selectedProject?.source
                ? async (explorer, entry, localFolder) => {
                    const project = projects.data?.find(
                      (candidate) => candidate.id === explorer.projectId,
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
            prewarmExplorer={!isPopout ? sidebarInlineExplorer : null}
          />
        </Suspense>

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
          selectedStandaloneChat ? (
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
          )
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
                <Button
                  variant="outline"
                  onClick={() => focusDetachedGroup(selectedTabGroup.id)}
                >
                  <ExternalLink className="size-4" />
                  Focus window
                </Button>
              </EmptyStateActions>
            </EmptyStateContent>
          </EmptyState>
        ) : selectedProjectView?.kind === "remote-desktop" ? (
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
                  worktrees.data?.find(({ isPrimary }) => isPrimary)?.id ??
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
              openProjectExplorerFile(displayedGitProject.id, worktreeId, path)
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
                const input = browserUpdateForPageState(selectedBrowser, state);
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
                    ({ terminalId }) => terminalId === selectedTerminal.id,
                  ) ?? null
                }
                onPendingInputSent={(inputId) =>
                  setPendingTerminalInputs((current) =>
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
          selectedProject.setupStatus !== "ready" ? (
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
                      : selectedFolderSetupJob?.error?.code === "worker-offline"
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
                            ) ?? "The worker could not prepare this project.")}
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
                      This folder is worker-bound. Cantrip will not move it to
                      another worker;{" "}
                      {selectedFolderSetupJob?.error?.code === "worker-offline"
                        ? "bring the owning worker online and retry."
                        : "resolve the reported setup problem on the owning worker."}
                    </p>
                    {selectedFolderSetupJob?.error?.retryable ? (
                      <Button
                        disabled={retryFolderSetupMutation.isPending}
                        onClick={() =>
                          retryFolderSetupMutation.mutate({
                            projectId: selectedProject.id,
                            stateRevision: selectedFolderSetupJob.stateRevision,
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
                    githubEnabled={Boolean(selectedProject.github)}
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
                  onConfigureWorkers={() => openCompactRootSettings("tasks")}
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
                  githubEnabled={selectedProject?.capabilities.github ?? false}
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
                      ({ workerId }) => workerId === selectedProjectWorkerId,
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
                  Start a Codex agent, shell, file explorer, Code workspace, or
                  browser in {selectedProject.name}.
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
                    disabled={newTerminal.isPending || !selectedProject.source}
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
                    disabled={newExplorer.isPending || !selectedProject.source}
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
                    disabled={newBrowser.isPending || !selectedProject.source}
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
                    disabled={newCodeTab.isPending || !selectedProject.source}
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
          )
        ) : (
          <EmptyState>
            <EmptyStateContent>
              <EmptyStateIcon>
                <Folder className="size-5" />
              </EmptyStateIcon>
              <EmptyStateTitle as="h1">Add your first project</EmptyStateTitle>
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
              !mobileTabGridOpen &&
              workspaceSelection.destination === "overview"
            }
          />
        ) : null}
      </section>

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

      <WorktreeCreateDialog
        open={appMode === "ide" && Boolean(worktreeCreateTarget)}
        pending={
          createWorktreeMutation.isPending || bindWorktreeMutation.isPending
        }
        projectId={worktreeCreateTarget?.projectId ?? null}
        sourceWorktreeId={
          worktrees.data?.find(({ isPrimary }) => isPrimary)?.id ?? null
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
          onAction={executeAppAction}
          onCreatedProject={openCreatedProject}
          onOpenChange={setCommandBarOpen}
          onOpenFolder={() => {
            setFolderProjectDialogMode("existing");
            setFolderProjectDialogOpen(true);
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
    </WorkspaceDndProvider>
  );
}
