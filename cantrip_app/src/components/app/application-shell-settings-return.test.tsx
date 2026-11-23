// @vitest-environment jsdom
import type { ProjectSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyWorkspace } from "./empty-workspace";
import { ApplicationShellRender } from "./application-shell-render";
import { useProjectSelectionReconciliation } from "./shell-navigation";

vi.mock("./shell-sidebar", () => ({
  ShellSidebar: ({
    bindings,
  }: {
    bindings: { openSettings: () => void; selectedProjectId: string | null };
  }) => (
    <button
      onClick={bindings.openSettings}
      data-project-id={bindings.selectedProjectId}
    >
      Open settings
    </button>
  ),
}));
vi.mock("./shell-overlays", () => ({ ShellOverlays: () => null }));
vi.mock("./global-content-host", () => ({
  DetachedPanePlaceholder: () => null,
  GlobalContentHost: ({
    bindings,
  }: {
    bindings: { showSettings: boolean; selectedChat?: unknown };
  }) =>
    bindings.showSettings ? (
      <h1>Settings content</h1>
    ) : bindings.selectedChat ? null : (
      <EmptyWorkspace />
    ),
}));
vi.mock("@/components/chat/workspace-chat-panel", () => ({
  WorkspaceChatPanel: () => <textarea aria-label="Agent draft" />,
}));
vi.mock("./application-shell-surfaces", () => ({
  PersistentBrowserViews: () => null,
  PersistentCodeViews: () => null,
  PersistentExplorerViews: () => null,
  PersistentFileDocumentViews: () => null,
  PersistentTerminalViews: () => null,
}));

it.each([false, true])(
  "returns to the same project and draft after Settings (project focus=%s)",
  async (focused) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    const firstProject = {
      id: "first",
      name: "First project",
      capabilities: {},
    } as ProjectSummary;
    const project = {
      id: "project",
      name: "Selected project",
      capabilities: {},
    } as ProjectSummary;
    const projects = [firstProject, project];
    const startupNavigationResolvedRef = { current: true };
    const setWorkspaceSelection = vi.fn();
    const noop = () => {};
    const chat = { id: "chat", title: "New agent" };
    const surface = {
      kind: "chat",
      tabId: chat.id,
      tabKey: "agent-view",
      paneId: "center",
      projectId: "project",
      title: chat.title,
      entity: chat,
      member: { tabId: chat.id },
      definition: { supportedPlacements: ["center"], deletable: true },
    };
    const selection = {
      focusedPaneId: focused ? "center" : null,
      destination: focused ? "surface" : "overview",
      activeTabByPane: { center: surface.tabKey },
    };
    const bindings = {
      appMode: "ide",
      workspaceSelection: selection,
      selectedTabKey: focused ? surface.tabKey : null,
      selectedChat: focused ? chat : undefined,
      projectSurfaces: [surface],
      projectSurfaceIndex: { byPaneId: new Map([["center", [surface]]]) },
      openExplorers: [],
      settings: {},
      newBrowser: {},
      newChat: {},
      newCodeTab: {},
      newExplorer: {},
      newRemoteDesktop: {},
      newTerminal: {},
      tabLayout: {
        data: {
          panes: [
            {
              id: "center",
              projectId: "project",
              region: "center",
              anchorTabKey: surface.tabKey,
              members: [surface.member],
            },
          ],
          centerRoot: { kind: "pane", paneId: "center" },
        },
      },
      tabLayoutMutation: { isPending: false } as ComponentProps<
        typeof ApplicationShellRender
      >["bindings"]["tabLayoutMutation"],
      dockPresentationMutation: { isPending: false },
      chatConsoleOpenChats: new Set<string>(),
      terminals: { data: [] },
      workers: { data: [] },
      worktrees: { data: [] },
    };
    function Harness() {
      const [showSettings, setShowSettings] = useState(false);
      const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
        project.id,
      );
      const [visibleProjects, setVisibleProjects] = useState(projects);
      useProjectSelectionReconciliation({
        compactShell: false,
        explorerFileTarget: null,
        navigation: {
          appMode: "ide",
          selectedProjectId,
          setSelectedProjectId,
          setShowImporter: noop,
          setShowProjectSettings: noop,
          setShowSettings,
          showServerAdmin: false,
          showSettings,
          startupNavigationResolvedRef,
        },
        projects,
        setPendingSurfaceSelection: noop,
        setWorkspaceSelection,
        visibleProjects,
      });
      return (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ApplicationShellRender
              bindings={{
                ...bindings,
                showSettings,
                setShowSettings,
                selectedProjectId,
                selectedProject: projects.find(
                  ({ id }) => id === selectedProjectId,
                ),
                visibleProjects,
                openSettings: () => {
                  setShowSettings(true);
                  // Inventory can change while Settings owns the window.
                  setVisibleProjects([firstProject]);
                },
              }}
            />
          </TooltipProvider>
        </QueryClientProvider>
      );
    }
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        (element) => element.textContent === label,
      )!;
    try {
      await act(async () => root.render(<Harness />));
      const draft = container.querySelector("textarea")!;
      expect(draft).toBeInstanceOf(HTMLTextAreaElement);
      draft.value = "Keep this draft";
      await act(async () => button("Open settings").click());
      expect(container.textContent).toContain("Settings content");
      expect(container.querySelector('[role="tablist"]')).toBeNull();
      expect(draft.isConnected).toBe(false);
      await act(async () => button("Back to Project").click());
      expect(button("Open settings").dataset.projectId).toBe(project.id);
      expect(setWorkspaceSelection).not.toHaveBeenCalled();
      const pane = container.querySelector('[data-center-pane="center"]');
      expect(pane).not.toBeNull();
      expect(
        pane?.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      ).toContain("New agent");
      expect(
        pane?.querySelector('[data-center-pane-body="center"] textarea'),
      ).toBe(draft);
      expect(draft.value).toBe("Keep this draft");
      expect(
        container.querySelector('[aria-label="Empty workspace"]'),
      ).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  },
);
