import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import {
  selectedWorkspaceTabKey,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

import {
  createShellNavigationCommands,
  createShellProjectNavigationCommands,
  openOrFocusProjectSurface,
  projectTabLayoutContainsTab,
  shellDestinationVisibility,
  updateShellDestinationVisibility,
  type ShellDestination,
} from "@/components/app/shell-navigation";

type CommandOptions = Parameters<typeof createShellNavigationCommands>[0];

function commandHarness(
  overrides: Partial<CommandOptions> = {},
): CommandOptions & {
  navigation: CommandOptions["navigation"];
} {
  const navigation = {
    selectedProjectId: "project-current",
    selectedStandaloneChatId: "chat-current",
    setAppMode: vi.fn(),
    setProjectOverviewSection: vi.fn(),
    setProjectOverviewWorktreeId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedStandaloneChatId: vi.fn(),
    setSettingsSection: vi.fn(),
    setShowArchivedStandaloneChats: vi.fn(),
    setShowImporter: vi.fn(),
    setShowProjectSettings: vi.fn(),
    setShowServerAdmin: vi.fn(),
    setShowSettings: vi.fn(),
  } as unknown as CommandOptions["navigation"];
  return {
    activeProjectWorkspace: { id: "workspace-current" } as NonNullable<
      CommandOptions["activeProjectWorkspace"]
    >,
    activeProjectWorkspaceStorageKey: "active-workspace",
    compactShell: false,
    isPopout: false,
    persistAppDestination: vi.fn().mockResolvedValue(undefined),
    projects: [{ id: "project-current" }] as CommandOptions["projects"],
    projectWorkspaces: [],
    setActiveProjectWorkspaceId: vi.fn(),
    setCommandBarOpen: vi.fn(),
    setDesktopSidebarDrawerOpen: vi.fn(),
    setFolderProjectDialogOpen: vi.fn(),
    setPendingSurfaceSelection: vi.fn(),
    setSidebarFilePreview: vi.fn(),
    setWorkspaceSelection: vi.fn(),
    settings: undefined,
    visibleProjects: [],
    ...overrides,
    navigation: {
      ...navigation,
      ...overrides.navigation,
    },
  } as CommandOptions & { navigation: CommandOptions["navigation"] };
}

describe("shell navigation commands", () => {
  it("switches to standalone Chat and persists the selected chat", () => {
    const options = commandHarness();
    const commands = createShellNavigationCommands(options);

    commands.switchToChat();

    expect(options.navigation.setAppMode).toHaveBeenCalledWith("chat");
    expect(options.setDesktopSidebarDrawerOpen).toHaveBeenCalledWith(false);
    expect(
      options.navigation.setShowArchivedStandaloneChats,
    ).toHaveBeenCalledWith(false);
    expect(options.persistAppDestination).toHaveBeenCalledWith({
      lastAppMode: "chat",
      lastStandaloneChatId: "chat-current",
    });
  });

  it("restores an available IDE project and resets workspace selection", () => {
    const options = commandHarness({
      navigation: {
        selectedProjectId: "missing-project",
      } as CommandOptions["navigation"],
      projects: [{ id: "project-fallback" }] as CommandOptions["projects"],
      visibleProjects: [
        { id: "project-fallback" },
      ] as CommandOptions["visibleProjects"],
    });
    const commands = createShellNavigationCommands(options);

    commands.switchToIde();

    expect(options.navigation.setSelectedProjectId).toHaveBeenCalledWith(
      "project-fallback",
    );
    expect(options.setWorkspaceSelection).toHaveBeenCalledWith({
      activeTabByPane: {},
      destination: "overview",
      focusedPaneId: null,
      projectId: "project-fallback",
    });
    expect(options.setPendingSurfaceSelection).toHaveBeenCalledWith(null);
    expect(options.persistAppDestination).toHaveBeenCalledWith({
      lastAppMode: "ide",
      lastIdeProjectId: "project-fallback",
      lastIdeWorkspaceId: "workspace-current",
    });
  });

  it("selects a project through the overview destination", () => {
    const options = commandHarness();
    const commands = createShellNavigationCommands(options);

    commands.selectProjectFromSidebar("project-next", "workspace-next");

    expect(options.navigation.setSelectedProjectId).toHaveBeenCalledWith(
      "project-next",
    );
    expect(options.navigation.setProjectOverviewSection).toHaveBeenCalledWith(
      "overview",
    );
    expect(
      options.navigation.setProjectOverviewWorktreeId,
    ).toHaveBeenCalledWith(null);
    expect(options.persistAppDestination).toHaveBeenCalledWith({
      lastAppMode: "ide",
      lastIdeProjectId: "project-next",
      lastIdeWorkspaceId: "workspace-next",
    });
  });
});

describe("shell destination state", () => {
  it.each([
    ["workspace", []],
    ["importer", ["showImporter"]],
    ["settings", ["showSettings"]],
    ["archived-chats", ["showArchivedStandaloneChats"]],
    ["server-admin", ["showServerAdmin"]],
    ["project-settings", ["showProjectSettings"]],
  ] satisfies ReadonlyArray<
    readonly [
      ShellDestination["kind"],
      ReadonlyArray<keyof ReturnType<typeof shellDestinationVisibility>>,
    ]
  >)("derives only the %s destination visibility", (kind, visibleKeys) => {
    const visibility = shellDestinationVisibility({ kind });

    expect(
      Object.entries(visibility)
        .filter(([, visible]) => visible)
        .map(([key]) => key),
    ).toEqual(visibleKeys);
  });

  it("replaces the current destination when another one opens", () => {
    expect(
      updateShellDestinationVisibility(
        { kind: "settings" },
        "server-admin",
        true,
      ),
    ).toEqual({ kind: "server-admin" });
  });

  it("returns to the workspace only when the current destination closes", () => {
    const current = { kind: "settings" } as const;

    expect(
      updateShellDestinationVisibility(current, "server-admin", false),
    ).toBe(current);
    expect(
      updateShellDestinationVisibility(current, "settings", false),
    ).toEqual({ kind: "workspace" });
  });

  it("supports the legacy functional visibility updater", () => {
    expect(
      updateShellDestinationVisibility(
        { kind: "workspace" },
        "importer",
        (visible) => !visible,
      ),
    ).toEqual({ kind: "importer" });
    expect(
      updateShellDestinationVisibility(
        { kind: "importer" },
        "importer",
        (visible) => !visible,
      ),
    ).toEqual({ kind: "workspace" });
  });
});

describe("surface view open-or-focus", () => {
  const surfaceRef = {
    kind: "entity",
    definitionId: "project.agent",
    resourceId: "agent-1",
  } as const;
  const layout = {
    projectId: "project-1",
    revision: 4,
    panes: [
      {
        id: "group-1",
        projectId: "project-1",
        members: [{ tabKey: "chat:agent-1" }],
      },
    ],
  } as unknown as ProjectTabLayoutSummary;

  it("asks the server to focus an already-open view despite a cached placement", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", "project-1"], layout);
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "focused",
      layout,
      paneId: "group-1",
      viewId: "chat:agent-1",
    });

    await expect(
      openOrFocusProjectSurface({
        projectId: "project-1",
        queryClient,
        surfaceRef,
      }),
    ).resolves.toMatchObject({ layout, viewId: "chat:agent-1" });
    expect(open).toHaveBeenCalledWith("project-1", {
      revision: 4,
      surfaceRef,
    });
    open.mockRestore();
  });

  it("opens a closed view once and caches the authoritative layout", async () => {
    const queryClient = new QueryClient();
    const closed = { ...layout, panes: [], revision: 5 };
    const reopened = { ...layout, revision: 6 };
    queryClient.setQueryData(["project-tab-layout", "project-1"], closed);
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "opened",
      layout: reopened,
      paneId: "group-1",
      viewId: "chat:agent-1",
    });

    const result = await openOrFocusProjectSurface({
      projectId: "project-1",
      queryClient,
      surfaceRef,
    });

    expect(open).toHaveBeenCalledWith("project-1", {
      revision: 5,
      surfaceRef,
    });
    expect(result.layout).toBe(reopened);
    expect(
      queryClient.getQueryData(["project-tab-layout", "project-1"]),
    ).toEqual(reopened);
    open.mockRestore();
  });

  it("lets the latest surface-open intent win when responses arrive out of order", async () => {
    type ProjectCommandOptions = Parameters<
      typeof createShellProjectNavigationCommands
    >[0];
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", "project-1"], layout);
    const setPendingSurfaceSelection = vi.fn();
    const setWorkspaceSelection = vi.fn();
    let resolveFirst!: (
      value: Awaited<ReturnType<typeof api.openProjectSurfaceView>>,
    ) => void;
    let resolveSecond!: (
      value: Awaited<ReturnType<typeof api.openProjectSurfaceView>>,
    ) => void;
    const first = new Promise<
      Awaited<ReturnType<typeof api.openProjectSurfaceView>>
    >((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<
      Awaited<ReturnType<typeof api.openProjectSurfaceView>>
    >((resolve) => {
      resolveSecond = resolve;
    });
    const open = vi
      .spyOn(api, "openProjectSurfaceView")
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const options = {
      compactShell: false,
      getActiveProjectWorkspaceId: () => "workspace-1",
      navigation: {
        setAppMode: vi.fn(),
        setProjectOverviewSection: vi.fn(),
        setProjectSettingsSection: vi.fn(),
        setSelectedProjectId: vi.fn(),
        setShowImporter: vi.fn(),
        setShowProjectSettings: vi.fn(),
        setShowServerAdmin: vi.fn(),
        setShowSettings: vi.fn(),
      },
      persistAppDestination: vi.fn().mockResolvedValue(undefined),
      queryClient,
      setCreatedRepositoryOnboarding: vi.fn(),
      setDesktopSidebarDrawerOpen: vi.fn(),
      setFolderProjectDialogMode: vi.fn(),
      setFolderProjectDialogOpen: vi.fn(),
      setPendingSurfaceSelection,
      setProjectTaskChatIds: vi.fn(),
      setSidebarFilePreview: vi.fn(),
      setWorkspaceSelection,
      surfaceOpenRequestRef: { current: 0 },
    } as unknown as ProjectCommandOptions;
    const commands = createShellProjectNavigationCommands(options);
    const secondRef = { ...surfaceRef, resourceId: "agent-2" } as const;
    const secondLayout = {
      ...layout,
      revision: 5,
      panes: [
        {
          ...layout.panes[0]!,
          anchorTabKey: "chat:agent-2",
          members: [{ tabKey: "chat:agent-2" }],
        },
      ],
    } as ProjectTabLayoutSummary;

    commands.openOrFocusSurface("project-1", surfaceRef);
    commands.openOrFocusSurface("project-1", secondRef);
    resolveSecond({
      disposition: "opened",
      layout: secondLayout,
      paneId: "group-1",
      viewId: "chat:agent-2",
    });
    await vi.waitFor(() =>
      expect(setWorkspaceSelection).toHaveBeenCalledOnce(),
    );
    resolveFirst({
      disposition: "focused",
      layout,
      paneId: "group-1",
      viewId: "chat:agent-1",
    });
    await Promise.resolve();

    expect(setWorkspaceSelection).toHaveBeenCalledOnce();
    const selectLatest = setWorkspaceSelection.mock.calls[0]?.[0] as (
      current: WorkspaceSelection,
    ) => WorkspaceSelection;
    expect(
      selectedWorkspaceTabKey(
        selectLatest({
          activeTabByPane: {},
          destination: "overview",
          focusedPaneId: null,
          projectId: "project-1",
        }),
      ),
    ).toBe("chat:agent-2");
    expect(
      setPendingSurfaceSelection.mock.calls.filter(
        ([selection]) => selection === null,
      ),
    ).toHaveLength(1);
    open.mockRestore();
  });
});

describe("created tab selection", () => {
  const layout = {
    projectId: "project-1",
    panes: [
      {
        anchorTabKey: "explorer:explorer-1",
        id: "group-1",
        members: [{ tabKey: "explorer:explorer-1" }],
        projectId: "project-1",
      },
    ],
  } as unknown as ProjectTabLayoutSummary;

  it("opens a newly cloned project on its overview", () => {
    type ProjectCommandOptions = Parameters<
      typeof createShellProjectNavigationCommands
    >[0];
    const setDesktopSidebarDrawerOpen = vi.fn();
    const setWorkspaceSelection = vi.fn();
    const setCreatedRepositoryOnboarding = vi.fn();
    const persistAppDestination = vi.fn().mockResolvedValue(undefined);
    const navigation = {
      setAppMode: vi.fn(),
      setProjectOverviewSection: vi.fn(),
      setProjectSettingsSection: vi.fn(),
      setSelectedProjectId: vi.fn(),
      setShowImporter: vi.fn(),
      setShowProjectSettings: vi.fn(),
      setShowServerAdmin: vi.fn(),
      setShowSettings: vi.fn(),
    } as unknown as ProjectCommandOptions["navigation"];
    const options = {
      compactShell: false,
      getActiveProjectWorkspaceId: () => "workspace-1",
      navigation,
      persistAppDestination,
      queryClient: new QueryClient(),
      setCreatedRepositoryOnboarding,
      setDesktopSidebarDrawerOpen,
      setFolderProjectDialogMode: vi.fn(),
      setFolderProjectDialogOpen: vi.fn(),
      setPendingSurfaceSelection: vi.fn(),
      setProjectTaskChatIds: vi.fn(),
      setSidebarFilePreview: vi.fn(),
      setWorkspaceSelection,
    } as unknown as ProjectCommandOptions;
    const project = {
      id: "project-cloning",
      originKind: "github",
    } as ProjectSummary;

    createShellProjectNavigationCommands(options).openCreatedProject(project);

    expect(navigation.setAppMode).toHaveBeenCalledWith("ide");
    expect(setDesktopSidebarDrawerOpen).toHaveBeenCalledWith(false);
    expect(navigation.setSelectedProjectId).toHaveBeenCalledWith(
      "project-cloning",
    );
    expect(navigation.setProjectOverviewSection).toHaveBeenCalledWith(
      "overview",
    );
    expect(setWorkspaceSelection).toHaveBeenCalledWith({
      activeTabByPane: {},
      destination: "overview",
      focusedPaneId: null,
      projectId: "project-cloning",
    });
    expect(setCreatedRepositoryOnboarding).toHaveBeenCalledWith({
      openInitialChat: true,
      projectId: "project-cloning",
    });
    expect(persistAppDestination).toHaveBeenCalledWith({
      lastAppMode: "ide",
      lastIdeProjectId: "project-cloning",
      lastIdeWorkspaceId: "workspace-1",
    });
  });

  it("uses an already-cached pinned tab without refreshing the layout", () => {
    expect(
      projectTabLayoutContainsTab(layout, "project-1", "explorer:explorer-1"),
    ).toBe(true);
    expect(
      projectTabLayoutContainsTab(layout, "project-1", "explorer:missing"),
    ).toBe(false);
    expect(
      projectTabLayoutContainsTab(layout, "project-2", "explorer:explorer-1"),
    ).toBe(false);
  });

  it("selects a cached pinned tab without invalidating project layout", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", "project-1"], layout);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const setPendingSurfaceSelection = vi.fn();
    const setWorkspaceSelection = vi.fn();
    type ProjectCommandOptions = Parameters<
      typeof createShellProjectNavigationCommands
    >[0];
    const options = {
      compactShell: false,
      getActiveProjectWorkspaceId: () => "workspace-1",
      navigation: {
        setAppMode: vi.fn(),
        setProjectOverviewSection: vi.fn(),
        setProjectSettingsSection: vi.fn(),
        setSelectedProjectId: vi.fn(),
        setShowImporter: vi.fn(),
        setShowProjectSettings: vi.fn(),
        setShowServerAdmin: vi.fn(),
        setShowSettings: vi.fn(),
      },
      persistAppDestination: vi.fn().mockResolvedValue(undefined),
      queryClient,
      setCreatedRepositoryOnboarding: vi.fn(),
      setDesktopSidebarDrawerOpen: vi.fn(),
      setFolderProjectDialogMode: vi.fn(),
      setFolderProjectDialogOpen: vi.fn(),
      setPendingSurfaceSelection,
      setProjectTaskChatIds: vi.fn(),
      setSidebarFilePreview: vi.fn(),
      setWorkspaceSelection,
    } as unknown as ProjectCommandOptions;

    createShellProjectNavigationCommands(options).openCreatedTab(
      "project-1",
      "explorer",
      "explorer-1",
    );

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(setPendingSurfaceSelection).toHaveBeenCalledWith(null);
    expect(setWorkspaceSelection).toHaveBeenCalledOnce();
    const select = setWorkspaceSelection.mock.calls[0]?.[0] as (current: {
      activeTabByPane: Record<string, string>;
      destination: "overview";
      focusedPaneId: null;
      projectId: string;
    }) => unknown;
    expect(
      select({
        activeTabByPane: {},
        destination: "overview",
        focusedPaneId: null,
        projectId: "project-1",
      }),
    ).toMatchObject({
      destination: "surface",
      focusedPaneId: "group-1",
    });
  });
});
