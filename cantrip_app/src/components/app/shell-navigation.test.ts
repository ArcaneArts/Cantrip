import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  createShellNavigationCommands,
  createShellProjectNavigationCommands,
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
    setSelectedWorkflowIntentId: vi.fn(),
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
    setDetachedGroupId: vi.fn(),
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
      activeTabByGroup: {},
      destination: "overview",
      projectId: "project-fallback",
      selectedGroupId: null,
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

describe("created tab selection", () => {
  const layout = {
    projectId: "project-1",
    groups: [
      {
        anchorTabKey: "explorer:explorer-1",
        id: "group-1",
        members: [{ tabKey: "explorer:explorer-1" }],
        projectId: "project-1",
      },
    ],
  } as ProjectTabLayoutSummary;

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
      setSelectedWorkflowIntentId: vi.fn(),
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
      activeTabByGroup: {},
      destination: "overview",
      projectId: "project-cloning",
      selectedGroupId: null,
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
        setSelectedWorkflowIntentId: vi.fn(),
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
      activeTabByGroup: Record<string, string>;
      destination: "overview";
      projectId: string;
      selectedGroupId: null;
    }) => unknown;
    expect(
      select({
        activeTabByGroup: {},
        destination: "overview",
        projectId: "project-1",
        selectedGroupId: null,
      }),
    ).toMatchObject({
      destination: "surface",
      selectedGroupId: "group-1",
    });
  });
});
