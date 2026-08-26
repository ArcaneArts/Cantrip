import { DEFAULT_ELITE_REVEAL_CONFIG } from "@cantrip/protocol";
import type {
  ArchivedStandaloneChatSummary,
  BrowserSummary,
  BrowserFleetService,
  ChatSummary,
  CodeAppearance,
  CodeTabSummary,
  ExecutionTarget,
  ExplorerEntry,
  ExplorerSummary,
  ProjectFolderSetupJobSummary,
  ProjectReplicaJobSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorkspaceSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  ProjectViewKind,
  ProjectViewSummary,
  RemoteDesktopTarget,
  ScriptCommand,
  StandaloneChatSummary,
  TaskDetail,
  TerminalSummary,
} from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { EliteGlobalEffects } from "@/components/elite/elite-global-effects";
import { RunConfigurationControl } from "@/components/run/run-configuration-control";
import { AppCommandBar } from "@/components/app/app-command-bar";
import {
  codeAppearanceFor,
  projectOverviewSectionLabel,
  SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS,
  type SidebarFilePinHandoffState,
  type WorktreeBindingTarget,
} from "@/components/app/application-shell-model";
import {
  BrowserView,
  PersistentCodeViews,
  PersistentExplorerViews,
  RemoteDesktopView,
  RunTerminalView,
  TerminalView,
} from "@/components/app/application-shell-surfaces";
import { StatusDot } from "@/components/app/status-dot";
import { useShellEnvironment } from "@/components/app/shell-environment";
import {
  createShellNavigationCommands,
  createShellProjectNavigationCommands,
  useAppDestinationPersistence,
  useProjectSelectionReconciliation,
  useShellClientControlNavigation,
  useShellNavigationState,
  useShellStartupNavigation,
  type PendingSurfaceSelection,
} from "@/components/app/shell-navigation";
import { ArchivedStandaloneChatsPage } from "@/components/chat/archived-standalone-chats-page";
import { updateAgentInspectOpenChats } from "@/components/chat/agent-inspect-panel";
import { randomAgentChatTitle } from "@/components/chat/agent-chat-name";
import { projectFilePath } from "@/components/chat/markdown-file-link";
import { CustomizationPanel } from "@/components/chat/customization-panel";
import { updateChatConsoleOpenChats } from "@/components/chat/chat-console-state";
import {
  activeChatRelocationJob,
  ChatRelocationDialog,
  isChatRelocationActive,
  latestChatRelocationJob,
} from "@/components/chat/chat-relocation-dialog";
import type { CodeHeaderState } from "@/components/code/code-view";
import { runCodeWorktreeChange } from "@/components/code/code-worktree-change";
import {
  GitHistoryView,
  type GitHistoryHeaderState,
  type GitViewSection,
} from "@/components/git/git-history";
import { ExplorerFilePopout } from "@/components/explorer/explorer-file-popout";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import {
  explorerGraphRootForEntry,
  explorerRepositoryGraphAvailable,
} from "@/components/explorer/explorer-graph-routing";
import type {
  ExplorerGraphRequest,
  ExplorerHeaderState,
  ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";
import {
  confirmExplorerDiscard,
  deleteExplorerAfterPreparation,
  prepareExplorerPopout as prepareExplorerPopoutLifecycle,
  prepareExplorerRebind as prepareExplorerRebindLifecycle,
} from "@/components/explorer/explorer-lifecycle";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { StandaloneChatSidebar } from "@/components/sidebar/standalone-chat-sidebar";
import type { ExplorerFileMutationAuthorization } from "@/components/sidebar/project-sidebar-file-tree";
import { ProjectTabBar } from "@/components/workspace/project-tab-bar";
import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
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
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";
import { hasScrolledContent } from "@/lib/scroll-divider";
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
import {
  assignMobileBottomTab,
  initialMobileBottomTabs,
  mobileBottomTabConfiguration,
  mobileBottomTabsFromConfiguration,
  PRIMARY_MOBILE_BOTTOM_TAB_ID,
  reconcileMobileBottomTabs,
  removeMobileBottomTab,
} from "@/lib/mobile-navigation";
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
import {
  createBrowser,
  createCodeTab,
  acknowledgeChatCompletion,
  createChat,
  createStandaloneChat,
  createTask,
  createChatConsole,
  createExplorer,
  pinExplorer,
  createProjectWorktree,
  createProjectView,
  createRemoteDesktop,
  createTerminal,
  cleanupArchivedChats,
  deleteChat,
  deleteBrowser,
  deleteCodeTab,
  deleteExplorer,
  deleteExplorerEntry,
  deleteProjectView,
  deleteTerminal,
  forkChat,
  getArchivedStandaloneChats,
  getChats,
  getStandaloneChats,
  getChatRelocations,
  getBrowsers,
  getCodeTabs,
  getExplorers,
  getProjectReplicaJobs,
  getProjectFolderSetupJob,
  getProjectTabLayout,
  getProjectWorktrees,
  getProjectWorktreeStatus,
  getProjectViews,
  getProjectRepositoryStats,
  getProjectTokenUsage,
  getRemoteDesktop,
  getServerBootstrap,
  getSettings,
  getTerminals,
  getWorkers,
  renameChat,
  renameExplorer,
  renameExplorerEntry,
  renameProjectView,
  renameTerminal,
  resolveStandaloneChatFilePath,
  removeProject,
  retryProjectReplicaJob,
  retryProjectFolderSetup,
  permanentlyDeleteArchivedChat,
  restoreArchivedChat,
  moveProjectTabGroupMember,
  reorderProjectTabGroupMembers,
  reorderProjectTabGroups,
  reorderProjects,
  updateChatWorktree,
  updateBrowser,
  updateCodeTab,
  updateCodeTabWorktree,
  updateExplorerViewState,
  updateExplorerWorktree,
  updateProjectViewWorktree,
  updateProjectTabGroup,
  updateSettings,
  updateTerminalWorktree,
} from "@/lib/api";
import {
  listRunConfigurationRuntimes,
  listRunConfigurations,
  operateRunConfigurationRuntime,
} from "@/lib/run-configuration-api";
import { runConfigurationTargetControlForIdentity } from "@/lib/run-configuration-control-model";
import { installRunConfigurationFocusRecovery } from "@/lib/run-configuration-focus-recovery";
import {
  createProjectWorkspace,
  getProjectWorkspaces,
} from "@/lib/workspace-encryption";
import { getProjects } from "@/lib/project-encryption";
import {
  closeCurrentDesktopWindow,
  desktopPopoutTitlebarLeftInset,
  desktopWindowThemeOverride,
  focusDesktopPopoutGroup,
  isMacosDesktopRuntime,
  openDesktopExplorerFile,
  openDesktopPopoutGroup,
  openDesktopProjectOverviewPopout,
  updateDesktopWindowTheme,
  updateMacosProMode,
  updateDesktopWindowTitle,
  watchDesktopPopoutGroup,
} from "@/lib/desktop-popout";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import { scopedClientStorageKey } from "@/lib/client-session";
import { useDesktopDirectTransportTelemetry } from "@/lib/direct-transport-telemetry";
import { useAppActions } from "@/lib/use-app-actions";
import {
  buildProjectSurfaceIndex,
  type ProjectSurface,
  projectSurfaceTabId,
  projectSurfaceTabKey,
} from "@/lib/project-surface";
import {
  decorateRunConfigurationTerminals,
  runtimeForRunTerminal,
  runTerminalTargetLabel,
} from "@/lib/run-terminal-model";
import {
  dedicatedSidebarExplorer,
  pinnedExplorerForPath,
  preferredSidebarExplorer,
  primaryWorktreeId,
  moveSidebarPath,
  sidebarFileName,
  sidebarFilePreviewIsVisible,
  sidebarFileTargetGroupId,
  sidebarPathAtOrBelow,
  surfaceWorktreeId,
  tabbedExplorerIds,
  type SidebarFilePreviewState,
} from "@/lib/sidebar-file-tabs";
import { projectScriptCommandDestination } from "@/lib/project-script-command";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarWidthFromKey,
  sidebarWidthFromPointer,
} from "@/lib/sidebar-resize";
import {
  readStartupHighContrast,
  readStartupThemePreference,
  rememberStartupHighContrast,
  rememberStartupThemePreference,
  startupThemeIsDark,
} from "@/lib/startup-theme";
import { cn } from "@/lib/utils";
import {
  applyOptimisticTabLayoutToCache,
  restoreOptimisticTabLayoutCache,
} from "@/lib/project-tab-layout-optimistic";
import {
  projectsInWorkspace,
  resolveProjectWorkspace,
} from "@/lib/project-workspaces";
import {
  isWindowsLongPathSetupFailure,
  latestProjectProvisionJob,
  projectListRefreshInterval,
  projectOwningWorkerId,
  projectSetupFailureKey,
  projectSetupJobRefreshInterval,
  projectSetupPercent,
} from "@/lib/project-setup-progress";
import {
  projectFolderSetupErrorMessage,
  projectReplicaProgressMessage,
  projectSetupErrorMessage,
} from "@/lib/job-status-message";
import type {
  TabLayoutCommand,
  WorkspaceDropOperation,
} from "@/lib/workspace-dnd-model";
import {
  emptyWorkspaceSelection,
  reconcileWorkspaceSelection,
  selectedWorkspaceTabKey,
  selectWorkspaceGroup,
  selectWorkspaceOverview,
  selectWorkspaceTab,
} from "@/lib/workspace-selection";
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
  const [workspaceSelection, setWorkspaceSelection] = useState(() =>
    emptyWorkspaceSelection(popoutProjectId),
  );
  const [pendingSurfaceSelection, setPendingSurfaceSelection] =
    useState<PendingSurfaceSelection | null>(
      popoutTarget
        ? {
            groupId: popoutTarget.groupId,
            projectId: popoutTarget.projectId,
            tabKey: popoutTarget.activeTabKey,
          }
        : null,
    );
  const [sidebarFilePreview, setSidebarFilePreview] =
    useState<SidebarFilePreviewState | null>(null);
  const [sidebarFilePinHandoff, setSidebarFilePinHandoff] =
    useState<SidebarFilePinHandoffState | null>(null);
  const sidebarFilePinHandoffRef = useRef(sidebarFilePinHandoff);
  sidebarFilePinHandoffRef.current = sidebarFilePinHandoff;
  const [explorerGraphRequest, setExplorerGraphRequest] =
    useState<ExplorerGraphRequest | null>(null);
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
  const selectedTabKey = selectedWorkspaceTabKey(workspaceSelection);
  const selectedChatId = projectSurfaceTabId(selectedTabKey, "chat");
  const selectedTerminalId = projectSurfaceTabId(selectedTabKey, "terminal");
  const selectedExplorerId = projectSurfaceTabId(selectedTabKey, "explorer");
  const selectedBrowserId = projectSurfaceTabId(selectedTabKey, "browser");
  const selectedCodeTabId = projectSurfaceTabId(selectedTabKey, "code");
  const selectedProjectViewId = projectSurfaceTabId(selectedTabKey, "view");
  useAppLiveScope(
    selectedProjectId
      ? { kind: "project", projectId: selectedProjectId }
      : null,
  );
  useAppLiveScope(
    selectedChatId ? { kind: "chat", chatId: selectedChatId } : null,
  );
  useAppLiveScope(
    appMode === "chat" && selectedStandaloneChatId
      ? { kind: "chat", chatId: selectedStandaloneChatId }
      : null,
  );
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
  const [mobileTabGridOpen, setMobileTabGridOpen] = useState(false);
  const [mobileBottomTabs, setMobileBottomTabs] = useState(
    initialMobileBottomTabs,
  );
  const [mobileBottomTabsProjectId, setMobileBottomTabsProjectId] = useState<
    string | null
  >(null);
  const [activeMobileBottomTabId, setActiveMobileBottomTabId] = useState(
    PRIMARY_MOBILE_BOTTOM_TAB_ID,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [desktopSidebarDrawerOpen, setDesktopSidebarDrawerOpen] =
    useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [contentScrolled, setContentScrolled] = useState(false);
  const [gitHistoryHeader, setGitHistoryHeader] =
    useState<GitHistoryHeaderState | null>(null);
  const [explorerHeader, setExplorerHeader] =
    useState<ExplorerHeaderState | null>(null);
  const [sidebarFilePreviewHeader, setSidebarFilePreviewHeader] =
    useState<ExplorerHeaderState | null>(null);
  const [codeHeader, setCodeHeader] = useState<CodeHeaderState | null>(null);
  const [popoutPending, setPopoutPending] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);
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
  const [detachedGroupId, setDetachedGroupId] = useState<string | null>(null);
  const detachedExplorerIdRef = useRef<string | null>(null);
  const explorerLifecycleRef = useRef(
    new Map<string, ExplorerLifecycleActions>(),
  );
  const sidebarFilePreviewLifecycleRef =
    useRef<ExplorerLifecycleActions | null>(null);
  const sidebarExplorerCreationKeyRef = useRef<string | null>(null);
  const archiveCleanupRequestedRef = useRef(false);
  const appResourcesLoggedRef = useRef(false);
  const projectResourcesLoggedRef = useRef<string | null>(null);
  const [worktreeCreateTarget, setWorktreeCreateTarget] =
    useState<WorktreeBindingTarget | null>(null);
  const [worktreeActionError, setWorktreeActionError] = useState<string | null>(
    null,
  );
  const [codeAppearance, setCodeAppearance] = useState<CodeAppearance>(() =>
    codeAppearanceFor(
      document.documentElement.classList.contains("dark"),
      document.documentElement.classList.contains("high-contrast"),
      false,
    ),
  );
  const [proModeActive, setProModeActive] = useState(false);
  const contentRootRef = useRef<HTMLElement>(null);
  const mobileBottomTabSequenceRef = useRef(0);
  const persistedMobileBottomTabsRef = useRef<{
    projectId: string;
    signature: string;
  } | null>(null);
  const scrolledContentRef = useRef(new Set<EventTarget>());
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizePointerIdRef = useRef<number | null>(null);
  const sidebarResizeLeftRef = useRef(0);
  const sidebarResizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);

  useEffect(() => {
    if (!desktopSidebarDrawer) setDesktopSidebarDrawerOpen(false);
  }, [desktopSidebarDrawer]);

  useEffect(() => {
    if (!desktopSidebarDrawerOpen) return;
    sidebarRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDesktopSidebarDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [desktopSidebarDrawerOpen]);

  const handleExplorerLifecycleChange = useCallback(
    (explorerId: string, actions: ExplorerLifecycleActions | null) => {
      if (actions) explorerLifecycleRef.current.set(explorerId, actions);
      else explorerLifecycleRef.current.delete(explorerId);
    },
    [],
  );

  const handleSidebarFilePreviewLifecycleChange = useCallback(
    (_explorerId: string, actions: ExplorerLifecycleActions | null) => {
      sidebarFilePreviewLifecycleRef.current = actions;
    },
    [],
  );
  const handleExplorerChanged = useCallback(
    (updated: ExplorerSummary) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((explorer) =>
            explorer.id === updated.id ? updated : explorer,
          ),
      );
    },
    [queryClient],
  );

  const openExplorerFileWindow = useCallback(
    async (explorer: ExplorerSummary, entry: ExplorerEntry) => {
      await openDesktopExplorerFile(
        {
          explorerId: explorer.id,
          path: entry.path,
          projectId: explorer.projectId,
        },
        entry.name,
        { appearance: codeAppearance, explorer },
      );
    },
    [codeAppearance],
  );

  const resetMobileBottomTabs = () => {
    setMobileBottomTabs(initialMobileBottomTabs());
    setMobileBottomTabsProjectId(null);
    setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
    setMobileTabGridOpen(false);
    mobileBottomTabSequenceRef.current = 0;
    persistedMobileBottomTabsRef.current = null;
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
  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
  });
  useEffect(() => {
    if (
      isPopout ||
      !bootstrap.isSuccess ||
      archiveCleanupRequestedRef.current
    ) {
      return;
    }
    archiveCleanupRequestedRef.current = true;
    const startedAt = performance.now();
    void cleanupArchivedChats()
      .then(({ deleted }) => {
        clientLogger.info("Archived chat cleanup completed", {
          counts: { deleted },
          durationMs: Math.round(performance.now() - startedAt),
          event: "archive.cleanup.completed",
          operation: "cleanup",
          status: "completed",
          subsystem: "archive",
        });
        if (deleted > 0) {
          void queryClient.invalidateQueries({ queryKey: ["archived-chats"] });
        }
      })
      .catch((error) => {
        clientLogger.warn("Archived chat cleanup failed", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "archive.cleanup.failed",
          operation: "cleanup",
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "archive",
        });
      });
  }, [bootstrap.isSuccess, isPopout, queryClient]);
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const persistAppDestination = useAppDestinationPersistence({
    destinationWriteRef,
    queryClient,
  });
  const saveMobileBottomTabs = useMutation({
    mutationFn: async ({
      groupIds,
      projectId,
    }: {
      groupIds: (string | null)[];
      projectId: string;
    }) =>
      updateSettings({
        mobileProjectTabConfigurations: {
          [projectId]: groupIds,
        },
      }),
    onError: (error) => {
      clientLogger.warn("Mobile project tab state failed to save", {
        ...operationalErrorMetadata(error),
        event: "tabs.mobile.save.failed",
        operation: "save-layout",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "tabs",
      });
    },
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    retry: 2,
    scope: { id: "mobile-project-tab-configurations" },
  });
  const saveSidebarWidth = useMutation({
    mutationFn: (width: number) => updateSettings({ sidebarWidth: width }),
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    onError: (error) => {
      clientLogger.warn("Sidebar width failed to save", {
        ...operationalErrorMetadata(error),
        event: "settings.sidebar-width.save.failed",
        operation: "save-setting",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "settings",
      });
    },
  });
  const projects = useQuery({
    queryFn: getProjects,
    queryKey: ["projects"],
    refetchInterval: (query) =>
      projectListRefreshInterval(projectResourcesLive, query.state.data),
  });
  const standaloneChats = useQuery({
    enabled: !isPopout,
    queryFn: getStandaloneChats,
    queryKey: ["standalone-chats"],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const archivedStandaloneChats = useQuery({
    enabled: !isPopout && appMode === "chat",
    queryFn: getArchivedStandaloneChats,
    queryKey: ["archived-standalone-chats"],
    refetchInterval: projectResourcesLive ? false : 30_000,
  });
  useEffect(() => {
    if (
      appResourcesLoggedRef.current ||
      !bootstrap.isSuccess ||
      !workers.isSuccess ||
      !settings.isSuccess ||
      !projects.isSuccess
    ) {
      return;
    }
    appResourcesLoggedRef.current = true;
    clientLogger.info("Cantrip application resources loaded", {
      counts: {
        projects: projects.data.length,
        workers: workers.data.length,
      },
      event: "client.resources.loaded",
      operation: "load-resources",
      status: "ready",
      subsystem: "bootstrap",
    });
  }, [
    bootstrap.isSuccess,
    projects.data,
    projects.isSuccess,
    settings.isSuccess,
    workers.data,
    workers.isSuccess,
  ]);
  const repositorySetupProjects = (projects.data ?? []).filter(
    (project) =>
      project.originKind === "github" &&
      (project.setupStatus === "cloning" || project.setupStatus === "failed"),
  );
  const projectSetupJobQueries = useQueries({
    queries: repositorySetupProjects.map((project) => ({
      queryFn: () => getProjectReplicaJobs(project.id),
      queryKey: ["project-replica-jobs", project.id],
      refetchInterval: projectSetupJobRefreshInterval(project.setupStatus),
    })),
  });
  const projectSetupJobs = new Map<string, ProjectReplicaJobSummary>();
  repositorySetupProjects.forEach((project, index) => {
    const job = latestProjectProvisionJob(projectSetupJobQueries[index]?.data);
    if (job) projectSetupJobs.set(project.id, job);
  });
  const folderSetupProjects = (projects.data ?? []).filter(
    (project) =>
      project.originKind === "managed-folder" &&
      project.setupStatus !== "ready",
  );
  const folderSetupJobQueries = useQueries({
    queries: folderSetupProjects.map((project) => ({
      queryFn: () => getProjectFolderSetupJob(project.id),
      queryKey: ["project-folder-setup", project.id],
      refetchInterval: projectSetupJobRefreshInterval(project.setupStatus),
      retry: false,
    })),
  });
  const folderSetupJobs = new Map<string, ProjectFolderSetupJobSummary>();
  folderSetupProjects.forEach((project, index) => {
    const job = folderSetupJobQueries[index]?.data;
    if (job) folderSetupJobs.set(project.id, job);
  });
  const projectWorkspaces = useQuery({
    queryFn: getProjectWorkspaces,
    queryKey: ["project-workspaces"],
  });
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
  const selectedStandaloneChat = standaloneChats.data?.find(
    (chat) => chat.id === selectedStandaloneChatId,
  );
  const standaloneChatWorkerAvailable = (workers.data ?? []).some(
    (worker) =>
      worker.online &&
      worker.standaloneChat.scratch.provision &&
      worker.standaloneChat.scratch.resolve &&
      worker.standaloneChat.scratch.remove,
  );
  const standaloneChatCreationUnavailableReason = !bootstrap.isSuccess
    ? "Checking standalone Chat availability…"
    : bootstrap.data.capabilities.standaloneChat.available === false
      ? (bootstrap.data.capabilities.standaloneChat.reason ??
        "Standalone Chat is unavailable on this server.")
      : !standaloneChatWorkerAvailable
        ? "Connect an online worker with standalone Chat scratch support first."
        : null;
  const standaloneChatCreationAvailable =
    standaloneChatCreationUnavailableReason === null;
  const retryLongPathSetupMutation = useMutation({
    mutationFn: (job: ProjectReplicaJobSummary) =>
      retryProjectReplicaJob(job.id, { stateRevision: job.stateRevision }),
    onSuccess: async (_updated, job) => {
      setDismissedLongPathFailure(projectSetupFailureKey(job));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["project-replica-jobs", job.projectId],
        }),
      ]);
    },
  });
  const createWorkspaceMutation = useMutation({
    mutationFn: (name: string) => createProjectWorkspace({ name }),
    onSuccess: (workspace) => {
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current = []) => [...current, workspace],
      );
      setActiveProjectWorkspaceId(workspace.id);
      window.localStorage.setItem(
        activeProjectWorkspaceStorageKey,
        workspace.id,
      );
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      resetMobileBottomTabs();
      setShowImporter(false);
      setShowSettings(false);
      setShowArchivedStandaloneChats(false);
      setShowServerAdmin(false);
      setShowProjectSettings(false);
    },
  });
  const tabLayout = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectTabLayout(selectedProjectId!),
    queryKey: ["project-tab-layout", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const worktrees = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () =>
      getProjectWorktrees(selectedProjectId!, {
        onStatus: (worktreeId, result) => {
          queryClient.setQueryData(
            ["worktree-status", selectedProjectId!, worktreeId],
            result.status,
          );
        },
      }),
    queryKey: ["worktrees", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
  });
  const worktreeStatusQueries = useQueries({
    queries: (worktrees.data ?? []).map((worktree) => ({
      enabled:
        worktree.rootKind === "git-worktree" &&
        worktree.lifecycleState === "ready",
      queryFn: () =>
        getProjectWorktreeStatus(worktree.projectId, worktree.id).then(
          ({ status }) => status,
        ),
      queryKey: ["worktree-status", worktree.projectId, worktree.id],
      refetchInterval:
        projectResourcesLive ||
        !workers.data?.find(({ workerId }) => workerId === worktree.workerId)
          ?.online
          ? false
          : 15_000,
      retry: false,
      staleTime: 15_000,
    })),
  });
  const worktreeStatuses = useMemo<WorktreeStatusMap>(
    () =>
      Object.fromEntries(
        (worktrees.data ?? []).map((worktree, index) => [
          worktree.id,
          worktreeStatusQueries[index]?.data,
        ]),
      ),
    [worktreeStatusQueries, worktrees.data],
  );
  const chats = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getChats(selectedProjectId!),
    queryKey: ["chats", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const terminals = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getTerminals(selectedProjectId!),
    queryKey: ["terminals", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const runConfigurations = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => listRunConfigurations(selectedProjectId!),
    queryKey: ["run-configurations", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
    retry: false,
  });
  const runConfigurationRuntimes = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => listRunConfigurationRuntimes(selectedProjectId!),
    queryKey: ["run-configuration-runtimes", selectedProjectId],
    refetchInterval: (query) =>
      projectResourcesLive
        ? false
        : query.state.data?.some((runtime) =>
              ["starting", "running", "restarting", "stopping"].includes(
                runtime.state,
              ),
            )
          ? 1_000
          : 10_000,
    retry: false,
  });
  useEffect(() => {
    if (!selectedProjectId) return;
    return installRunConfigurationFocusRecovery(
      queryClient,
      selectedProjectId,
      { document, window },
    );
  }, [queryClient, selectedProjectId]);
  const explorers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getExplorers(selectedProjectId!),
    queryKey: ["explorers", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const browsers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getBrowsers(selectedProjectId!),
    queryKey: ["browsers", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const codeTabs = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getCodeTabs(selectedProjectId!),
    queryKey: ["code-tabs", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const projectViews = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectViews(selectedProjectId!),
    queryKey: ["project-views", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  useEffect(() => {
    if (!selectedProjectId) {
      projectResourcesLoggedRef.current = null;
      return;
    }
    if (
      projectResourcesLoggedRef.current === selectedProjectId ||
      !tabLayout.isSuccess ||
      (selectedProject?.capabilities.worktrees && !worktrees.isSuccess) ||
      !chats.isSuccess ||
      !terminals.isSuccess ||
      !explorers.isSuccess ||
      !browsers.isSuccess ||
      !codeTabs.isSuccess ||
      !projectViews.isSuccess
    ) {
      return;
    }
    projectResourcesLoggedRef.current = selectedProjectId;
    clientLogger.info("Project surfaces loaded", {
      counts: {
        browsers: browsers.data.length,
        chats: chats.data.length,
        codeTabs: codeTabs.data.length,
        explorers: explorers.data.length,
        tabGroups: tabLayout.data.groups.length,
        terminals: terminals.data.length,
        views: projectViews.data.length,
        worktrees: (worktrees.data ?? []).length,
      },
      event: "project.resources.loaded",
      operation: "load-project",
      projectId: selectedProjectId,
      status: "ready",
      subsystem: "projects",
    });
  }, [
    browsers.data,
    browsers.isSuccess,
    chats.data,
    chats.isSuccess,
    codeTabs.data,
    codeTabs.isSuccess,
    explorers.data,
    explorers.isSuccess,
    projectViews.data,
    projectViews.isSuccess,
    selectedProjectId,
    selectedProject?.capabilities.worktrees,
    tabLayout.data,
    tabLayout.isSuccess,
    terminals.data,
    terminals.isSuccess,
    worktrees.data,
    worktrees.isSuccess,
  ]);
  const repositoryStats = useQuery({
    enabled:
      Boolean(selectedProjectId) &&
      projectOverviewSelected &&
      activeProjectOverviewSection === "overview" &&
      Boolean(
        projects.data?.some(
          (project) =>
            project.id === selectedProjectId &&
            project.setupStatus === "ready" &&
            project.source,
        ),
      ),
    queryFn: () => getProjectRepositoryStats(selectedProjectId!),
    queryKey: ["project-repository-stats", selectedProjectId],
    retry: false,
    staleTime: 30_000,
  });
  const projectTokenUsage = useQuery({
    enabled:
      Boolean(selectedProjectId) &&
      projectOverviewSelected &&
      activeProjectOverviewSection === "overview",
    queryFn: () => getProjectTokenUsage(selectedProjectId!),
    queryKey: ["project-token-usage", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
    staleTime: 10_000,
  });
  const selectedProjectViewForQuery = projectViews.data?.find(
    (view) => view.id === selectedProjectViewId,
  );
  const remoteDesktop = useQuery({
    enabled: selectedProjectViewForQuery?.kind === "remote-desktop",
    queryFn: () => getRemoteDesktop(selectedProjectViewId!),
    queryKey: ["remote-desktop", selectedProjectViewId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const newChat = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      worktreeMode,
      target,
    }: {
      open?: boolean;
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) => {
      const existingTitles = [
        ...(chats.data ?? []),
        ...(terminals.data ?? []),
        ...(explorers.data ?? []),
        ...(browsers.data ?? []),
        ...(codeTabs.data ?? []),
        ...(projectViews.data ?? []),
      ]
        .filter((surface) => surface.projectId === projectId)
        .map((surface) => surface.title);
      return createChat(
        projectId,
        randomAgentChatTitle(existingTitles),
        worktreeId,
        worktreeMode,
        tabGroupId,
        target,
      );
    },
    onSuccess: (chat, { open }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      if (open !== false) {
        openCreatedTab(chat.projectId, "chat", chat.id);
      } else {
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", chat.projectId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
  });
  const newStandaloneChat = useMutation({
    mutationFn: () => {
      if (bootstrap.data?.capabilities.standaloneChat.available === false) {
        throw new Error(
          bootstrap.data.capabilities.standaloneChat.reason ??
            "Standalone Chat is unavailable on this server.",
        );
      }
      if (!standaloneChatWorkerAvailable) {
        throw new Error(
          "Connect an online worker with standalone Chat scratch support first.",
        );
      }
      return createStandaloneChat(
        randomAgentChatTitle(
          (standaloneChats.data ?? []).map(({ title }) => title),
        ),
      );
    },
    onSuccess: (chat) => {
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          [...current.filter(({ id }) => id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      setSelectedStandaloneChatId(chat.id);
      setShowArchivedStandaloneChats(false);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: chat.id,
      });
    },
  });
  const renameStandaloneChat = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      renameChat(chatId, title),
    onSuccess: (renamed) => {
      if (renamed.contextKind !== "standalone") return;
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          current.map((chat) => (chat.id === renamed.id ? renamed : chat)),
      );
    },
  });
  const forkStandaloneChat = useMutation({
    mutationFn: (chat: StandaloneChatSummary) => forkChat(chat.id, chat.title),
    onSuccess: (forked) => {
      if (forked.contextKind !== "standalone") return;
      void queryClient.invalidateQueries({ queryKey: ["standalone-chats"] });
      setSelectedStandaloneChatId(forked.id);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: forked.id,
      });
    },
  });
  const archiveStandaloneChat = useMutation({
    mutationFn: (chat: StandaloneChatSummary) => deleteChat(chat.id),
    onSuccess: async (_result, chat) => {
      if (selectedStandaloneChatId === chat.id) {
        setSelectedStandaloneChatId(null);
        void persistAppDestination({ lastStandaloneChatId: null });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["standalone-chats"] }),
        queryClient.invalidateQueries({
          queryKey: ["archived-standalone-chats"],
        }),
      ]);
    },
  });
  const restoreStandaloneChat = useMutation({
    mutationFn: (chat: ArchivedStandaloneChatSummary) =>
      restoreArchivedChat(chat.id),
    onSuccess: (restored) => {
      if (restored.contextKind !== "standalone") return;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["standalone-chats"] }),
        queryClient.invalidateQueries({
          queryKey: ["archived-standalone-chats"],
        }),
      ]);
      setSelectedStandaloneChatId(restored.id);
      setShowArchivedStandaloneChats(false);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: restored.id,
      });
    },
  });
  const permanentlyDeleteStandaloneChat = useMutation({
    mutationFn: (chat: ArchivedStandaloneChatSummary) =>
      permanentlyDeleteArchivedChat(chat.id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["archived-standalone-chats"],
      }),
  });
  const newTask = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      worktreeMode,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) =>
      createTask(
        projectId,
        "New task",
        worktreeId,
        worktreeMode,
        tabGroupId,
        target,
      ),
    onSuccess: ({ chat, task }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      queryClient.setQueryData(["task", chat.id], task);
      openProjectTask(chat.projectId, chat.id);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["project-task-workload", chat.projectId],
        }),
      ]);
    },
  });
  const newTerminal = useMutation({
    mutationFn: ({
      projectId,
      directoryPath,
      tabGroupId,
      title,
      worktreeId,
      target,
      initialInput: _initialInput,
    }: {
      initialInput?: string;
      projectId: string;
      directoryPath?: string;
      tabGroupId?: string;
      title?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) =>
      createTerminal(
        projectId,
        title ?? "Terminal",
        worktreeId,
        tabGroupId,
        target,
        directoryPath,
      ),
    onSuccess: (terminal, { initialInput }) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== terminal.id), terminal].sort(
            (left, right) => left.position - right.position,
          ),
      );
      if (initialInput) {
        setPendingTerminalInputs((current) => [
          ...current,
          {
            data: initialInput,
            id: crypto.randomUUID(),
            terminalId: terminal.id,
          },
        ]);
      }
      openCreatedTab(terminal.projectId, "terminal", terminal.id);
      void queryClient.invalidateQueries({
        queryKey: ["terminals", terminal.projectId],
      });
    },
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
  const openChatConsole = useMutation({
    mutationFn: (chatId: string) => createChatConsole(chatId),
    onError: (error, chatId) => {
      clientLogger.error("Codex console failed to open", {
        chatId,
        ...operationalErrorMetadata(error),
        event: "surface.codex-console.open.failed",
        operation: "open-console",
        reasonCode: "request-failed",
        status: "failed",
        subsystem: "codex-console",
      });
    },
    onSuccess: (terminal, chatId) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) => [
          ...current.filter((item) => item.id !== terminal.id),
          terminal,
        ],
      );
      setChatConsoleOpen(chatId, true);
    },
  });
  const newExplorer = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createExplorer(projectId, "Explorer", worktreeId, tabGroupId, target),
    onSuccess: (explorer) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(explorer.projectId, "explorer", explorer.id);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
    },
  });
  const newGraphExplorer = useMutation({
    mutationFn: ({
      explorer,
      entry,
      tabGroupId,
    }: {
      explorer: ExplorerSummary;
      entry: ExplorerEntry;
      tabGroupId?: string;
    }) =>
      createExplorer(
        explorer.projectId,
        `Graph · ${entry.name}`,
        explorer.worktreeId,
        tabGroupId,
        {
          kind: "worktree",
          projectId: explorer.projectId,
          worktreeId: explorer.worktreeId,
        },
      ),
    onError: (error) => setPopoutError(errorText(error)),
    onSuccess: (createdExplorer, { entry }) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", createdExplorer.projectId],
        (current = []) =>
          [
            ...current.filter((item) => item.id !== createdExplorer.id),
            createdExplorer,
          ].sort((left, right) => left.position - right.position),
      );
      setExplorerGraphRequest({
        explorerId: createdExplorer.id,
        requestId: crypto.randomUUID(),
        rootPath: explorerGraphRootForEntry(entry),
      });
      openCreatedTab(createdExplorer.projectId, "explorer", createdExplorer.id);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", createdExplorer.projectId],
      });
    },
  });
  const createSidebarExplorerMutation = useMutation({
    mutationFn: ({
      projectId,
      worktreeId,
    }: {
      projectId: string;
      worktreeId?: string;
    }) =>
      createExplorer(
        projectId,
        "Project files",
        worktreeId,
        undefined,
        undefined,
        { attachToTabLayout: false },
      ),
    onError: (_error, input) => {
      sidebarExplorerCreationKeyRef.current = `${input.projectId}:${input.worktreeId ?? "default"}`;
    },
    onSuccess: (explorer) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
    },
  });
  const pinSidebarFileMutation = useMutation({
    mutationFn: async ({
      destinationExplorerId,
      groupId,
      path,
    }: {
      destinationExplorerId: string;
      groupId: string | null;
      path: string;
      transactionId: string;
    }) => {
      return pinExplorer(
        destinationExplorerId,
        sidebarFileName(path),
        {
          fileMode: defaultExplorerFileMode(path),
          selectedPath: path,
        },
        groupId ?? undefined,
      );
    },
    onSuccess: (explorer, input) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (!handoff || handoff.transactionId !== input.transactionId) {
        void queryClient.invalidateQueries({
          queryKey: ["explorers", explorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", explorer.projectId],
        });
        return;
      }
      const expectedFileMode = defaultExplorerFileMode(input.path);
      if (
        explorer.id !== input.destinationExplorerId ||
        explorer.selectedPath !== input.path ||
        explorer.fileMode !== expectedFileMode
      ) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
        void queryClient.invalidateQueries({
          queryKey: ["explorers", explorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", explorer.projectId],
        });
        setPopoutError(
          "The pinned Explorer did not preserve the requested file state.",
        );
        return;
      }
      const nextHandoff = {
        ...handoff,
        destinationExplorer: explorer,
        ready: true,
      };
      // This Explorer is now a tab. Permit the creation effect to provision
      // and prewarm the next dedicated sidebar Explorer for this worktree.
      sidebarExplorerCreationKeyRef.current = null;
      sidebarFilePinHandoffRef.current = nextHandoff;
      setSidebarFilePinHandoff(nextHandoff);
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", explorer.projectId],
      });
    },
    onError: (error, input) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (handoff?.transactionId === input.transactionId) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
        void queryClient.invalidateQueries({
          queryKey: ["explorers", handoff.sourceExplorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", handoff.sourceExplorer.projectId],
        });
      }
      setPopoutError(errorText(error));
    },
  });
  const openProjectExplorerFile = (
    projectId: string,
    worktreeId: string,
    path: string,
  ) => {
    void (async () => {
      let explorer = (explorers.data ?? []).find(
        (candidate) =>
          candidate.worktreeId === worktreeId &&
          (desktopRuntime ||
            !explorerLifecycleRef.current.get(candidate.id)?.dirty),
      );
      if (!explorer) {
        const created = await createExplorer(projectId, "Explorer", worktreeId);
        explorer = created;
        queryClient.setQueryData<ExplorerSummary[]>(
          ["explorers", created.projectId],
          (current = []) =>
            [
              ...current.filter((candidate) => candidate.id !== created.id),
              created,
            ].sort((left, right) => left.position - right.position),
        );
        void queryClient.invalidateQueries({
          queryKey: ["explorers", created.projectId],
        });
      }
      if (desktopRuntime) {
        await openDesktopExplorerFile(
          {
            explorerId: explorer.id,
            path,
            projectId: explorer.projectId,
          },
          path.split("/").at(-1) ?? path,
          { appearance: codeAppearance, explorer },
        );
        return;
      }
      const updated = await updateExplorerViewState(explorer.id, {
        fileMode: defaultExplorerFileMode(path),
        selectedPath: path,
      });
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
      );
      openCreatedTab(updated.projectId, "explorer", updated.id);
    })().catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openChatFileLink = (chat: ChatSummary, reference: string) => {
    const worktree = (worktrees.data ?? []).find(
      (candidate) => candidate.id === chat.activeWorktreeId,
    );
    const projectRoot =
      worktree?.path ??
      (selectedProject?.id === chat.projectId
        ? selectedProject.source?.path
        : null);
    const path = projectRoot ? projectFilePath(reference, projectRoot) : null;
    if (!projectRoot || !path) {
      showAppToast({
        message: projectRoot
          ? "The link points outside the active project folder."
          : "The active worktree is not available.",
        title: "Could not open file link",
        tone: "error",
      });
      return;
    }
    openProjectExplorerFile(chat.projectId, chat.activeWorktreeId, path);
  };
  const newBrowser = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      target,
      title,
      url,
    }: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
      title?: string;
      url?: string;
    }) => createBrowser(projectId, title ?? "Browser", tabGroupId, target, url),
    onSuccess: (browser) => {
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", browser.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== browser.id), browser].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(browser.projectId, "browser", browser.id);
      void queryClient.invalidateQueries({
        queryKey: ["browsers", browser.projectId],
      });
    },
  });
  const newCodeTab = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createCodeTab(projectId, "Code", worktreeId, tabGroupId, target),
    onSuccess: (codeTab) => {
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", codeTab.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== codeTab.id), codeTab].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(codeTab.projectId, "code", codeTab.id);
      void queryClient.invalidateQueries({
        queryKey: ["code-tabs", codeTab.projectId],
      });
    },
  });
  const newProjectView = useMutation({
    mutationFn: ({
      projectId,
      kind,
      tabGroupId,
      worktreeId,
    }: {
      projectId: string;
      kind: ProjectViewKind;
      tabGroupId?: string;
      worktreeId?: string;
    }) =>
      createProjectView(
        projectId,
        kind,
        kind === "history"
          ? "Git"
          : kind === "issues"
            ? "Issues"
            : "Remote Desktop",
        worktreeId,
        tabGroupId,
      ),
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", view.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== view.id), view].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(view.projectId, "view", view.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", view.projectId],
      });
    },
  });
  const bindWorktreeMutation = useMutation({
    mutationFn: async ({
      target,
      worktreeId,
      mode,
    }: {
      target: WorktreeBindingTarget;
      worktreeId: string;
      mode?: "agent-managed" | "pinned";
    }) => {
      if (target.kind === "chat") {
        return {
          kind: "chat" as const,
          value: await updateChatWorktree(target.tabId, {
            worktreeId,
            mode: mode ?? target.mode,
          }),
        };
      }
      if (target.kind === "terminal") {
        return {
          kind: "terminal" as const,
          value: await updateTerminalWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "explorer") {
        return {
          kind: "explorer" as const,
          value: await updateExplorerWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "code") {
        return {
          kind: "code" as const,
          value: await updateCodeTabWorktree(target.tabId, worktreeId),
        };
      }
      return {
        kind: "history" as const,
        value: await updateProjectViewWorktree(target.tabId, worktreeId),
      };
    },
    onMutate: async ({ target, worktreeId, mode }) => {
      setWorktreeActionError(null);
      if (target.kind !== "chat") return {};
      const queryKey = ["chats", target.projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ChatSummary[]>(queryKey);
      queryClient.setQueryData<ChatSummary[]>(queryKey, (current = []) =>
        current.map((chat) =>
          chat.id === target.tabId
            ? {
                ...chat,
                activeWorktreeId: worktreeId,
                worktreeMode: mode ?? target.mode,
              }
            : chat,
        ),
      );
      return { previous, queryKey };
    },
    onSuccess: ({ kind, value }) => {
      if (kind === "chat") {
        queryClient.setQueryData<ChatSummary[]>(
          ["chats", value.projectId],
          (current = []) =>
            current.map((chat) => (chat.id === value.id ? value : chat)),
        );
        void queryClient.invalidateQueries({
          queryKey: ["terminals", value.projectId],
        });
      } else if (kind === "terminal") {
        queryClient.setQueryData<TerminalSummary[]>(
          ["terminals", value.projectId],
          (current = []) =>
            current.map((terminal) =>
              terminal.id === value.id ? value : terminal,
            ),
        );
      } else if (kind === "explorer") {
        queryClient.setQueryData<ExplorerSummary[]>(
          ["explorers", value.projectId],
          (current = []) =>
            current.map((explorer) =>
              explorer.id === value.id ? value : explorer,
            ),
        );
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: [
              "explorer-directory",
              value.projectId,
              value.worktreeId,
              value.id,
            ],
          }),
          queryClient.invalidateQueries({
            queryKey: ["explorer-file", value.id],
          }),
        ]);
      } else if (kind === "code") {
        queryClient.setQueryData<CodeTabSummary[]>(
          ["code-tabs", value.projectId],
          (current = []) =>
            current.map((codeTab) =>
              codeTab.id === value.id ? value : codeTab,
            ),
        );
      } else {
        queryClient.setQueryData<ProjectViewSummary[]>(
          ["project-views", value.projectId],
          (current = []) =>
            current.map((view) => (view.id === value.id ? value : view)),
        );
      }
    },
    onError: (error, input, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      if (input.target.kind === "history") {
        void queryClient.invalidateQueries({
          queryKey: ["project-views", input.target.projectId],
        });
      }
      if (input.target.kind === "code") {
        void queryClient.invalidateQueries({
          queryKey: ["code-tabs", input.target.projectId],
        });
      }
      setWorktreeActionError(errorText(error));
    },
  });
  const prepareExplorerRebind = async (target: WorktreeBindingTarget) => {
    if (target.kind !== "explorer") return true;
    const lifecycle = explorerLifecycleRef.current.get(target.tabId);
    const result = await prepareExplorerRebindLifecycle(lifecycle, () =>
      window.confirm(
        "Switch this Explorer to another worktree and discard its unsaved changes?",
      ),
    );
    if (result === "state-failed") {
      setWorktreeActionError(
        "Explorer view state could not be saved before switching worktrees.",
      );
    }
    return result === "ready";
  };
  const requestBindWorktree = async (input: {
    target: WorktreeBindingTarget;
    worktreeId: string;
    mode?: "agent-managed" | "pinned";
  }) => {
    if (!(await prepareExplorerRebind(input.target))) return false;
    const codeNeedsPause =
      input.target.kind === "code" &&
      Boolean(
        codeHeader?.runtime ||
        codeHeader?.status === "starting" ||
        codeHeader?.status === "running",
      );
    return runCodeWorktreeChange({
      active: codeNeedsPause,
      header: codeHeader,
      rebind: async () => {
        try {
          await bindWorktreeMutation.mutateAsync(input);
          return true;
        } catch {
          return false;
        }
      },
    });
  };
  const createWorktreeMutation = useMutation({
    mutationFn: ({
      projectId,
      input,
    }: {
      projectId: string;
      input: ProjectWorktreeCreate;
    }) => createProjectWorktree(projectId, input),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", created.projectId],
        (current = []) => [
          ...current.filter((worktree) => worktree.id !== created.id),
          created,
        ],
      );
    },
  });
  const newRemoteDesktop = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      target,
      desktopTarget,
    }: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
      desktopTarget?: RemoteDesktopTarget;
    }) => createRemoteDesktop(projectId, tabGroupId, target, desktopTarget),
    onSuccess: (desktop) => {
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", desktop.projectId],
        (current = []) =>
          [
            ...current.filter((item) => item.id !== desktop.id),
            {
              id: desktop.id,
              projectId: desktop.projectId,
              title: desktop.title,
              kind: "remote-desktop" as const,
              worktreeId: null,
              position: desktop.position,
              createdAt: desktop.createdAt,
              updatedAt: desktop.updatedAt,
            },
          ].sort((left, right) => left.position - right.position),
      );
      queryClient.setQueryData(["remote-desktop", desktop.id], desktop);
      void queryClient.invalidateQueries({
        queryKey: ["remote-desktop-fleet", desktop.projectId],
      });
      openCreatedTab(desktop.projectId, "view", desktop.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", desktop.projectId],
      });
    },
  });
  const renameChatMutation = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      renameChat(chatId, title),
    onSuccess: (renamed) => {
      if (renamed.contextKind === "standalone") return;
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", renamed.projectId],
        (current = []) =>
          current.map((chat) => (chat.id === renamed.id ? renamed : chat)),
      );
    },
  });
  const { mutate: acknowledgeSelectedChatCompletion } = useMutation({
    mutationFn: ({ chatId }: { chatId: string; projectId: string }) =>
      acknowledgeChatCompletion(chatId),
    onSuccess: (acknowledged) => {
      if (acknowledged.contextKind === "standalone") return;
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", acknowledged.projectId],
        (current = []) =>
          current.map((chat) =>
            chat.id === acknowledged.id ? acknowledged : chat,
          ),
      );
    },
    retry: 2,
  });
  const forkChatMutation = useMutation({
    mutationFn: (chatId: string) => {
      const source = queryClient
        .getQueryData<ChatSummary[]>(["chats", selectedProjectId])
        ?.find(({ id }) => id === chatId);
      if (!source) throw new Error("The source chat is unavailable.");
      return forkChat(chatId, source.title);
    },
    onSuccess: async (forked) => {
      if (forked.contextKind === "standalone") return;
      await queryClient.invalidateQueries({
        queryKey: ["chats", forked.projectId],
      });
      openCreatedTab(forked.projectId, "chat", forked.id);
    },
  });
  const { mutate: acknowledgeSelectedStandaloneChatCompletion } = useMutation({
    mutationFn: (chatId: string) => acknowledgeChatCompletion(chatId),
    onSuccess: (acknowledged) => {
      if (acknowledged.contextKind !== "standalone") return;
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          current.map((chat) =>
            chat.id === acknowledged.id ? acknowledged : chat,
          ),
      );
    },
    retry: 2,
  });
  const deleteChatMutation = useMutation({
    mutationFn: deleteChat,
    onSuccess: async (_value, deletedId) => {
      setChatConsoleOpen(deletedId, false);
      setTaskChatViewIds((current) => {
        if (!current.has(deletedId)) return current;
        const next = new Set(current);
        next.delete(deletedId);
        return next;
      });
      setProjectTaskChatIds((current) => {
        const next = new Map(
          [...current].filter(([, chatId]) => chatId !== deletedId),
        );
        if (next.size === current.size) return current;
        return next;
      });
      await queryClient.invalidateQueries({
        queryKey: ["chats", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["archived-chats", selectedProjectId],
      });
    },
  });
  const renameTerminalMutation = useMutation({
    mutationFn: ({
      terminalId,
      title,
    }: {
      terminalId: string;
      title: string;
    }) => renameTerminal(terminalId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", renamed.projectId],
        (current = []) =>
          current.map((terminal) =>
            terminal.id === renamed.id ? renamed : terminal,
          ),
      ),
  });
  const deleteTerminalMutation = useMutation({
    mutationFn: deleteTerminal,
    onSuccess: async (_value, deletedId) => {
      if (terminalServiceTerminalId === deletedId) {
        setTerminalServiceTerminalId(null);
      }
      setPendingTerminalInputs((current) =>
        current.filter(({ terminalId }) => terminalId !== deletedId),
      );
      await queryClient.invalidateQueries({
        queryKey: ["terminals", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const stopAndDeleteRunTerminalMutation = useMutation({
    mutationFn: async (terminal: TerminalSummary) => {
      if (
        terminal.kind !== "run-configuration" ||
        !terminal.runConfigurationId
      ) {
        throw new Error("Only a bound Run terminal can be stopped and closed.");
      }
      await operateRunConfigurationRuntime({
        operation: "stop",
        projectId: terminal.projectId,
        configurationId: terminal.runConfigurationId,
        targetWorktreeId: terminal.worktreeId,
      });
      await deleteTerminal(terminal.id);
    },
    onSuccess: async (_value, terminal) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["terminals", terminal.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", terminal.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["run-configuration-runtimes", terminal.projectId],
        }),
      ]);
    },
  });
  const renameExplorerMutation = useMutation({
    mutationFn: ({
      explorerId,
      title,
    }: {
      explorerId: string;
      title: string;
    }) => renameExplorer(explorerId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", renamed.projectId],
        (current = []) =>
          current.map((explorer) =>
            explorer.id === renamed.id ? renamed : explorer,
          ),
      ),
  });
  const deleteExplorerMutation = useMutation({
    mutationFn: (explorerId: string) =>
      deleteExplorerAfterPreparation(
        explorerLifecycleRef.current.get(explorerId),
        () => deleteExplorer(explorerId),
      ),
    onSuccess: async (_value, deletedId) => {
      explorerLifecycleRef.current.delete(deletedId);
      await queryClient.invalidateQueries({
        queryKey: ["explorers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const requestDeleteExplorer = (explorerId: string) => {
    const lifecycle = explorerLifecycleRef.current.get(explorerId);
    if (
      !confirmExplorerDiscard(lifecycle, () =>
        window.confirm(
          "Delete this Explorer and discard its unsaved file changes?",
        ),
      )
    ) {
      return;
    }
    deleteExplorerMutation.mutate(explorerId);
  };
  const updateBrowserMutation = useMutation({
    mutationFn: ({
      browserId,
      input,
    }: {
      browserId: string;
      input: { title?: string; url?: string; stateRevision?: number };
    }) => updateBrowser(browserId, input),
    onSuccess: (updated) =>
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", updated.projectId],
        (current = []) =>
          current.map((browser) =>
            browser.id === updated.id ? updated : browser,
          ),
      ),
  });
  const deleteBrowserMutation = useMutation({
    mutationFn: deleteBrowser,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["browsers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const updateCodeTabMutation = useMutation({
    mutationFn: ({ codeTabId, title }: { codeTabId: string; title: string }) =>
      updateCodeTab(codeTabId, { title }),
    onSuccess: (updated) =>
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", updated.projectId],
        (current = []) =>
          current.map((codeTab) =>
            codeTab.id === updated.id ? updated : codeTab,
          ),
      ),
  });
  const deleteCodeTabMutation = useMutation({
    mutationFn: deleteCodeTab,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["code-tabs", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const renameProjectViewMutation = useMutation({
    mutationFn: ({ viewId, title }: { viewId: string; title: string }) =>
      renameProjectView(viewId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", renamed.projectId],
        (current = []) =>
          current.map((view) => (view.id === renamed.id ? renamed : view)),
      ),
  });
  const deleteProjectViewMutation = useMutation({
    mutationFn: deleteProjectView,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["project-views", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const removeProjectMutation = useMutation({
    mutationFn: ({
      projectId,
      deleteLocalFiles,
    }: {
      projectId: string;
      deleteLocalFiles: boolean;
    }) => removeProject(projectId, deleteLocalFiles),
    onMutate: async ({ projectId }) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previousProjects = queryClient.getQueryData<ProjectSummary[]>([
        "projects",
      ]);
      const restoreSelection =
        selectedProjectId === projectId
          ? {
              pendingSurfaceSelection,
              showProjectSettings,
              workspaceSelection,
            }
          : null;
      flushSync(() => {
        queryClient.setQueryData<ProjectSummary[]>(
          ["projects"],
          (current = []) =>
            current.filter((project) => project.id !== projectId),
        );
        if (restoreSelection) {
          setSelectedProjectId(null);
          setWorkspaceSelection(emptyWorkspaceSelection());
          setPendingSurfaceSelection(null);
          setShowProjectSettings(false);
        }
      });
      return { previousProjects, restoreSelection };
    },
    onError: (_error, { projectId }, context) => {
      if (context?.previousProjects) {
        queryClient.setQueryData(["projects"], context.previousProjects);
      }
      if (context?.restoreSelection) {
        setSelectedProjectId(projectId);
        setWorkspaceSelection(context.restoreSelection.workspaceSelection);
        setPendingSurfaceSelection(
          context.restoreSelection.pendingSurfaceSelection,
        );
        setShowProjectSettings(context.restoreSelection.showProjectSettings);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-workspaces"] }),
        queryClient.invalidateQueries({ queryKey: ["github-repositories"] }),
      ]);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
  const retryFolderSetupMutation = useMutation({
    mutationFn: ({
      projectId,
      stateRevision,
    }: {
      projectId: string;
      stateRevision: number;
    }) => retryProjectFolderSetup(projectId, stateRevision),
    onSuccess: (job) => {
      queryClient.setQueryData(["project-folder-setup", job.projectId], job);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const reorderProjectsMutation = useMutation({
    mutationFn: (ids: string[]) => reorderProjects(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previous = queryClient.getQueryData<ProjectSummary[]>(["projects"]);
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        ids.flatMap((id, position) => {
          const project = current.find((item) => item.id === id);
          return project ? [{ ...project, position }] : [];
        }),
      );
      return { previous };
    },
    onError: (_error, _ids, context) =>
      queryClient.setQueryData(["projects"], context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
  const tabLayoutMutation = useMutation({
    mutationFn: ({
      command,
      projectId,
    }: {
      projectId: string;
      command: TabLayoutCommand;
    }) => {
      const current = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        projectId,
      ]);
      if (!current) throw new Error("The project tab layout is not loaded.");
      if (command.type === "reorder-groups") {
        return reorderProjectTabGroups(
          projectId,
          current.revision,
          command.groupIds,
        );
      }
      if (command.type === "reorder-members") {
        return reorderProjectTabGroupMembers(
          projectId,
          command.groupId,
          current.revision,
          command.tabKeys,
        );
      }
      return moveProjectTabGroupMember(projectId, {
        revision: current.revision,
        tabKey: command.tabKey,
        targetGroupId: command.targetGroupId,
        targetMemberPosition: command.targetMemberPosition,
        ...(command.targetGroupPosition === undefined
          ? {}
          : { targetGroupPosition: command.targetGroupPosition }),
      });
    },
    onMutate: async ({ command, projectId }) => {
      setWorkspaceDragError(null);
      const queryKey = ["project-tab-layout", projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      return applyOptimisticTabLayoutToCache(queryClient, projectId, command);
    },
    onError: (error, _input, context) => {
      restoreOptimisticTabLayoutCache(queryClient, context);
      setWorkspaceDragError(errorText(error));
    },
    onSuccess: (layout) =>
      queryClient.setQueryData(
        ["project-tab-layout", layout.projectId],
        layout,
      ),
    onSettled: (_data, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", input.projectId],
      }),
  });
  const renameTabGroupMutation = useMutation({
    mutationFn: ({
      groupId,
      projectId,
      title,
    }: {
      groupId: string;
      projectId: string;
      title: string;
    }) => {
      const current = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        projectId,
      ]);
      if (!current) throw new Error("The project tab layout is not loaded.");
      return updateProjectTabGroup(projectId, groupId, current.revision, title);
    },
    onSuccess: (layout) =>
      queryClient.setQueryData(
        ["project-tab-layout", layout.projectId],
        layout,
      ),
    onSettled: (_data, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", input.projectId],
      }),
  });

  const onlineWorker = workers.data?.find((worker) => worker.online) ?? null;
  const activeProjectWorkspace = resolveProjectWorkspace(
    projectWorkspaces.data ?? [],
    activeProjectWorkspaceId,
  );
  const visibleProjects = useMemo(
    () => projectsInWorkspace(projects.data ?? [], activeProjectWorkspace),
    [activeProjectWorkspace, projects.data],
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
  const mobileProjectSelectorOpen =
    appMode === "ide" &&
    compactShell &&
    selectedProjectId === null &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings;
  const compactManagedHeader =
    appMode === "ide" &&
    compactShell &&
    (mobileProjectSelectorOpen ||
      showImporter ||
      showSettings ||
      showServerAdmin ||
      showProjectSettings ||
      mobileTabGridOpen ||
      (projectOverviewSelected && Boolean(selectedProject)));
  const displayTerminals = useMemo(
    () =>
      decorateRunConfigurationTerminals(
        terminals.data ?? [],
        runConfigurations.data,
        worktrees.data ?? [],
      ),
    [runConfigurations.data, terminals.data, worktrees.data],
  );
  const projectSurfaceIndex = useMemo(
    () =>
      buildProjectSurfaceIndex(tabLayout.data, {
        browsers: browsers.data ?? [],
        chats: chats.data ?? [],
        codeTabs: codeTabs.data ?? [],
        explorers: explorers.data ?? [],
        projectViews: projectViews.data ?? [],
        terminals: displayTerminals,
      }),
    [
      browsers.data,
      chats.data,
      codeTabs.data,
      explorers.data,
      projectViews.data,
      tabLayout.data,
      displayTerminals,
    ],
  );
  const selectedSurface = selectedTabKey
    ? projectSurfaceIndex.byTabKey.get(selectedTabKey)
    : undefined;
  const sidebarDesiredWorktreeId =
    surfaceWorktreeId(selectedSurface) ??
    primaryWorktreeId(worktrees.data ?? []);
  const queriedSidebarPreviewExplorer = sidebarFilePreview
    ? (explorers.data?.find(
        (explorer) => explorer.id === sidebarFilePreview.explorerId,
      ) ?? null)
    : null;
  const sidebarPreviewExplorer =
    queriedSidebarPreviewExplorer ??
    (sidebarFilePreview &&
    sidebarFilePinHandoff?.sourceExplorer.id ===
      sidebarFilePreview.explorerId &&
    sidebarFilePinHandoff.sourcePath === sidebarFilePreview.path
      ? sidebarFilePinHandoff.sourceExplorer
      : null);
  const sidebarExplorer = preferredSidebarExplorer({
    desiredWorktreeId: sidebarDesiredWorktreeId,
    explorers: explorers.data ?? [],
    layout: tabLayout.data,
    previewExplorerId: sidebarFilePreview?.active
      ? sidebarFilePreview.explorerId
      : null,
  });
  const sidebarInlineExplorer = dedicatedSidebarExplorer({
    desiredWorktreeId: sidebarDesiredWorktreeId,
    explorers: explorers.data ?? [],
    layout: tabLayout.data,
  });
  const connectedExplorerGroupIds = useMemo(() => {
    if (projectOverviewPopoutTarget || explorerFileTarget) {
      return new Set<string>();
    }
    if (popoutTarget) return new Set([popoutTarget.groupId]);
    return new Set(
      tabLayout.data?.groups
        .filter(({ id }) => id !== detachedGroupId)
        .map(({ id }) => id) ?? [],
    );
  }, [
    detachedGroupId,
    explorerFileTarget,
    popoutTarget,
    projectOverviewPopoutTarget,
    tabLayout.data,
  ]);
  const openExplorerIds = useMemo(
    () => tabbedExplorerIds(tabLayout.data, connectedExplorerGroupIds),
    [connectedExplorerGroupIds, tabLayout.data],
  );
  const openExplorers = useMemo(
    () =>
      (explorers.data ?? []).filter((explorer) =>
        openExplorerIds.has(explorer.id),
      ),
    [explorers.data, openExplorerIds],
  );
  const sidebarFilePreviewRef = useRef(sidebarFilePreview);
  sidebarFilePreviewRef.current = sidebarFilePreview;
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const openCreatedTabRef = useRef(openCreatedTab);
  openCreatedTabRef.current = openCreatedTab;
  const abandonSidebarFilePinHandoff = useCallback(
    (handoff: SidebarFilePinHandoffState, message?: string) => {
      if (
        sidebarFilePinHandoffRef.current?.transactionId !==
        handoff.transactionId
      ) {
        return;
      }
      sidebarFilePinHandoffRef.current = null;
      setSidebarFilePinHandoff(null);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", handoff.sourceExplorer.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", handoff.sourceExplorer.projectId],
      });
      if (message) setPopoutError(message);
    },
    [queryClient],
  );
  const completeSidebarFilePinHandoff = useCallback(
    (explorerId: string) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (!handoff || handoff.destinationExplorerId !== explorerId) {
        return;
      }
      const readyHandoff = handoff.ready
        ? handoff
        : { ...handoff, ready: true };
      if (!handoff.ready) {
        sidebarFilePinHandoffRef.current = readyHandoff;
        setSidebarFilePinHandoff(readyHandoff);
      }
      const destination = readyHandoff.destinationExplorer;
      if (!destination) return;
      const preview = sidebarFilePreviewRef.current;
      if (
        preview?.active &&
        selectedProjectIdRef.current === destination.projectId &&
        preview.explorerId === readyHandoff.sourceExplorer.id &&
        preview.path === readyHandoff.sourcePath
      ) {
        sidebarFilePreviewLifecycleRef.current = null;
        sidebarFilePreviewRef.current = null;
        setSidebarFilePreview(null);
        openCreatedTabRef.current(
          destination.projectId,
          "explorer",
          destination.id,
        );
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", destination.projectId],
      });
    },
    [queryClient],
  );
  useEffect(() => {
    if (!sidebarFilePinHandoff) return;
    if (sidebarFilePinHandoff.sourceExplorer.projectId === selectedProjectId) {
      return;
    }
    abandonSidebarFilePinHandoff(sidebarFilePinHandoff);
  }, [abandonSidebarFilePinHandoff, selectedProjectId, sidebarFilePinHandoff]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff ||
      (sidebarFilePinHandoff.ready && sidebarFilePinHandoff.destinationExplorer)
    ) {
      return;
    }
    const timeout = setTimeout(() => {
      abandonSidebarFilePinHandoff(
        sidebarFilePinHandoff,
        "The file could not be pinned before the request timed out.",
      );
    }, SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [
    abandonSidebarFilePinHandoff,
    sidebarFilePinHandoff,
    sidebarFilePinHandoff?.destinationExplorerId,
    sidebarFilePinHandoff?.ready,
  ]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff?.ready ||
      !sidebarFilePinHandoff.destinationExplorer
    ) {
      return;
    }
    completeSidebarFilePinHandoff(sidebarFilePinHandoff.destinationExplorerId);
  }, [
    completeSidebarFilePinHandoff,
    sidebarFilePinHandoff?.destinationExplorer,
    sidebarFilePinHandoff?.destinationExplorerId,
    sidebarFilePinHandoff?.ready,
  ]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff?.ready ||
      !sidebarFilePinHandoff.destinationExplorer ||
      !openExplorerIds.has(sidebarFilePinHandoff.destinationExplorerId)
    ) {
      return;
    }
    sidebarFilePinHandoffRef.current = null;
    setSidebarFilePinHandoff(null);
  }, [openExplorerIds, sidebarFilePinHandoff]);
  const sidebarFileWorkerId =
    sidebarExplorer?.activeWorkerId ?? selectedProjectWorkerId;
  const onlineWorkerIds = useMemo(
    () =>
      new Set(
        (workers.data ?? [])
          .filter(({ online }) => online)
          .map(({ workerId }) => workerId),
      ),
    [workers.data],
  );
  const sidebarFileWorkerOnline = Boolean(
    sidebarFileWorkerId && onlineWorkerIds.has(sidebarFileWorkerId),
  );
  const sidebarExplorerCreationInput =
    selectedProject?.setupStatus === "ready" &&
    selectedProject.source &&
    (!selectedProject.capabilities.worktrees || sidebarDesiredWorktreeId)
      ? {
          projectId: selectedProject.id,
          ...(sidebarDesiredWorktreeId
            ? { worktreeId: sidebarDesiredWorktreeId }
            : {}),
        }
      : null;
  const sidebarExplorerCreationKey = sidebarExplorerCreationInput
    ? `${sidebarExplorerCreationInput.projectId}:${sidebarExplorerCreationInput.worktreeId ?? "default"}`
    : null;
  const sidebarHasDesiredExplorer = Boolean(
    sidebarExplorerCreationInput && sidebarInlineExplorer,
  );
  useEffect(() => {
    if (
      isPopout ||
      !explorers.isSuccess ||
      !tabLayout.isSuccess ||
      !sidebarExplorerCreationInput ||
      !sidebarExplorerCreationKey ||
      sidebarHasDesiredExplorer ||
      createSidebarExplorerMutation.isPending ||
      sidebarExplorerCreationKeyRef.current === sidebarExplorerCreationKey
    ) {
      return;
    }
    sidebarExplorerCreationKeyRef.current = sidebarExplorerCreationKey;
    createSidebarExplorerMutation.mutate(sidebarExplorerCreationInput);
  }, [
    createSidebarExplorerMutation,
    explorers.isSuccess,
    isPopout,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarHasDesiredExplorer,
    tabLayout.isSuccess,
  ]);
  useEffect(() => {
    if (
      sidebarFilePreview &&
      (sidebarFilePreview.projectId !== selectedProjectId ||
        (explorers.isSuccess && !sidebarPreviewExplorer))
    ) {
      sidebarFilePreviewLifecycleRef.current = null;
      setSidebarFilePreview(null);
    }
  }, [
    explorers.isSuccess,
    selectedProjectId,
    sidebarFilePreview,
    sidebarPreviewExplorer,
  ]);
  const validMobileGroupIds = useMemo(
    () =>
      new Set(
        tabLayout.data?.projectId === selectedProjectId
          ? tabLayout.data.groups.map(({ id }) => id)
          : [],
      ),
    [selectedProjectId, tabLayout.data],
  );
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
  const selectedTabGroup = tabLayout.data?.groups.find(
    (group) => group.id === workspaceSelection.selectedGroupId,
  );
  const selectedGroupSurfaces = workspaceSelection.selectedGroupId
    ? (projectSurfaceIndex.byGroupId.get(workspaceSelection.selectedGroupId) ??
      [])
    : [];
  const sidebarPreviewGroupSurfaces = sidebarFilePreview?.groupId
    ? (projectSurfaceIndex.byGroupId.get(sidebarFilePreview.groupId) ?? [])
    : [];
  const projectTabBarSurfaces = sidebarFilePreview?.active
    ? sidebarPreviewGroupSurfaces
    : selectedGroupSurfaces;
  const showSidebarPreviewTab = Boolean(
    sidebarFilePreview &&
    (sidebarFilePreview.active ||
      (sidebarFilePreview.groupId !== null &&
        sidebarFilePreview.groupId === workspaceSelection.selectedGroupId)),
  );
  const activeMobileBottomTab = mobileBottomTabs.find(
    ({ id }) => id === activeMobileBottomTabId,
  );
  const mobileBottomNavigationItems = mobileBottomTabs.map((tab) => {
    const group = tabLayout.data?.groups.find(({ id }) => id === tab.groupId);
    const tabKey = group
      ? (workspaceSelection.activeTabByGroup[group.id] ?? group.anchorTabKey)
      : null;
    return {
      id: tab.id,
      label: group?.title,
      removable: tab.id !== PRIMARY_MOBILE_BOTTOM_TAB_ID,
      surface: tabKey ? projectSurfaceIndex.byTabKey.get(tabKey) : undefined,
    };
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
  const activePopout =
    desktopRuntime &&
    !isPopout &&
    currentSurface &&
    selectedProject &&
    selectedTabGroup
      ? {
          target: {
            activeTabKey: currentSurface.tabKey,
            groupId: selectedTabGroup.id,
            projectId: selectedProject.id,
          },
          title: currentSurface.title,
        }
      : null;
  const activeProjectOverviewPopout =
    desktopRuntime && !isPopout && projectOverviewSelected && selectedProject
      ? {
          target: {
            projectId: selectedProject.id,
            section: activeProjectOverviewSection,
            worktreeId:
              activeProjectOverviewSection === "overview" ||
              activeProjectOverviewSection === "tasks"
                ? null
                : resolvedProjectOverviewWorktreeId,
          },
          title: `${selectedProject.name} · ${projectOverviewSectionLabel(activeProjectOverviewSection)}`,
        }
      : null;
  const groupOwnedElsewhere =
    !isPopout &&
    detachedGroupId !== null &&
    detachedGroupId === selectedTabGroup?.id;
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
  const resumeDetachedGroup = useCallback(
    async (groupId: string) => {
      const explorerId = detachedExplorerIdRef.current;
      try {
        if (explorerId && selectedProjectId) {
          const refreshed = await getExplorers(selectedProjectId);
          queryClient.setQueryData(["explorers", selectedProjectId], refreshed);
          const persisted = refreshed.find(({ id }) => id === explorerId);
          const lifecycle = explorerLifecycleRef.current.get(explorerId);
          if (persisted && lifecycle) {
            await lifecycle.reconcile(persisted);
          } else {
            await queryClient.invalidateQueries({
              queryKey: ["explorer-file", explorerId],
            });
          }
        }
      } catch (error) {
        clientLogger.warn("Explorer state recovery after pop-out failed", {
          ...operationalErrorMetadata(error),
          event: "surface.explorer.popout-recovery.failed",
          operation: "recover-state",
          reasonCode: "refresh-failed",
          status: "failed",
          subsystem: "explorer",
          surfaceId: explorerId ?? undefined,
        });
      } finally {
        detachedExplorerIdRef.current = null;
        setDetachedGroupId((current) => (current === groupId ? null : current));
      }
    },
    [queryClient, selectedProjectId],
  );
  const popOutActiveView = () => {
    if (!activePopout || popoutPending) return;
    void (async () => {
      const startedAt = performance.now();
      clientLogger.info("Desktop pop-out preparation started", {
        event: "window.popout.open.started",
        operation: "open-popout",
        projectId: activePopout.target.projectId,
        subsystem: "desktop-window",
      });
      const explorerLifecycle = selectedExplorer
        ? explorerLifecycleRef.current.get(selectedExplorer.id)
        : null;
      const preparation = await prepareExplorerPopoutLifecycle(
        explorerLifecycle,
        () =>
          window.confirm(
            "This Explorer has unsaved changes. Save and continue opening it in a new window?\n\nChoose Cancel to keep editing in this window.",
          ),
      );
      if (preparation === "cancelled") return;
      if (preparation === "save-failed") {
        setPopoutError("Save the Explorer file before opening a pop-out.");
        return;
      }
      if (preparation === "state-failed") {
        setPopoutError(
          "Explorer view state could not be saved before opening the pop-out.",
        );
        return;
      }
      setPopoutPending(true);
      setPopoutError(null);
      try {
        await openDesktopPopoutGroup(activePopout.target, activePopout.title);
        detachedExplorerIdRef.current = selectedExplorer?.id ?? null;
        setDetachedGroupId(activePopout.target.groupId);
        clientLogger.info("Desktop pop-out opened", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "window.popout.open.completed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          status: "opened",
          subsystem: "desktop-window",
        });
      } catch (error) {
        clientLogger.error("Desktop pop-out failed to open", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "window.popout.open.failed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
        setPopoutError(errorText(error));
      } finally {
        setPopoutPending(false);
      }
    })();
  };
  const popOutProjectOverviewView = () => {
    if (!activeProjectOverviewPopout || popoutPending) return;
    void (async () => {
      const startedAt = performance.now();
      setPopoutPending(true);
      setPopoutError(null);
      try {
        await openDesktopProjectOverviewPopout(
          activeProjectOverviewPopout.target,
          activeProjectOverviewPopout.title,
        );
        clientLogger.info("Project overview pop-out opened", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "window.project-overview-popout.open.completed",
          operation: "open-popout",
          projectId: activeProjectOverviewPopout.target.projectId,
          status: "opened",
          subsystem: "desktop-window",
        });
      } catch (error) {
        clientLogger.error("Project overview pop-out failed to open", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "window.project-overview-popout.open.failed",
          operation: "open-popout",
          projectId: activeProjectOverviewPopout.target.projectId,
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
        setPopoutError(errorText(error));
      } finally {
        setPopoutPending(false);
      }
    })();
  };

  useEffect(() => {
    setChatRelocationOpen(false);
  }, [activeChat?.id]);
  useEffect(() => {
    const popoutContentTitle =
      currentSurface?.title ??
      (projectOverviewPopoutTarget
        ? projectOverviewSectionLabel(projectOverviewPopoutTarget.section)
        : null);
    if (!isPopout || !popoutContentTitle) return;
    const projectTitle =
      selectedProject?.github?.nameWithOwner ?? selectedProject?.name;
    const title = [popoutContentTitle, projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title).catch((error: unknown) => {
      clientLogger.warn("Desktop pop-out title update failed", {
        ...operationalErrorMetadata(error),
        event: "window.popout.title.failed",
        operation: "set-title",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [currentSurface, isPopout, projectOverviewPopoutTarget, selectedProject]);
  useEffect(() => {
    if (!desktopRuntime || isPopout || !detachedGroupId) return;
    const observedGroupId = detachedGroupId;
    let mounted = true;
    let stopObserving: (() => void) | null = null;
    const resumeLocally = () => {
      if (!mounted) return;
      void resumeDetachedGroup(observedGroupId);
    };
    void watchDesktopPopoutGroup(observedGroupId, resumeLocally)
      .then((stop) => {
        if (mounted) stopObserving = stop;
        else stop();
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        clientLogger.warn("Desktop pop-out observer failed", {
          ...operationalErrorMetadata(error),
          event: "window.popout.observe.failed",
          operation: "observe-window",
          reasonCode: "native-window-error",
          status: "recovering",
          subsystem: "desktop-window",
        });
        resumeLocally();
      });
    return () => {
      mounted = false;
      stopObserving?.();
    };
  }, [desktopRuntime, detachedGroupId, isPopout, resumeDetachedGroup]);
  useEffect(() => {
    scrolledContentRef.current.clear();
    setContentScrolled(false);
  }, [activeContentKey]);
  useEffect(() => {
    const root = contentRootRef.current;
    if (!root || isPopout) return;
    const update = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      const scrolled = scrolledContentRef.current;
      for (const candidate of scrolled) {
        if (!(candidate instanceof Node) || !root.contains(candidate)) {
          scrolled.delete(candidate);
        }
      }
      if (hasScrolledContent(target)) scrolled.add(target);
      else scrolled.delete(target);
      setContentScrolled(scrolled.size > 0);
    };
    root.addEventListener("scroll", update, true);
    return () => root.removeEventListener("scroll", update, true);
  }, [isPopout]);
  useEffect(() => {
    if (
      sidebarResizePointerIdRef.current !== null ||
      settings.data?.preferences.sidebarWidth === undefined
    ) {
      return;
    }
    const width = clampSidebarWidth(settings.data.preferences.sidebarWidth);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  }, [settings.data?.preferences.sidebarWidth]);
  useEffect(
    () => () => {
      const previous = sidebarResizeBodyStyleRef.current;
      if (!previous) return;
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    },
    [],
  );

  const applySidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    return next;
  };

  const restoreSidebarResizeBodyStyle = () => {
    const previous = sidebarResizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    sidebarResizeBodyStyleRef.current = null;
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizePointerIdRef.current = event.pointerId;
    sidebarResizeLeftRef.current =
      sidebarRef.current?.getBoundingClientRect().left ?? 0;
    sidebarResizeStartWidthRef.current = sidebarWidthRef.current;
    sidebarResizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    applySidebarWidth(
      sidebarWidthFromPointer(event.clientX, sidebarResizeLeftRef.current),
    );
  };

  const finishSidebarResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    sidebarResizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreSidebarResizeBodyStyle();
    setSidebarResizing(false);
    if (!persist) {
      applySidebarWidth(sidebarResizeStartWidthRef.current);
      return;
    }
    if (sidebarWidthRef.current !== sidebarResizeStartWidthRef.current) {
      saveSidebarWidth.mutate(sidebarWidthRef.current);
    }
  };

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const next = sidebarWidthFromKey(sidebarWidthRef.current, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next === sidebarWidthRef.current) return;
    applySidebarWidth(next);
    saveSidebarWidth.mutate(next);
  };

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
  useEffect(() => {
    const configuredPreference = settings.data?.preferences.theme;
    const configuredHighContrast = settings.data?.preferences.highContrast;
    const preference =
      configuredPreference ?? readStartupThemePreference() ?? "system";
    const highContrast =
      configuredHighContrast ?? readStartupHighContrast() ?? false;
    if (configuredPreference) {
      rememberStartupThemePreference(configuredPreference);
    }
    if (configuredHighContrast !== undefined) {
      rememberStartupHighContrast(configuredHighContrast);
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let active = true;
    const apply = () => {
      const dark = startupThemeIsDark(preference, media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("high-contrast", highContrast);
      setCodeAppearance(codeAppearanceFor(dark, highContrast, proModeActive));
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (preference === "system") {
      media.addEventListener("change", apply);
    }
    void updateDesktopWindowTheme(desktopWindowThemeOverride(preference))
      .then(() => {
        if (active && preference === "system") apply();
      })
      .catch((error: unknown) => {
        clientLogger.warn("Desktop window theme update failed", {
          ...operationalErrorMetadata(error),
          event: "window.theme.failed",
          operation: "set-theme",
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
      });
    return () => {
      active = false;
      if (preference === "system") {
        media.removeEventListener("change", apply);
      }
    };
  }, [
    settings.data?.preferences.highContrast,
    settings.data?.preferences.theme,
    proModeActive,
  ]);

  useEffect(() => {
    const opacity = settings.data?.preferences.proModeOpacity ?? 80;
    document.documentElement.style.setProperty(
      "--pro-mode-opacity",
      `${opacity}%`,
    );
  }, [settings.data?.preferences.proModeOpacity]);

  useEffect(() => {
    const requested = settings.data?.preferences.proMode ?? false;
    const supported = isMacosDesktopRuntime();
    let active = true;
    document.documentElement.classList.toggle(
      "pro-mode",
      supported && requested,
    );
    setProModeActive(supported && requested);
    if (!supported) return;
    void updateMacosProMode(requested)
      .then((enabled) => {
        if (active) {
          document.documentElement.classList.toggle("pro-mode", enabled);
          setProModeActive(enabled);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          document.documentElement.classList.remove("pro-mode");
          setProModeActive(false);
        }
        clientLogger.warn("macOS Pro Mode update failed", {
          ...operationalErrorMetadata(error),
          event: "window.pro-mode.failed",
          operation: "set-pro-mode",
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
      });
    return () => {
      active = false;
    };
  }, [settings.data?.preferences.proMode]);

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

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkspaceSelection(emptyWorkspaceSelection());
      return;
    }
    const layout = tabLayout.data;
    if (!layout || layout.projectId !== selectedProjectId) return;
    const pendingGroup = pendingSurfaceSelection?.groupId
      ? layout.groups.find(({ id }) => id === pendingSurfaceSelection.groupId)
      : undefined;
    const pendingTabKey =
      pendingSurfaceSelection?.projectId === selectedProjectId &&
      layout.groups.some(({ members }) =>
        members.some(({ tabKey }) => tabKey === pendingSurfaceSelection.tabKey),
      )
        ? pendingSurfaceSelection.tabKey
        : (pendingGroup?.anchorTabKey ?? null);
    setWorkspaceSelection((current) => {
      const reconciled = reconcileWorkspaceSelection(
        current,
        layout,
        pendingTabKey,
      );
      return pendingTabKey
        ? selectWorkspaceTab(reconciled, layout, pendingTabKey)
        : reconciled;
    });
    if (pendingTabKey) setPendingSurfaceSelection(null);
  }, [pendingSurfaceSelection, selectedProjectId, tabLayout.data]);

  useEffect(() => {
    if (!selectedProjectId) {
      if (mobileBottomTabsProjectId !== null) resetMobileBottomTabs();
      return;
    }
    if (mobileBottomTabsProjectId === selectedProjectId || !settings.data) {
      return;
    }
    const restored = mobileBottomTabsFromConfiguration(
      settings.data.preferences.mobileProjectTabConfigurations[
        selectedProjectId
      ],
    );
    mobileBottomTabSequenceRef.current = restored.length - 1;
    persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature: JSON.stringify(mobileBottomTabConfiguration(restored)),
    };
    setMobileBottomTabs(restored);
    setMobileBottomTabsProjectId(selectedProjectId);
    setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
    setMobileTabGridOpen(false);
  }, [mobileBottomTabsProjectId, selectedProjectId, settings.data]);

  useEffect(() => {
    if (
      !compactShell ||
      !selectedProjectId ||
      mobileBottomTabsProjectId !== selectedProjectId ||
      !settings.isSuccess
    ) {
      return;
    }
    const groupIds = mobileBottomTabConfiguration(mobileBottomTabs);
    const signature = JSON.stringify(groupIds);
    if (
      persistedMobileBottomTabsRef.current?.projectId === selectedProjectId &&
      persistedMobileBottomTabsRef.current.signature === signature
    ) {
      return;
    }
    persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature,
    };
    saveMobileBottomTabs.mutate({ groupIds, projectId: selectedProjectId });
  }, [
    compactShell,
    mobileBottomTabs,
    mobileBottomTabsProjectId,
    selectedProjectId,
    settings.isSuccess,
  ]);

  useEffect(() => {
    if (!compactShell) {
      setMobileTabGridOpen(false);
      return;
    }
    if (
      mobileTabGridOpen ||
      workspaceSelection.destination !== "surface" ||
      !workspaceSelection.selectedGroupId ||
      tabLayout.data?.projectId !== selectedProjectId
    ) {
      return;
    }
    setMobileBottomTabs((current) =>
      assignMobileBottomTab(
        current,
        activeMobileBottomTabId,
        workspaceSelection.selectedGroupId!,
      ),
    );
  }, [
    activeMobileBottomTabId,
    compactShell,
    mobileTabGridOpen,
    selectedProjectId,
    tabLayout.data?.projectId,
    workspaceSelection.destination,
    workspaceSelection.selectedGroupId,
  ]);

  useEffect(() => {
    if (!compactShell || tabLayout.data?.projectId !== selectedProjectId) {
      return;
    }
    const activeTab = mobileBottomTabs.find(
      ({ id }) => id === activeMobileBottomTabId,
    );
    if (activeTab?.groupId && !validMobileGroupIds.has(activeTab.groupId)) {
      setMobileTabGridOpen(true);
    }
    setMobileBottomTabs((current) =>
      reconcileMobileBottomTabs(current, validMobileGroupIds),
    );
  }, [
    activeMobileBottomTabId,
    compactShell,
    mobileBottomTabs,
    selectedProjectId,
    tabLayout.data?.projectId,
    validMobileGroupIds,
  ]);

  useEffect(() => {
    if (!popoutTarget || !tabLayout.isSuccess || tabLayoutMutation.isPending) {
      return;
    }
    if (tabLayout.data?.groups.some(({ id }) => id === popoutTarget.groupId)) {
      return;
    }
    void closeCurrentDesktopWindow().catch((error: unknown) => {
      clientLogger.warn("Orphaned desktop pop-out failed to close", {
        ...operationalErrorMetadata(error),
        event: "window.popout.close.failed",
        operation: "close-popout",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [
    popoutTarget,
    tabLayout.data,
    tabLayout.isSuccess,
    tabLayoutMutation.isPending,
  ]);

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
  const selectMobileOverview = () => {
    setMobileTabGridOpen(false);
    setWorkspaceSelection((current) =>
      selectWorkspaceOverview(current, selectedProjectId),
    );
  };
  const selectGroupFromSidebar = (groupId: string) => {
    setSidebarFilePreview((current) =>
      current ? { ...current, active: false } : null,
    );
    const layout = tabLayout.data;
    if (!layout) return;
    const selectLocally = () => {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, layout, groupId),
      );
      setDetachedGroupId(null);
      revealWorkspace();
    };
    if (!desktopRuntime || isPopout) {
      selectLocally();
      return;
    }
    void focusDesktopPopoutGroup(groupId)
      .then((focused) => {
        if (focused) {
          setWorkspaceSelection((current) =>
            selectWorkspaceGroup(current, layout, groupId),
          );
          setDetachedGroupId(groupId);
          revealWorkspace();
        } else {
          selectLocally();
        }
      })
      .catch(() => selectLocally());
  };
  const sidebarFileGroupId = (explorer: ExplorerSummary): string | null => {
    return sidebarFileTargetGroupId({
      activeGroupId: selectedTabGroup?.id,
      explorerId: explorer.id,
      fallbackGroupId: tabLayout.data?.groups[0]?.id,
      preview: sidebarFilePreview,
    });
  };
  const focusPinnedSidebarFile = (explorer: ExplorerSummary) => {
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview(null);
    openCreatedTab(explorer.projectId, "explorer", explorer.id);
    setDesktopSidebarDrawerOpen(false);
  };
  const openSidebarFilePreview = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    if (entry.kind !== "file" || !entry.viewable) return;
    const pinned = pinnedExplorerForPath({
      explorers: explorers.data ?? [],
      layout: tabLayout.data,
      path: entry.path,
      worktreeId: explorer.worktreeId,
    });
    if (pinned) {
      focusPinnedSidebarFile(pinned);
      return;
    }
    const previewLifecycle = sidebarFilePreview
      ? sidebarFilePreviewLifecycleRef.current
      : (explorerLifecycleRef.current.get(explorer.id) ?? null);
    if (
      sidebarFilePreview?.path !== entry.path &&
      !confirmExplorerDiscard(previewLifecycle, () =>
        window.confirm(
          "Open another file and discard the unsaved changes in this preview?",
        ),
      )
    ) {
      return;
    }
    const groupId = sidebarFileGroupId(explorer);
    const layout = tabLayout.data;
    if (layout && groupId) {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, layout, groupId),
      );
    }
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview({
      active: true,
      explorerId: explorer.id,
      groupId,
      path: entry.path,
      projectId: explorer.projectId,
    });
    setDesktopSidebarDrawerOpen(false);
    setMobileTabGridOpen(false);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const pinSidebarFilePath = async (
    explorer: ExplorerSummary,
    path: string,
  ) => {
    const pinned = pinnedExplorerForPath({
      explorers: explorers.data ?? [],
      layout: tabLayout.data,
      path,
      worktreeId: explorer.worktreeId,
    });
    if (pinned) {
      focusPinnedSidebarFile(pinned);
      return;
    }
    const currentHandoff = sidebarFilePinHandoffRef.current;
    if (currentHandoff) {
      // Double-click emits both click and double-click activity. Treat an
      // exact repeated pin as the same transaction and serialize other pins
      // until its destination either becomes ready or is abandoned.
      if (
        currentHandoff.sourceExplorer.id === explorer.id &&
        currentHandoff.sourcePath === path
      ) {
        return;
      }
      return;
    }
    const handoff: SidebarFilePinHandoffState = {
      destinationExplorer: null,
      destinationExplorerId: explorer.id,
      ready: false,
      sourceExplorer: explorer,
      sourcePath: path,
      transactionId: crypto.randomUUID(),
    };
    sidebarFilePinHandoffRef.current = handoff;
    setSidebarFilePinHandoff(handoff);
    const previewLifecycle =
      sidebarFilePreview?.explorerId === explorer.id &&
      sidebarFilePreview.path === path
        ? sidebarFilePreviewLifecycleRef.current
        : null;
    if (previewLifecycle?.dirty && !(await previewLifecycle.save())) {
      if (
        sidebarFilePinHandoffRef.current?.transactionId ===
        handoff.transactionId
      ) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
      }
      return;
    }
    if (
      sidebarFilePinHandoffRef.current?.transactionId !== handoff.transactionId
    ) {
      return;
    }
    pinSidebarFileMutation.mutate({
      destinationExplorerId: handoff.destinationExplorerId,
      groupId: sidebarFileGroupId(explorer),
      path,
      transactionId: handoff.transactionId,
    });
  };
  const pinSidebarFile = (explorer: ExplorerSummary, entry: ExplorerEntry) => {
    if (entry.kind !== "file" || !entry.viewable) return;
    void pinSidebarFilePath(explorer, entry.path);
  };
  const refreshSidebarExplorerEntries = async (explorer: ExplorerSummary) => {
    const relatedExplorerIds = (explorers.data ?? [])
      .filter((candidate) => candidate.worktreeId === explorer.worktreeId)
      .map((candidate) => candidate.id);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: [
          "explorer-directory",
          explorer.projectId,
          explorer.worktreeId,
        ],
      }),
      queryClient.invalidateQueries({
        queryKey: [
          "explorer-directory-commits",
          explorer.projectId,
          explorer.worktreeId,
        ],
      }),
      ...relatedExplorerIds.map((explorerId) =>
        queryClient.invalidateQueries({
          queryKey: ["explorer-file", explorerId],
        }),
      ),
      queryClient.invalidateQueries({
        exact: true,
        queryKey: ["worktree-status", explorer.projectId, explorer.worktreeId],
      }),
    ]);
  };
  const explorersDisplayingSidebarEntry = (
    explorer: ExplorerSummary,
    entryPath: string,
  ) =>
    (explorers.data ?? []).filter(
      (candidate) =>
        candidate.worktreeId === explorer.worktreeId &&
        candidate.selectedPath !== null &&
        sidebarPathAtOrBelow(candidate.selectedPath, entryPath),
    );
  const persistSidebarEntryPathChanges = async (
    candidates: ExplorerSummary[],
    previousPath: string,
    nextPath: string | null,
  ) => {
    const updates = await Promise.all(
      candidates.map((candidate) => {
        const selectedPath = nextPath
          ? moveSidebarPath(candidate.selectedPath!, previousPath, nextPath)
          : null;
        return updateExplorerViewState(candidate.id, {
          fileMode: selectedPath
            ? defaultExplorerFileMode(selectedPath)
            : "preview",
          selectedPath,
        });
      }),
    );
    for (const updated of updates) {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
      );
      await explorerLifecycleRef.current.get(updated.id)?.reconcile(updated);
    }
  };
  const renameSidebarFileEntry = async (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    const displayedExplorers = explorersDisplayingSidebarEntry(
      explorer,
      entry.path,
    );
    for (const displayedExplorer of displayedExplorers) {
      if (!authorization.isCurrent()) {
        throw new Error("Explorer authorization changed. Try renaming again.");
      }
      const lifecycle = explorerLifecycleRef.current.get(displayedExplorer.id);
      if (lifecycle?.dirty && !(await lifecycle.save())) {
        throw new Error("Save the open file before renaming it.");
      }
    }
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try renaming again.");
    }
    if (
      sidebarFilePreview?.explorerId === explorer.id &&
      sidebarPathAtOrBelow(sidebarFilePreview.path, entry.path) &&
      sidebarFilePreviewLifecycleRef.current?.dirty &&
      !(await sidebarFilePreviewLifecycleRef.current.save())
    ) {
      throw new Error("Save the open file before renaming it.");
    }
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try renaming again.");
    }
    const result = await renameExplorerEntry(explorer.id, {
      name,
      path: entry.path,
    });
    if (!authorization.isCurrent()) return;
    if (result.newPath) {
      await persistSidebarEntryPathChanges(
        displayedExplorers,
        result.path,
        result.newPath,
      ).catch((error: unknown) =>
        setPopoutError(
          `The entry was renamed, but an open file tab could not be updated: ${errorText(error)}`,
        ),
      );
      setSidebarFilePreview((current) =>
        current &&
        current.projectId === explorer.projectId &&
        sidebarPathAtOrBelow(current.path, result.path)
          ? {
              ...current,
              path: moveSidebarPath(current.path, result.path, result.newPath!),
            }
          : current,
      );
    }
    await refreshSidebarExplorerEntries(explorer);
  };
  const deleteSidebarFileEntry = async (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    const displayedExplorers = explorersDisplayingSidebarEntry(
      explorer,
      entry.path,
    );
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try deleting again.");
    }
    await deleteExplorerEntry(explorer.id, { path: entry.path });
    if (!authorization.isCurrent()) return;
    await persistSidebarEntryPathChanges(
      displayedExplorers,
      entry.path,
      null,
    ).catch((error: unknown) =>
      setPopoutError(
        `The entry was deleted, but an open file tab could not be updated: ${errorText(error)}`,
      ),
    );
    setSidebarFilePreview((current) => {
      if (
        !current ||
        current.projectId !== explorer.projectId ||
        !sidebarPathAtOrBelow(current.path, entry.path)
      ) {
        return current;
      }
      sidebarFilePreviewLifecycleRef.current = null;
      return null;
    });
    await refreshSidebarExplorerEntries(explorer);
  };
  const openSidebarFolderNative = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ) => {
    const project = (projects.data ?? []).find(
      (candidate) => candidate.id === explorer.projectId,
    );
    if (!project?.source) return;
    void revealProjectInNativeFileManager(
      project,
      localFolder,
      entry.path,
    ).catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openSidebarFolderTerminal = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    newTerminal.mutate({
      projectId: explorer.projectId,
      directoryPath: entry.path,
      tabGroupId: sidebarFileGroupId(explorer) ?? undefined,
      title: `Terminal · ${entry.name}`,
      worktreeId: explorer.worktreeId,
      target: {
        kind: "worktree",
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
      },
    });
  };
  const openSidebarFolderGraph = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    newGraphExplorer.mutate({
      explorer,
      entry,
      tabGroupId: sidebarFileGroupId(explorer) ?? undefined,
    });
  };
  const closeSidebarFilePreview = () => {
    if (
      !confirmExplorerDiscard(sidebarFilePreviewLifecycleRef.current, () =>
        window.confirm("Close this preview and discard its unsaved changes?"),
      )
    ) {
      return;
    }
    const handoff = sidebarFilePinHandoffRef.current;
    if (
      handoff &&
      sidebarFilePreview?.explorerId === handoff.sourceExplorer.id &&
      sidebarFilePreview.path === handoff.sourcePath
    ) {
      abandonSidebarFilePinHandoff(handoff);
    }
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview(null);
  };
  const activateSidebarFilePreview = () => {
    if (!sidebarFilePreview) return;
    const layout = tabLayout.data;
    if (layout && sidebarFilePreview.groupId) {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, layout, sidebarFilePreview.groupId!),
      );
    }
    setSidebarFilePreview((current) =>
      current ? { ...current, active: true } : null,
    );
    setMobileTabGridOpen(false);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const retrySidebarFileTree = () => {
    createSidebarExplorerMutation.reset();
    sidebarExplorerCreationKeyRef.current = null;
    if (!sidebarExplorerCreationInput || !sidebarExplorerCreationKey) return;
    sidebarExplorerCreationKeyRef.current = sidebarExplorerCreationKey;
    createSidebarExplorerMutation.mutate(sidebarExplorerCreationInput);
  };
  const selectMobileBottomTab = (tabId: string) => {
    setActiveMobileBottomTabId(tabId);
    const tab = mobileBottomTabs.find(({ id }) => id === tabId);
    if (!tab?.groupId) {
      setMobileTabGridOpen(true);
      return;
    }
    setMobileTabGridOpen(false);
    selectGroupFromSidebar(tab.groupId);
  };
  const openMobileBottomTabSwitcher = (tabId: string) => {
    setActiveMobileBottomTabId(tabId);
    setMobileTabGridOpen(true);
  };
  const addMobileBottomTab = () => {
    const tabId = `mobile-${++mobileBottomTabSequenceRef.current}`;
    setMobileBottomTabs((current) => [
      ...current,
      { groupId: null, id: tabId },
    ]);
    setActiveMobileBottomTabId(tabId);
    setMobileTabGridOpen(true);
  };
  const selectGroupFromMobileSwitcher = (groupId: string) => {
    setMobileBottomTabs((current) =>
      assignMobileBottomTab(current, activeMobileBottomTabId, groupId),
    );
    setMobileTabGridOpen(false);
    selectGroupFromSidebar(groupId);
  };
  const removeMobileBottomTabById = (tabId: string) => {
    const removal = removeMobileBottomTab(mobileBottomTabs, tabId);
    if (!removal) return;
    setMobileBottomTabs(removal.tabs);
    if (tabId !== activeMobileBottomTabId) return;
    setActiveMobileBottomTabId(removal.activeTabId);
    const next = removal.tabs.find(({ id }) => id === removal.activeTabId);
    if (next?.groupId) {
      setMobileTabGridOpen(false);
      selectGroupFromSidebar(next.groupId);
    } else {
      setMobileTabGridOpen(true);
    }
  };
  const removeActiveMobileBottomTab = () =>
    removeMobileBottomTabById(activeMobileBottomTabId);
  const createProjectSurface = (
    projectId: string,
    kind: ProjectSurfaceCreateKind,
    tabGroupId?: string,
    target?: ExecutionTarget,
  ) => {
    const input: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
    } = { projectId };
    if (tabGroupId) input.tabGroupId = tabGroupId;
    if (target) input.target = target;
    if (kind === "chat") newChat.mutate(input);
    else if (kind === "terminal") newTerminal.mutate(input);
    else if (kind === "explorer") newExplorer.mutate(input);
    else if (kind === "browser") newBrowser.mutate(input);
    else if (kind === "code") newCodeTab.mutate(input);
    else if (kind === "remote-desktop") {
      if (!tabGroupId) newRemoteDesktop.reset();
      newRemoteDesktop.mutate(input);
    } else {
      newProjectView.mutate({ projectId, tabGroupId, kind });
    }
  };
  const renameSurface = (surface: ProjectSurface, title: string) => {
    if (surface.kind === "chat") {
      renameChatMutation.mutate({ chatId: surface.tabId, title });
    } else if (surface.kind === "terminal") {
      renameTerminalMutation.mutate({ terminalId: surface.tabId, title });
    } else if (surface.kind === "explorer") {
      renameExplorerMutation.mutate({ explorerId: surface.tabId, title });
    } else if (surface.kind === "browser") {
      updateBrowserMutation.mutate({
        browserId: surface.tabId,
        input: { title },
      });
    } else if (surface.kind === "code") {
      updateCodeTabMutation.mutate({ codeTabId: surface.tabId, title });
    } else {
      renameProjectViewMutation.mutate({ viewId: surface.tabId, title });
    }
  };
  const deleteSurface = (surface: ProjectSurface) => {
    if (surface.kind === "chat") deleteChatMutation.mutate(surface.tabId);
    else if (surface.kind === "terminal")
      deleteTerminalMutation.mutate(surface.tabId);
    else if (surface.kind === "explorer") requestDeleteExplorer(surface.tabId);
    else if (surface.kind === "browser")
      deleteBrowserMutation.mutate(surface.tabId);
    else if (surface.kind === "code")
      deleteCodeTabMutation.mutate(surface.tabId);
    else deleteProjectViewMutation.mutate(surface.tabId);
  };
  const deleteSurfaceImmediately = (surface: ProjectSurface) => {
    if (surface.kind === "explorer") {
      deleteExplorerMutation.mutate(surface.tabId);
      return;
    }
    deleteSurface(surface);
  };
  const creatingSurfaceKinds = new Set<ProjectSurfaceCreateKind>([
    ...(newChat.isPending ? (["chat"] as const) : []),
    ...(newTerminal.isPending ? (["terminal"] as const) : []),
    ...(newExplorer.isPending ? (["explorer"] as const) : []),
    ...(newBrowser.isPending ? (["browser"] as const) : []),
    ...(newCodeTab.isPending ? (["code"] as const) : []),
    ...(newProjectView.isPending ? (["history", "issues"] as const) : []),
    ...(newRemoteDesktop.isPending ? (["remote-desktop"] as const) : []),
  ]);
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
  const surfaceCreationFailure = newChat.isError
    ? { label: "Agent", error: newChat.error, dismiss: newChat.reset }
    : newTerminal.isError
      ? {
          label: "terminal",
          error: newTerminal.error,
          dismiss: newTerminal.reset,
        }
      : newExplorer.isError
        ? {
            label: "Explorer",
            error: newExplorer.error,
            dismiss: newExplorer.reset,
          }
        : newBrowser.isError
          ? {
              label: "Browser",
              error: newBrowser.error,
              dismiss: newBrowser.reset,
            }
          : newCodeTab.isError
            ? {
                label: "Code tab",
                error: newCodeTab.error,
                dismiss: newCodeTab.reset,
              }
            : newRemoteDesktop.isError
              ? {
                  label: "Remote Desktop",
                  error: newRemoteDesktop.error,
                  dismiss: newRemoteDesktop.reset,
                }
              : null;
  const handleWorkspaceDrop = (operation: WorkspaceDropOperation) => {
    setWorkspaceDragError(null);
    if (operation.type === "tab-layout") {
      if (tabLayoutMutation.isPending) {
        setWorkspaceDragError("Wait for the current tab move to finish.");
        return;
      }
      tabLayoutMutation.mutate({
        projectId: operation.projectId,
        command: operation.command,
      });
      return;
    }
    const current = projects.data ?? [];
    const from = current.findIndex(
      ({ id }) => id === operation.sourceProjectId,
    );
    const to = current.findIndex(({ id }) => id === operation.targetProjectId);
    if (from < 0 || to < 0) return;
    const reordered = [...current];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    reorderProjectsMutation.mutate(reordered.map(({ id }) => id));
  };
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
                  onClick={() =>
                    void focusDesktopPopoutGroup(selectedTabGroup.id)
                      .then((focused) => {
                        if (!focused) {
                          void resumeDetachedGroup(selectedTabGroup.id);
                        }
                      })
                      .catch((error: unknown) =>
                        setPopoutError(errorText(error)),
                      )
                  }
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
