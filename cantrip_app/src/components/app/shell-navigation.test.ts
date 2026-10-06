import type {
  ProjectPaneRegion,
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { projectSurfaceViewId } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import {
  reconcileWorkspaceSelection,
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

describe("project task selection", () => {
  const projectId = "project-1";
  const tasksRef = { kind: "builtin", definitionId: "project.tasks" } as const;
  const tasksTabKey = projectSurfaceViewId({ projectId, resource: tasksRef });

  function taskLayout(region: ProjectPaneRegion = "center") {
    return {
      projectId,
      revision: 4,
      panes: [
        {
          id: "tasks-pane",
          projectId,
          region,
          anchorTabKey: "chat:agent-1",
          members: [{ tabKey: "chat:agent-1" }, { tabKey: tasksTabKey }],
        },
        {
          id: "terminal-pane",
          projectId,
          region: "bottom",
          anchorTabKey: "terminal:terminal-1",
          members: [{ tabKey: "terminal:terminal-1" }],
        },
      ],
    } as unknown as ProjectTabLayoutSummary;
  }

  function harness(
    layout: ProjectTabLayoutSummary,
    initialTabKey = tasksTabKey,
  ) {
    type Options = Parameters<typeof createShellProjectNavigationCommands>[0];
    let selection: WorkspaceSelection = {
      activeTabByPane: {
        "tasks-pane": initialTabKey,
        "terminal-pane": "terminal:terminal-1",
      },
      destination: "surface",
      focusedPaneId: "tasks-pane",
      projectId,
    };
    let taskIds: ReadonlyMap<string, string> = new Map([
      ["other-project", "other-task"],
    ]);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const surfaceOpenRequestRef = { current: 0 };
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
      setPendingSurfaceSelection: vi.fn<Options["setPendingSurfaceSelection"]>(
        (update) => {
          if (update === null) surfaceOpenRequestRef.current += 1;
        },
      ),
      setProjectTaskChatIds: vi.fn<Options["setProjectTaskChatIds"]>(
        (update) => {
          taskIds = typeof update === "function" ? update(taskIds) : update;
        },
      ),
      setSidebarFilePreview: vi.fn(),
      setWorkspaceSelection: vi.fn<Options["setWorkspaceSelection"]>(
        (update) => {
          selection = typeof update === "function" ? update(selection) : update;
        },
      ),
      surfaceOpenRequestRef,
    } satisfies Options;
    return {
      commands: createShellProjectNavigationCommands(options),
      options,
      selection: () => selection,
      taskIds: () => taskIds,
    };
  }

  it.each(["center", "right", "bottom"] as const)(
    "keeps Tasks selected in the %s pane when opening a running task",
    (region) => {
      const layout = taskLayout(region);
      const { commands, options, selection, taskIds } = harness(layout);
      const previousSelection = selection();
      const open = vi.spyOn(api, "openProjectSurfaceView");

      commands.openProjectTask(projectId, "running-task");

      expect(selection()).toEqual(previousSelection);
      expect(
        selectedWorkspaceTabKey(
          reconcileWorkspaceSelection(selection(), layout, null, true),
        ),
      ).toBe(tasksTabKey);
      expect(taskIds().get(projectId)).toBe("running-task");
      expect(taskIds().get("other-project")).toBe("other-task");
      expect(options.setPendingSurfaceSelection).toHaveBeenCalledWith(null);
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
    },
  );

  it("focuses an existing Tasks tab when opening a task from another tab", () => {
    const { commands, selection } = harness(taskLayout(), "chat:agent-1");

    commands.openProjectTask(projectId, "running-task");

    expect(selectedWorkspaceTabKey(selection())).toBe(tasksTabKey);
    expect(selection().activeTabByPane["terminal-pane"]).toBe(
      "terminal:terminal-1",
    );
  });

  it("opens and selects Tasks if its tab is closed", async () => {
    const reopened = taskLayout();
    const closed = {
      ...reopened,
      panes: reopened.panes.map((pane) => ({
        ...pane,
        members: pane.members.filter((member) => member.tabKey !== tasksTabKey),
      })),
    };
    const { commands, selection } = harness(closed, "chat:agent-1");
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "opened",
      layout: reopened,
      paneId: "tasks-pane",
      viewId: tasksTabKey,
    });

    commands.openProjectTask(projectId, "running-task");

    await vi.waitFor(() =>
      expect(selectedWorkspaceTabKey(selection())).toBe(tasksTabKey),
    );
    expect(open).toHaveBeenCalledWith(projectId, {
      revision: closed.revision,
      surfaceRef: tasksRef,
    });
    open.mockRestore();
  });

  it("does not let an older surface-open response switch away from Tasks", async () => {
    const layout = taskLayout();
    const { commands, selection } = harness(layout);
    let resolveOpen!: (
      response: Awaited<ReturnType<typeof api.openProjectSurfaceView>>,
    ) => void;
    const open = vi.spyOn(api, "openProjectSurfaceView").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const pendingOpen = commands.openOrFocusSurface(projectId, {
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "agent-1",
    });

    commands.openProjectTask(projectId, "running-task");
    resolveOpen({
      disposition: "focused",
      layout,
      paneId: "tasks-pane",
      viewId: "chat:agent-1",
    });
    await pendingOpen;

    expect(selectedWorkspaceTabKey(selection())).toBe(tasksTabKey);
    open.mockRestore();
  });

  it("keeps the current tab if opening a closed Tasks tab fails", async () => {
    const layout = taskLayout();
    const closed = {
      ...layout,
      panes: layout.panes.map((pane) => ({
        ...pane,
        members: pane.members.filter((member) => member.tabKey !== tasksTabKey),
      })),
    };
    const { commands, options, selection } = harness(closed, "chat:agent-1");
    const open = vi
      .spyOn(api, "openProjectSurfaceView")
      .mockRejectedValue(new Error("Surface unavailable"));

    commands.openProjectTask(projectId, "running-task");

    await vi.waitFor(() =>
      expect(options.setPendingSurfaceSelection).toHaveBeenLastCalledWith(null),
    );
    expect(selectedWorkspaceTabKey(selection())).toBe("chat:agent-1");
    open.mockRestore();
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

  it("refreshes a stale revision after Run creates its terminal before opening the view", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", "project-1"], {
      ...layout,
      revision: 3,
    });
    const refresh = vi
      .spyOn(api, "getProjectTabLayout")
      .mockResolvedValue(layout);
    const open = vi
      .spyOn(api, "openProjectSurfaceView")
      .mockRejectedValueOnce(
        new api.CantripApiError("Layout revision changed", 409),
      )
      .mockResolvedValueOnce({
        disposition: "focused",
        layout,
        paneId: "group-1",
        viewId: "chat:agent-1",
      });
    try {
      await openOrFocusProjectSurface({
        projectId: "project-1",
        queryClient,
        surfaceRef,
      });
      expect(open.mock.calls.map(([, input]) => input.revision)).toEqual([
        3, 4,
      ]);
      expect(refresh).toHaveBeenCalledExactlyOnceWith("project-1");
    } finally {
      open.mockRestore();
      refresh.mockRestore();
    }
  });

  it("reopens the existing Run terminal in the requested dock without creating a terminal", async () => {
    const queryClient = new QueryClient();
    const terminalRef = {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "run-terminal-1",
    } as const;
    queryClient.setQueryData(["project-tab-layout", "project-1"], {
      ...layout,
      panes: [],
      revision: 5,
    });
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "opened",
      layout,
      paneId: "group-1",
      viewId: "terminal:run-terminal-1",
    });
    await openOrFocusProjectSurface({
      projectId: "project-1",
      queryClient,
      surfaceRef: terminalRef,
      targetRegion: "bottom",
    });
    expect(open).toHaveBeenCalledExactlyOnceWith("project-1", {
      revision: 5,
      surfaceRef: terminalRef,
      targetRegion: "bottom",
    });
    open.mockRestore();
  });

  it("moves an existing Run view to the bottom and restores a collapsed dock before focusing", async () => {
    const queryClient = new QueryClient();
    const terminalRef = {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "run-terminal-1",
    } as const;
    const preference = {
      preferredMode: "closed",
      restoreFraction: 0.4,
      splitFraction: 0.4,
    } as const;
    const runLayout = (
      revision: number,
      region: "center" | "bottom",
      preferredMode: "closed" | "split",
    ) =>
      ({
        ...layout,
        revision,
        panes: [
          {
            ...layout.panes[0],
            id: region === "bottom" ? "bottom-pane" : "center-pane",
            region,
            members: [
              {
                tabKey: "terminal:run-terminal-1",
                dockPresentation: { ...preference, preferredMode },
              },
            ],
          },
        ],
      }) as ProjectTabLayoutSummary;
    const center = runLayout(5, "center", "closed");
    const bottom = runLayout(6, "bottom", "closed");
    const visible = runLayout(7, "bottom", "split");
    queryClient.setQueryData(["project-tab-layout", "project-1"], center);
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "focused",
      layout: center,
      paneId: "center-pane",
      viewId: "terminal:run-terminal-1",
    });
    const move = vi
      .spyOn(api, "moveProjectPaneMember")
      .mockResolvedValue(bottom);
    const reveal = vi
      .spyOn(api, "updateProjectPaneMemberPresentation")
      .mockResolvedValue(visible);
    try {
      const result = await openOrFocusProjectSurface({
        projectId: "project-1",
        queryClient,
        surfaceRef: terminalRef,
        targetRegion: "bottom",
        moveToTargetRegion: true,
        revealDock: true,
      });
      expect(move).toHaveBeenCalledExactlyOnceWith("project-1", {
        revision: 5,
        tabKey: "terminal:run-terminal-1",
        targetPaneId: null,
        targetMemberPosition: 0,
        targetRegion: "bottom",
      });
      expect(reveal).toHaveBeenCalledExactlyOnceWith("project-1", {
        revision: 6,
        tabKey: "terminal:run-terminal-1",
        ...preference,
        preferredMode: "split",
      });
      expect(result.layout).toBe(visible);
      expect(
        queryClient.getQueryData(["project-tab-layout", "project-1"]),
      ).toEqual(visible);
    } finally {
      open.mockRestore();
      move.mockRestore();
      reveal.mockRestore();
    }
  });

  it("focuses an open Run in its existing pane when reopened from the Running menu", async () => {
    const queryClient = new QueryClient();
    const terminalRef = {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "run-terminal-1",
    } as const;
    const opened = {
      ...layout,
      panes: [
        {
          ...layout.panes[0],
          region: "center",
          members: [{ tabKey: "terminal:run-terminal-1" }],
        },
      ],
    } as ProjectTabLayoutSummary;
    queryClient.setQueryData(["project-tab-layout", "project-1"], opened);
    const open = vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      disposition: "focused",
      layout: opened,
      paneId: "group-1",
      viewId: "terminal:run-terminal-1",
    });
    const move = vi.spyOn(api, "moveProjectPaneMember");
    const reveal = vi.spyOn(api, "updateProjectPaneMemberPresentation");
    try {
      await openOrFocusProjectSurface({
        projectId: "project-1",
        queryClient,
        surfaceRef: terminalRef,
        targetRegion: "right",
        revealDock: true,
      });
      expect(move).not.toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      move.mockRestore();
      reveal.mockRestore();
    }
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
