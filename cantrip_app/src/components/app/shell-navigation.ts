import type {
  AppDestinationUpdate,
  AppMode,
  ChatSummary,
  ClientControlCommand,
  ProjectSummary,
  ProjectPaneRegion,
  ProjectSurfaceResourceRef,
  ProjectTabLayoutSummary,
  ProjectWorkspaceSummary,
  SettingsBundle,
  StandaloneChatSummary,
  TunnelSummary,
} from "@cantrip/protocol";
import { projectSurfaceViewId } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ShellEnvironment } from "@/components/app/shell-environment";
import type { ProjectSettingsSection } from "@/components/projects/project-settings-page";
import type { ProjectCreateSource } from "@/components/projects/project-create-menu";
import type { FolderSourceMode } from "@/components/projects/folder-project-dialog";
import type { SettingsSection } from "@/components/settings/settings-page";
import type { AppToastInput } from "@/components/ui/app-toast";
import {
  CantripApiError,
  getProjectTabLayout,
  getSettings,
  openProjectSurfaceView,
  updateAppDestination,
} from "@/lib/api";
import { resolveAppStartupNavigation } from "@/lib/app-navigation";
import { useAppLiveClientControl } from "@/lib/app-live-react";
import { openClientNotification } from "@/lib/client-control-content-encryption";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { projectSelectionAction } from "@/lib/mobile-navigation";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";
import { projectSurfaceTabKey } from "@/lib/project-surface";
import { resolveProjectWorkspaceForSelection } from "@/lib/project-workspaces";
import type { SidebarFilePreviewState } from "@/lib/sidebar-file-tabs";
import {
  emptyWorkspaceSelection,
  selectWorkspaceTab,
  selectWorkspaceOverview,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export interface PendingSurfaceSelection {
  paneId?: string;
  projectId: string;
  tabKey: string;
}

export function projectTabLayoutContainsTab(
  layout: ProjectTabLayoutSummary | undefined,
  projectId: string,
  tabKey: string,
): boolean {
  return Boolean(
    layout?.projectId === projectId &&
    layout.panes.some((pane) =>
      pane.members.some((member) => member.tabKey === tabKey),
    ),
  );
}

export async function openOrFocusProjectSurface({
  projectId,
  queryClient,
  surfaceRef,
  targetPaneId,
  targetRegion,
}: {
  projectId: string;
  queryClient: QueryClient;
  surfaceRef: ProjectSurfaceResourceRef;
  targetPaneId?: string;
  targetRegion?: ProjectPaneRegion;
}) {
  const viewId = projectSurfaceViewId({ projectId, resource: surfaceRef });
  let layout = queryClient.getQueryData<ProjectTabLayoutSummary>([
    "project-tab-layout",
    projectId,
  ]);
  layout ??= await getProjectTabLayout(projectId);
  try {
    layout = (
      await openProjectSurfaceView(projectId, {
        revision: layout.revision,
        surfaceRef,
        ...(targetPaneId ? { targetPaneId } : {}),
        ...(targetRegion ? { targetRegion } : {}),
      })
    ).layout;
  } catch (error) {
    if (!(error instanceof CantripApiError) || error.status !== 409) {
      throw error;
    }
    layout = await getProjectTabLayout(projectId);
    layout = (
      await openProjectSurfaceView(projectId, {
        revision: layout.revision,
        surfaceRef,
        ...(targetPaneId ? { targetPaneId } : {}),
        ...(targetRegion ? { targetRegion } : {}),
      })
    ).layout;
  }
  queryClient.setQueryData(["project-tab-layout", projectId], layout);
  return { layout, viewId } as const;
}

export type ShellDestination =
  | { kind: "workspace" }
  | { kind: "importer" }
  | { kind: "settings" }
  | { kind: "archived-chats" }
  | { kind: "server-admin" }
  | { kind: "project-settings" };

type ManagedShellDestinationKind = Exclude<
  ShellDestination["kind"],
  "workspace"
>;

export function shellDestinationVisibility(destination: ShellDestination) {
  return {
    showArchivedStandaloneChats: destination.kind === "archived-chats",
    showImporter: destination.kind === "importer",
    showProjectSettings: destination.kind === "project-settings",
    showServerAdmin: destination.kind === "server-admin",
    showSettings: destination.kind === "settings",
  } as const;
}

export function updateShellDestinationVisibility(
  current: ShellDestination,
  kind: ManagedShellDestinationKind,
  update: SetStateAction<boolean>,
): ShellDestination {
  const visible =
    typeof update === "function" ? update(current.kind === kind) : update;
  if (visible) return current.kind === kind ? current : { kind };
  return current.kind === kind ? { kind: "workspace" } : current;
}

function shellDestinationVisibilityDispatcher(
  setDestination: Dispatch<SetStateAction<ShellDestination>>,
  kind: ManagedShellDestinationKind,
): Dispatch<SetStateAction<boolean>> {
  return (update) =>
    setDestination((current) =>
      updateShellDestinationVisibility(current, kind, update),
    );
}

export function useShellNavigationState(
  environment: Pick<
    ShellEnvironment,
    | "gitHistoryTarget"
    | "isPopout"
    | "popoutProjectId"
    | "projectOverviewPopoutTarget"
  >,
) {
  const {
    gitHistoryTarget,
    isPopout,
    popoutProjectId,
    projectOverviewPopoutTarget,
  } = environment;
  const [appMode, setAppMode] = useState<AppMode | null>(
    isPopout || gitHistoryTarget ? "ide" : null,
  );
  const [selectedStandaloneChatId, setSelectedStandaloneChatId] = useState<
    string | null
  >(null);
  const [standaloneFilesOpen, setStandaloneFilesOpen] = useState(false);
  const [standaloneFilePath, setStandaloneFilePath] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setStandaloneFilesOpen(false);
    setStandaloneFilePath(null);
  }, [selectedStandaloneChatId]);
  const startupNavigationResolvedRef = useRef(
    isPopout || Boolean(gitHistoryTarget),
  );
  const destinationWriteRef = useRef<Promise<void>>(Promise.resolve());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    popoutProjectId,
  );
  const [projectOverviewSection, setProjectOverviewSection] =
    useState<ProjectOverviewSection>(
      () =>
        projectOverviewPopoutTarget?.section ??
        (gitHistoryTarget ? "history" : "overview"),
    );
  const [projectOverviewWorktreeId, setProjectOverviewWorktreeId] = useState<
    string | null
  >(
    () =>
      projectOverviewPopoutTarget?.worktreeId ??
      gitHistoryTarget?.worktreeId ??
      null,
  );
  useEffect(() => {
    if (projectOverviewPopoutTarget || gitHistoryTarget) return;
    setProjectOverviewSection("overview");
    setProjectOverviewWorktreeId(null);
  }, [gitHistoryTarget, projectOverviewPopoutTarget, selectedProjectId]);
  const [destination, setDestination] = useState<ShellDestination>({
    kind: "workspace",
  });
  const {
    setShowArchivedStandaloneChats,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
  } = useMemo(
    () => ({
      setShowArchivedStandaloneChats: shellDestinationVisibilityDispatcher(
        setDestination,
        "archived-chats",
      ),
      setShowImporter: shellDestinationVisibilityDispatcher(
        setDestination,
        "importer",
      ),
      setShowProjectSettings: shellDestinationVisibilityDispatcher(
        setDestination,
        "project-settings",
      ),
      setShowServerAdmin: shellDestinationVisibilityDispatcher(
        setDestination,
        "server-admin",
      ),
      setShowSettings: shellDestinationVisibilityDispatcher(
        setDestination,
        "settings",
      ),
    }),
    [],
  );
  const {
    showArchivedStandaloneChats,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
  } = shellDestinationVisibility(destination);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [settingsPolicyId, setSettingsPolicyId] = useState<string | null>(null);
  const [projectSettingsSection, setProjectSettingsSection] =
    useState<ProjectSettingsSection>("general");

  return {
    appMode,
    destination,
    destinationWriteRef,
    projectOverviewSection,
    projectOverviewWorktreeId,
    projectSettingsSection,
    selectedProjectId,
    selectedStandaloneChatId,
    setAppMode,
    setProjectOverviewSection,
    setProjectOverviewWorktreeId,
    setProjectSettingsSection,
    setSelectedProjectId,
    setSelectedStandaloneChatId,
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
  } as const;
}

type ShellNavigationState = ReturnType<typeof useShellNavigationState>;

export function useAppDestinationPersistence({
  destinationWriteRef,
  queryClient,
}: {
  destinationWriteRef: MutableRefObject<Promise<void>>;
  queryClient: QueryClient;
}) {
  return useCallback(
    (patch: Omit<AppDestinationUpdate, "expectedRevision">) => {
      const write = destinationWriteRef.current.then(async () => {
        let bundle = queryClient.getQueryData<SettingsBundle>(["settings"]);
        if (!bundle) {
          bundle = await getSettings();
          queryClient.setQueryData(["settings"], bundle);
        }
        const save = (expectedRevision: number) =>
          updateAppDestination({ ...patch, expectedRevision });
        let destination;
        try {
          destination = await save(bundle.preferences.destinationRevision);
        } catch (error) {
          if (!(error instanceof CantripApiError) || error.status !== 409) {
            throw error;
          }
          bundle = await getSettings();
          queryClient.setQueryData(["settings"], bundle);
          destination = await save(bundle.preferences.destinationRevision);
        }
        queryClient.setQueryData<SettingsBundle>(["settings"], (current) =>
          current
            ? {
                ...current,
                preferences: {
                  ...current.preferences,
                  lastAppMode: destination.lastAppMode,
                  lastIdeProjectId: destination.lastIdeProjectId,
                  lastIdeWorkspaceId: destination.lastIdeWorkspaceId,
                  lastStandaloneChatId: destination.lastStandaloneChatId,
                  destinationRevision: destination.revision,
                },
              }
            : current,
        );
      });
      destinationWriteRef.current = write.catch((error: unknown) => {
        clientLogger.warn("Application destination failed to save", {
          ...operationalErrorMetadata(error),
          event: "navigation.destination.save.failed",
          operation: "save-destination",
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "navigation",
        });
      });
      return write;
    },
    [destinationWriteRef, queryClient],
  );
}

export function useShellStartupNavigation({
  activeProjectWorkspaceStorageKey,
  isPopout,
  navigation,
  popoutProjectId,
  projectWorkspaces,
  projects,
  selectedProjectId,
  setActiveProjectWorkspaceId,
  setPendingSurfaceSelection,
  setWorkspaceSelection,
  settings,
  standaloneChats,
}: {
  activeProjectWorkspaceStorageKey: string;
  isPopout: boolean;
  navigation: Pick<
    ShellNavigationState,
    | "setAppMode"
    | "setSelectedProjectId"
    | "setSelectedStandaloneChatId"
    | "startupNavigationResolvedRef"
  >;
  popoutProjectId: string | null;
  projectWorkspaces: {
    data: ProjectWorkspaceSummary[] | undefined;
    isSuccess: boolean;
  };
  projects: { data: ProjectSummary[] | undefined; isSuccess: boolean };
  selectedProjectId: string | null;
  setActiveProjectWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setPendingSurfaceSelection: Dispatch<
    SetStateAction<PendingSurfaceSelection | null>
  >;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  settings: { data: SettingsBundle | undefined; isSuccess: boolean };
  standaloneChats: {
    data: StandaloneChatSummary[] | undefined;
    isError: boolean;
    isSuccess: boolean;
  };
}) {
  const {
    setAppMode,
    setSelectedProjectId,
    setSelectedStandaloneChatId,
    startupNavigationResolvedRef,
  } = navigation;
  useEffect(() => {
    if (
      startupNavigationResolvedRef.current ||
      !settings.isSuccess ||
      !projects.isSuccess ||
      !projectWorkspaces.isSuccess ||
      (!standaloneChats.isSuccess && !standaloneChats.isError)
    ) {
      return;
    }
    const preferences = settings.data!.preferences;
    const savedWorkspace =
      projectWorkspaces.data!.find(
        ({ id }) => id === preferences.lastIdeWorkspaceId,
      ) ??
      projectWorkspaces.data!.find(({ isDefault }) => isDefault) ??
      projectWorkspaces.data![0] ??
      null;
    const savedWorkspaceProjectIds = new Set(savedWorkspace?.projectIds ?? []);
    const orderedProjectIds = [
      ...projects
        .data!.filter(({ id }) => savedWorkspaceProjectIds.has(id))
        .map(({ id }) => id),
      ...projects
        .data!.filter(({ id }) => !savedWorkspaceProjectIds.has(id))
        .map(({ id }) => id),
    ];
    const destination = resolveAppStartupNavigation({
      explicitIde: isPopout,
      projectIds: orderedProjectIds,
      savedChatId: preferences.lastStandaloneChatId,
      savedMode: preferences.lastAppMode,
      savedProjectId: popoutProjectId ?? preferences.lastIdeProjectId,
      standaloneChatIds: (standaloneChats.data ?? []).map(({ id }) => id),
    });
    startupNavigationResolvedRef.current = true;
    setAppMode(destination.mode);
    setSelectedStandaloneChatId(destination.standaloneChatId);
    if (savedWorkspace) {
      setActiveProjectWorkspaceId(savedWorkspace.id);
      window.localStorage.setItem(
        activeProjectWorkspaceStorageKey,
        savedWorkspace.id,
      );
    }
    if (destination.projectId !== selectedProjectId) {
      setSelectedProjectId(destination.projectId);
      setWorkspaceSelection(emptyWorkspaceSelection(destination.projectId));
      setPendingSurfaceSelection(null);
    }
  }, [
    activeProjectWorkspaceStorageKey,
    isPopout,
    popoutProjectId,
    projectWorkspaces.data,
    projectWorkspaces.isSuccess,
    projects.data,
    projects.isSuccess,
    selectedProjectId,
    setActiveProjectWorkspaceId,
    setAppMode,
    setPendingSurfaceSelection,
    setSelectedProjectId,
    setSelectedStandaloneChatId,
    setWorkspaceSelection,
    settings.data,
    settings.isSuccess,
    standaloneChats.data,
    standaloneChats.isError,
    standaloneChats.isSuccess,
    startupNavigationResolvedRef,
  ]);
}

export function useProjectSelectionReconciliation({
  compactShell,
  explorerFileTarget,
  navigation,
  projects,
  setPendingSurfaceSelection,
  setWorkspaceSelection,
  visibleProjects,
}: {
  compactShell: boolean;
  explorerFileTarget: ShellEnvironment["explorerFileTarget"];
  navigation: Pick<
    ShellNavigationState,
    | "appMode"
    | "selectedProjectId"
    | "setSelectedProjectId"
    | "setShowImporter"
    | "setShowProjectSettings"
    | "setShowSettings"
    | "showServerAdmin"
    | "showSettings"
    | "startupNavigationResolvedRef"
  >;
  projects: ProjectSummary[] | undefined;
  setPendingSurfaceSelection: Dispatch<
    SetStateAction<PendingSurfaceSelection | null>
  >;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  visibleProjects: ProjectSummary[];
}) {
  const {
    appMode,
    selectedProjectId,
    setSelectedProjectId,
    setShowImporter,
    setShowProjectSettings,
    setShowSettings,
    showServerAdmin,
    showSettings,
    startupNavigationResolvedRef,
  } = navigation;
  useEffect(() => {
    if (
      appMode !== "ide" ||
      !startupNavigationResolvedRef.current ||
      !projects
    ) {
      return;
    }
    if (explorerFileTarget) return;
    const action = projectSelectionAction({
      compact: compactShell,
      preserveCurrentDestination: showServerAdmin || showSettings,
      projects,
      selectedProjectId,
      visibleProjects,
    });
    if (!action) return;
    if (action.showImporter !== undefined) {
      setShowImporter(action.showImporter);
    }
    if (!compactShell && projects.length === 0) {
      setShowSettings(false);
      setShowProjectSettings(false);
    } else if (compactShell) {
      setShowProjectSettings(false);
    }
    setSelectedProjectId(action.projectId);
    setWorkspaceSelection(emptyWorkspaceSelection(action.projectId));
    setPendingSurfaceSelection(null);
  }, [
    appMode,
    compactShell,
    explorerFileTarget,
    projects,
    selectedProjectId,
    setPendingSurfaceSelection,
    setSelectedProjectId,
    setShowImporter,
    setShowProjectSettings,
    setShowSettings,
    setWorkspaceSelection,
    showServerAdmin,
    showSettings,
    startupNavigationResolvedRef,
    visibleProjects,
  ]);
}

export function useShellClientControlNavigation({
  activeProjectWorkspace,
  activeProjectWorkspaceStorageKey,
  chats,
  openCreatedTab,
  openProjectTask,
  projectWorkspaces,
  projects,
  queryClient,
  selectProjectFromCommandBar,
  showAppToast,
}: {
  activeProjectWorkspace: ProjectWorkspaceSummary | null | undefined;
  activeProjectWorkspaceStorageKey: string;
  chats: ChatSummary[] | undefined;
  openCreatedTab(
    projectId: string,
    kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
    tabId: string,
  ): void;
  openProjectTask(projectId: string, chatId: string): void;
  projectWorkspaces: ProjectWorkspaceSummary[] | undefined;
  projects: ProjectSummary[] | undefined;
  queryClient: QueryClient;
  selectProjectFromCommandBar(projectId: string): boolean;
  showAppToast(toast: AppToastInput): void;
}) {
  const handleClientControl = useCallback(
    async (command: ClientControlCommand) => {
      if (!projects?.some(({ id }) => id === command.projectId)) {
        return {
          status: "declined" as const,
          detail: "The requested project is not available in this client.",
        };
      }
      window.focus();
      switch (command.kind) {
        case "notify": {
          const notification = await openClientNotification({
            opaque: command.protectedContent,
            operationId: command.operationId,
            projectId: command.projectId,
            workerId: command.workerId,
          });
          showAppToast({
            tone: notification.level,
            title: notification.title,
            message: notification.message,
          });
          return { status: "applied" as const };
        }
        case "focus-project":
          selectProjectFromCommandBar(command.projectId);
          return { status: "applied" as const };
        case "focus-surface":
          selectProjectFromCommandBar(command.projectId);
          openCreatedTab(
            command.projectId,
            command.surfaceKind,
            command.surfaceId,
          );
          return { status: "applied" as const };
        case "show-interaction":
          selectProjectFromCommandBar(command.projectId);
          if (
            chats?.find(({ id }) => id === command.chatId)?.experience ===
            "task"
          ) {
            openProjectTask(command.projectId, command.chatId);
          } else {
            openCreatedTab(command.projectId, "chat", command.chatId);
          }
          void queryClient.invalidateQueries({
            queryKey: ["agent-requests", command.chatId, "pending"],
          });
          return { status: "applied" as const };
      }
    },
    [
      activeProjectWorkspace,
      activeProjectWorkspaceStorageKey,
      chats,
      projectWorkspaces,
      projects,
      queryClient,
      showAppToast,
    ],
  );
  useAppLiveClientControl(handleClientControl);
}

export function createShellNavigationCommands({
  activeProjectWorkspace,
  activeProjectWorkspaceStorageKey,
  compactShell,
  isPopout,
  navigation,
  persistAppDestination,
  projects,
  projectWorkspaces,
  setActiveProjectWorkspaceId,
  setCommandBarOpen,
  setDesktopSidebarDrawerOpen,
  setFolderProjectDialogOpen,
  setPendingSurfaceSelection,
  setSidebarFilePreview,
  setWorkspaceSelection,
  settings,
  visibleProjects,
}: {
  activeProjectWorkspace: ProjectWorkspaceSummary | null | undefined;
  activeProjectWorkspaceStorageKey: string;
  compactShell: boolean;
  isPopout: boolean;
  navigation: Pick<
    ShellNavigationState,
    | "selectedProjectId"
    | "selectedStandaloneChatId"
    | "setAppMode"
    | "setProjectOverviewSection"
    | "setProjectOverviewWorktreeId"
    | "setSelectedProjectId"
    | "setSelectedStandaloneChatId"
    | "setSettingsSection"
    | "setShowArchivedStandaloneChats"
    | "setShowImporter"
    | "setShowProjectSettings"
    | "setShowServerAdmin"
    | "setShowSettings"
  >;
  persistAppDestination(
    patch: Omit<AppDestinationUpdate, "expectedRevision">,
  ): Promise<void>;
  projects: ProjectSummary[] | undefined;
  projectWorkspaces: ProjectWorkspaceSummary[] | undefined;
  setActiveProjectWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setCommandBarOpen: Dispatch<SetStateAction<boolean>>;
  setDesktopSidebarDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setFolderProjectDialogOpen: Dispatch<SetStateAction<boolean>>;
  setPendingSurfaceSelection: Dispatch<
    SetStateAction<PendingSurfaceSelection | null>
  >;
  setSidebarFilePreview: Dispatch<
    SetStateAction<SidebarFilePreviewState | null>
  >;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  settings: SettingsBundle | undefined;
  visibleProjects: ProjectSummary[];
}) {
  const {
    selectedProjectId,
    selectedStandaloneChatId,
    setAppMode,
    setProjectOverviewSection,
    setProjectOverviewWorktreeId,
    setSelectedProjectId,
    setSelectedStandaloneChatId,
    setSettingsSection,
    setShowArchivedStandaloneChats,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
  } = navigation;
  const revealWorkspace = () => {
    setDesktopSidebarDrawerOpen(false);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
  };
  const switchToChat = () => {
    if (isPopout) return;
    setDesktopSidebarDrawerOpen(false);
    setAppMode("chat");
    setShowImporter(false);
    setFolderProjectDialogOpen(false);
    setShowProjectSettings(false);
    setShowServerAdmin(false);
    setShowSettings(false);
    setShowArchivedStandaloneChats(false);
    setCommandBarOpen(false);
    void persistAppDestination({
      lastAppMode: "chat",
      lastStandaloneChatId: selectedStandaloneChatId,
    });
  };
  const switchToIde = () => {
    const candidate =
      (selectedProjectId && projects?.some(({ id }) => id === selectedProjectId)
        ? selectedProjectId
        : null) ??
      (settings?.preferences.lastIdeProjectId &&
      projects?.some(({ id }) => id === settings.preferences.lastIdeProjectId)
        ? settings.preferences.lastIdeProjectId
        : null) ??
      visibleProjects[0]?.id ??
      projects?.[0]?.id ??
      null;
    setDesktopSidebarDrawerOpen(false);
    setAppMode("ide");
    if (candidate !== selectedProjectId) {
      setSelectedProjectId(candidate);
      setWorkspaceSelection(emptyWorkspaceSelection(candidate));
      setPendingSurfaceSelection(null);
    }
    setShowImporter(candidate === null);
    setShowSettings(false);
    setShowArchivedStandaloneChats(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: candidate,
      lastIdeWorkspaceId: activeProjectWorkspace?.id ?? null,
    });
  };
  const selectStandaloneChat = (chat: StandaloneChatSummary) => {
    setDesktopSidebarDrawerOpen(false);
    setSelectedStandaloneChatId(chat.id);
    setShowSettings(false);
    setShowArchivedStandaloneChats(false);
    setShowServerAdmin(false);
    void persistAppDestination({
      lastAppMode: "chat",
      lastStandaloneChatId: chat.id,
    });
  };
  const selectProjectWorkspace = (workspaceId: string) => {
    const workspace = projectWorkspaces?.find(({ id }) => id === workspaceId);
    if (!workspace) return;
    setDesktopSidebarDrawerOpen(false);
    setActiveProjectWorkspaceId(workspace.id);
    window.localStorage.setItem(activeProjectWorkspaceStorageKey, workspace.id);
    if (compactShell) {
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      setPendingSurfaceSelection(null);
      setShowImporter(false);
      setShowSettings(false);
      setShowServerAdmin(false);
      setShowProjectSettings(false);
      void persistAppDestination({
        lastAppMode: "ide",
        lastIdeProjectId: null,
        lastIdeWorkspaceId: workspace.id,
      });
      return;
    }
    const projectIds = new Set(workspace.projectIds);
    const nextProjectId = projectIds.has(selectedProjectId ?? "")
      ? selectedProjectId
      : (projects?.find(({ id }) => projectIds.has(id))?.id ?? null);
    setSelectedProjectId(nextProjectId);
    setWorkspaceSelection(emptyWorkspaceSelection(nextProjectId));
    setPendingSurfaceSelection(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: nextProjectId,
      lastIdeWorkspaceId: workspace.id,
    });
  };
  const selectProjectFromSidebar = (
    projectId: string,
    workspaceId = activeProjectWorkspace?.id ?? null,
  ) => {
    setSidebarFilePreview((current) =>
      current?.projectId === projectId ? { ...current, active: false } : null,
    );
    setSelectedProjectId(projectId);
    setProjectOverviewSection("overview");
    setProjectOverviewWorktreeId(null);
    setWorkspaceSelection(emptyWorkspaceSelection(projectId));
    setPendingSurfaceSelection(null);
    revealWorkspace();
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: projectId,
      lastIdeWorkspaceId: workspaceId,
    });
  };
  const selectProjectFromCommandBar = (projectId: string) => {
    const targetWorkspace = resolveProjectWorkspaceForSelection(
      projectWorkspaces ?? [],
      projectId,
    );
    if (!targetWorkspace) return false;
    if (targetWorkspace.id !== activeProjectWorkspace?.id) {
      setActiveProjectWorkspaceId(targetWorkspace.id);
      window.localStorage.setItem(
        activeProjectWorkspaceStorageKey,
        targetWorkspace.id,
      );
    }
    selectProjectFromSidebar(projectId, targetWorkspace.id);
    return true;
  };
  const closeCompactProject = () => {
    setSelectedProjectId(null);
    setWorkspaceSelection(emptyWorkspaceSelection());
    setPendingSurfaceSelection(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowArchivedStandaloneChats(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
  };
  const openCompactRootSettings = (section: SettingsSection = "general") => {
    setSelectedProjectId(null);
    setWorkspaceSelection(emptyWorkspaceSelection());
    setPendingSurfaceSelection(null);
    setSettingsSection(section);
    setShowSettings(true);
    setShowArchivedStandaloneChats(false);
    setShowServerAdmin(false);
    setShowImporter(false);
    setShowProjectSettings(false);
  };
  const openServerAdmin = () => {
    setDesktopSidebarDrawerOpen(false);
    setShowServerAdmin(true);
    setShowImporter(false);
    setShowSettings(false);
    setShowArchivedStandaloneChats(false);
    setShowProjectSettings(false);
  };
  const returnToCompactProjectOverview = () => {
    setShowProjectSettings(false);
    setWorkspaceSelection((current) =>
      selectWorkspaceOverview(current, selectedProjectId),
    );
  };

  return {
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
  } as const;
}

export function createShellProjectNavigationCommands({
  compactShell,
  getActiveProjectWorkspaceId,
  navigation,
  persistAppDestination,
  queryClient,
  setCreatedRepositoryOnboarding,
  setDesktopSidebarDrawerOpen,
  setFolderProjectDialogMode,
  setFolderProjectDialogOpen,
  setPendingSurfaceSelection,
  setProjectTaskChatIds,
  setSidebarFilePreview,
  surfaceOpenRequestRef,
  setWorkspaceSelection,
}: {
  compactShell: boolean;
  getActiveProjectWorkspaceId(): string | null;
  navigation: Pick<
    ShellNavigationState,
    | "setAppMode"
    | "setProjectOverviewSection"
    | "setProjectSettingsSection"
    | "setSelectedProjectId"
    | "setShowImporter"
    | "setShowProjectSettings"
    | "setShowServerAdmin"
    | "setShowSettings"
  >;
  persistAppDestination(
    patch: Omit<AppDestinationUpdate, "expectedRevision">,
  ): Promise<void>;
  queryClient: QueryClient;
  setCreatedRepositoryOnboarding: Dispatch<
    SetStateAction<{ openInitialChat: boolean; projectId: string } | null>
  >;
  setDesktopSidebarDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setFolderProjectDialogMode: Dispatch<SetStateAction<FolderSourceMode>>;
  setFolderProjectDialogOpen: Dispatch<SetStateAction<boolean>>;
  setPendingSurfaceSelection: Dispatch<
    SetStateAction<PendingSurfaceSelection | null>
  >;
  setProjectTaskChatIds: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  setSidebarFilePreview: Dispatch<
    SetStateAction<SidebarFilePreviewState | null>
  >;
  surfaceOpenRequestRef: MutableRefObject<number>;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
}) {
  const {
    setAppMode,
    setProjectOverviewSection,
    setProjectSettingsSection,
    setSelectedProjectId,
    setShowImporter,
    setShowProjectSettings,
    setShowServerAdmin,
    setShowSettings,
  } = navigation;
  const openProjectCreateSource = (
    source: ProjectCreateSource,
    resetProjectSelection = false,
  ) => {
    setAppMode("ide");
    setDesktopSidebarDrawerOpen(false);
    if (resetProjectSelection) {
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      setPendingSurfaceSelection(null);
    }
    setShowImporter(source === "github");
    if (source === "folder") setFolderProjectDialogMode("create");
    setFolderProjectDialogOpen(source === "folder");
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({ lastAppMode: "ide" });
  };
  const openCreatedProject = (project: ProjectSummary) => {
    setAppMode("ide");
    setDesktopSidebarDrawerOpen(false);
    setSidebarFilePreview(null);
    setSelectedProjectId(project.id);
    setProjectOverviewSection("overview");
    setWorkspaceSelection(emptyWorkspaceSelection(project.id));
    setPendingSurfaceSelection(null);
    setShowImporter(false);
    setFolderProjectDialogOpen(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    if (project.originKind === "github") {
      setCreatedRepositoryOnboarding({
        openInitialChat: !compactShell,
        projectId: project.id,
      });
    }
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: project.id,
      lastIdeWorkspaceId: getActiveProjectWorkspaceId(),
    });
  };
  const openCreatedTab = (
    projectId: string,
    kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
    tabId: string,
  ) => {
    setAppMode("ide");
    setSidebarFilePreview((current) =>
      current?.projectId === projectId
        ? current.active
          ? { ...current, active: false }
          : current
        : null,
    );
    setDesktopSidebarDrawerOpen(false);
    const tabKey = projectSurfaceTabKey(kind, tabId);
    setSelectedProjectId(projectId);
    const cachedLayout = queryClient.getQueryData<ProjectTabLayoutSummary>([
      "project-tab-layout",
      projectId,
    ]);
    if (
      cachedLayout &&
      projectTabLayoutContainsTab(cachedLayout, projectId, tabKey)
    ) {
      setWorkspaceSelection((current) =>
        selectWorkspaceTab(current, cachedLayout, tabKey),
      );
      setPendingSurfaceSelection(null);
    } else {
      setPendingSurfaceSelection({ projectId, tabKey });
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    }
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: projectId,
      lastIdeWorkspaceId: getActiveProjectWorkspaceId(),
    });
  };
  const openOrFocusSurface = (
    projectId: string,
    surfaceRef: ProjectSurfaceResourceRef,
    targetPaneId?: string,
    targetRegion?: ProjectPaneRegion,
  ) => {
    setAppMode("ide");
    setSidebarFilePreview((current) =>
      current?.projectId === projectId ? { ...current, active: false } : null,
    );
    setDesktopSidebarDrawerOpen(false);
    setSelectedProjectId(projectId);
    const viewId = projectSurfaceViewId({ projectId, resource: surfaceRef });
    const requestId = ++surfaceOpenRequestRef.current;
    setPendingSurfaceSelection({ projectId, tabKey: viewId });
    const openRequest = openOrFocusProjectSurface({
      projectId,
      queryClient,
      surfaceRef,
      ...(targetPaneId ? { targetPaneId } : {}),
      ...(targetRegion ? { targetRegion } : {}),
    })
      .then(({ layout }) => {
        if (surfaceOpenRequestRef.current !== requestId) return true;
        setWorkspaceSelection((current) =>
          selectWorkspaceTab(current, layout, viewId),
        );
        setPendingSurfaceSelection(null);
        return true;
      })
      .catch((error: unknown) => {
        if (surfaceOpenRequestRef.current !== requestId) return;
        setPendingSurfaceSelection(null);
        clientLogger.warn("Could not open project surface view", {
          ...operationalErrorMetadata(error),
          projectId,
          viewId,
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", projectId],
        });
        return false;
      });
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: projectId,
      lastIdeWorkspaceId: getActiveProjectWorkspaceId(),
    });
    return openRequest;
  };
  const openProjectTask = (projectId: string, chatId: string) => {
    setAppMode("ide");
    setSidebarFilePreview((current) =>
      current?.projectId === projectId ? { ...current, active: false } : null,
    );
    setProjectTaskChatIds((current) => {
      const next = new Map(current);
      next.set(projectId, chatId);
      return next;
    });
    setDesktopSidebarDrawerOpen(false);
    setSelectedProjectId(projectId);
    setProjectOverviewSection("tasks");
    setWorkspaceSelection(emptyWorkspaceSelection(projectId));
    setPendingSurfaceSelection(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: projectId,
      lastIdeWorkspaceId: getActiveProjectWorkspaceId(),
    });
  };
  const closeProjectTask = (projectId: string) => {
    setProjectTaskChatIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  };
  const openProjectSettings = (
    projectId: string,
    section: ProjectSettingsSection = "general",
  ) => {
    setAppMode("ide");
    setDesktopSidebarDrawerOpen(false);
    setSelectedProjectId(projectId);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(true);
    setProjectSettingsSection(section);
    void persistAppDestination({
      lastAppMode: "ide",
      lastIdeProjectId: projectId,
      lastIdeWorkspaceId: getActiveProjectWorkspaceId(),
    });
  };
  const openTunnelOwner = (tunnel: TunnelSummary) => {
    if (!tunnel.managedBy || !tunnel.projectId) return;
    if (tunnel.managedBy.kind === "browser") {
      openCreatedTab(tunnel.projectId, "browser", tunnel.managedBy.id);
      return;
    }
    if (tunnel.managedBy.kind === "code") {
      openCreatedTab(tunnel.projectId, "code", tunnel.managedBy.id);
      return;
    }
    openProjectSettings(tunnel.projectId);
  };

  return {
    closeProjectTask,
    openCreatedProject,
    openCreatedTab,
    openOrFocusSurface,
    openProjectCreateSource,
    openProjectSettings,
    openProjectTask,
    openTunnelOwner,
  } as const;
}
