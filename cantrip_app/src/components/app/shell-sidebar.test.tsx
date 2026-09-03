import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DesktopAppModeMenu, ShellSidebar } from "./shell-sidebar";

const mocks = vi.hoisted(() => ({
  projectChatListProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/projects/project-switcher", () => ({
  ProjectSwitcher: () => <div>Project switcher</div>,
}));

vi.mock("@/components/sidebar/project-chat-list", () => ({
  ProjectChatList: (props: Record<string, unknown>) => {
    mocks.projectChatListProps.push(props);
    return <div>Project chat list</div>;
  },
}));

vi.mock("@/components/servers/server-switcher", () => ({
  ServerSwitcher: () => <div>Server switcher</div>,
}));

vi.mock("@/components/sidebar/standalone-chat-sidebar", () => ({
  StandaloneChatSidebar: () => <div>Chat list</div>,
}));

describe("desktop app mode menu", () => {
  it.each([
    ["ide", "IDE"],
    ["chat", "Chat"],
  ] as const)("labels the %s titlebar mode", (appMode, label) => {
    const markup = renderToStaticMarkup(
      <DesktopAppModeMenu
        appMode={appMode}
        onSwitchChat={() => undefined}
        onSwitchIde={() => undefined}
        overlayTitlebar
      />,
    );

    expect(markup).toContain(`aria-label="${label}. Switch Cantrip mode"`);
    expect(markup).toContain(`>${label}</span>`);
  });

  it("keeps the file tree mounted through pinning and successor creation", () => {
    mocks.projectChatListProps.length = 0;
    const query = { data: [] };
    const callback = vi.fn();
    const bindings: Record<string, any> = {
      activeProjectWorkspace: null,
      appMode: "ide",
      beginSidebarResize: callback,
      bootstrap: { data: { auth: { currentUser: null } } },
      browsers: query,
      chats: query,
      codeTabs: query,
      createSidebarExplorerMutation: {
        error: null,
        isError: false,
        isPending: false,
      },
      desktopSidebarDrawer: false,
      desktopSidebarDrawerOpen: false,
      displayTerminals: [],
      explorers: { data: [], isLoading: false },
      finishSidebarResize: callback,
      isPopout: false,
      moveSidebarResize: callback,
      onlineWorker: null,
      overlayTitlebar: false,
      pinSidebarFileMutation: {
        isPending: true,
        variables: { path: "src/pinned.ts" },
      },
      projectSidebarSurfaces: [],
      projects: query,
      projectViews: query,
      projectWorkspaces: query,
      selectedProject: null,
      selectedProjectId: "project-a",
      setDesktopSidebarDrawerOpen: callback,
      setSettingsSection: callback,
      setShowArchivedStandaloneChats: callback,
      setShowImporter: callback,
      setShowProjectSettings: callback,
      setShowServerAdmin: callback,
      setShowSettings: callback,
      setSidebarCollapsed: callback,
      sidebarCollapsed: false,
      sidebarExpanded: true,
      sidebarExplorer: {
        id: "explorer-a",
        projectId: "project-a",
        worktreeId: "worktree-a",
      },
      sidebarFilePinHandoff: null,
      sidebarFilePreview: null,
      sidebarFileWorkerId: "worker-a",
      sidebarFileWorkerOnline: true,
      sidebarRef: undefined,
      sidebarResizing: false,
      sidebarWidth: 288,
      switchToChat: callback,
      switchToIde: callback,
      tabLayout: { data: null },
      workers: query,
      worktreeStatuses: {},
      worktrees: query,
    };
    const render = () =>
      renderToStaticMarkup(<ShellSidebar bindings={bindings} />);

    render();

    expect(mocks.projectChatListProps).toHaveLength(1);
    expect(mocks.projectChatListProps[0]).toEqual(
      expect.objectContaining({
        fileTreeLoading: false,
        fileTreePinningPath: "src/pinned.ts",
      }),
    );

    bindings.pinSidebarFileMutation.isPending = false;
    bindings.createSidebarExplorerMutation.isPending = true;
    mocks.projectChatListProps.length = 0;
    render();

    expect(mocks.projectChatListProps).toHaveLength(1);
    expect(mocks.projectChatListProps[0]).toEqual(
      expect.objectContaining({
        fileTreeLoading: false,
        fileTreePinningPath: null,
      }),
    );

    bindings.sidebarExplorer = null;
    mocks.projectChatListProps.length = 0;
    render();
    expect(mocks.projectChatListProps[0]?.fileTreeLoading).toBe(true);

    bindings.sidebarExplorer = {
      id: "explorer-a",
      projectId: "project-a",
      worktreeId: "worktree-a",
    };
    bindings.createSidebarExplorerMutation.isPending = false;
    bindings.explorers.isLoading = true;
    mocks.projectChatListProps.length = 0;
    render();
    expect(mocks.projectChatListProps[0]?.fileTreeLoading).toBe(true);
  });

  it("keeps Chat settings beside the server switcher", () => {
    const mutation = { error: null, isPending: false, mutate: vi.fn() };
    const markup = renderToStaticMarkup(
      <ShellSidebar
        bindings={{
          appMode: "chat",
          archiveStandaloneChat: mutation,
          archivedStandaloneChats: { data: [] },
          beginSidebarResize: vi.fn(),
          bootstrap: { data: { auth: { currentUser: null } } },
          desktopSidebarDrawer: false,
          desktopSidebarDrawerOpen: false,
          finishSidebarResize: vi.fn(),
          forkStandaloneChat: mutation,
          isPopout: false,
          moveSidebarResize: vi.fn(),
          newStandaloneChat: mutation,
          onlineWorker: null,
          openServerAdmin: vi.fn(),
          overlayTitlebar: false,
          permanentlyDeleteStandaloneChat: mutation,
          renameStandaloneChat: mutation,
          restoreStandaloneChat: mutation,
          selectedStandaloneChatId: null,
          setDesktopSidebarDrawerOpen: vi.fn(),
          setSettingsSection: vi.fn(),
          setShowArchivedStandaloneChats: vi.fn(),
          setShowImporter: vi.fn(),
          setShowProjectSettings: vi.fn(),
          setShowServerAdmin: vi.fn(),
          setShowSettings: vi.fn(),
          setSidebarCollapsed: vi.fn(),
          showArchivedStandaloneChats: false,
          sidebarCollapsed: false,
          sidebarExpanded: true,
          sidebarRef: undefined,
          sidebarResizing: false,
          sidebarWidth: 288,
          standaloneChatCreationAvailable: true,
          standaloneChatCreationUnavailableReason: null,
          standaloneChats: { data: [], error: null },
          switchToChat: vi.fn(),
          switchToIde: vi.fn(),
          workers: { data: [] },
        }}
      />,
    );

    expect(markup.indexOf("Server switcher")).toBeLessThan(
      markup.indexOf('aria-label="Open settings"'),
    );
    expect(markup).toContain('aria-label="Open settings"');
  });
});
