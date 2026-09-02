import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DesktopAppModeMenu, ShellSidebar } from "./shell-sidebar";

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
