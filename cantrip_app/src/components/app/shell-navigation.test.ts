import { describe, expect, it, vi } from "vitest";

import { createShellNavigationCommands } from "@/components/app/shell-navigation";

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
    resetMobileBottomTabs: vi.fn(),
    setActiveProjectWorkspaceId: vi.fn(),
    setCommandBarOpen: vi.fn(),
    setDesktopSidebarDrawerOpen: vi.fn(),
    setDetachedGroupId: vi.fn(),
    setFolderProjectDialogOpen: vi.fn(),
    setMobileTabGridOpen: vi.fn(),
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
    expect(options.resetMobileBottomTabs).toHaveBeenCalledOnce();
    expect(options.persistAppDestination).toHaveBeenCalledWith({
      lastAppMode: "ide",
      lastIdeProjectId: "project-next",
      lastIdeWorkspaceId: "workspace-next",
    });
  });
});
