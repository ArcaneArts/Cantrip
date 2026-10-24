import {
  applyWorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import {
  createShellProjectNavigationCommands,
  openOrFocusProjectSurface,
} from "./shell-navigation";
import { emptyWorkspaceSelection } from "@/lib/workspace-selection";

function setup(owner = "main") {
  let layout: WorkspaceOwnership = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: ["main", "detached"].map((id) => ({
      id,
      attachmentGeneration: 0,
      panes:
        id === owner
          ? [
              {
                id: "pane",
                region: "center",
                titleProtection: null,
                activeTabId: "opaque-view",
                tabs: [
                  {
                    id: "opaque-view",
                    resource: {
                      kind: "builtin",
                      definitionId: "project.tasks",
                    },
                    preview: false,
                    titleProtection: null,
                    dockPresentation: null,
                    builtInState: {
                      definitionId: "project.tasks",
                      worktreeId: null,
                    },
                  },
                ],
              },
            ]
          : [],
      centerRoot: id === owner ? { kind: "pane", paneId: "pane" } : null,
      focusedPaneId: id === owner ? "pane" : null,
      recentPaneIds: id === owner ? ["pane"] : [],
    })),
  };
  let serial = 0;
  const execute = vi.fn(
    async (command: Parameters<typeof applyWorkspaceCommand>[1]) => {
      const result = applyWorkspaceCommand(layout, command);
      layout = result.layout;
      return { ...result, appliedRevision: layout.revision, replayed: false };
    },
  );
  const controller = new WorkspaceCommandClient(
    layout,
    "main",
    0,
    {
      read: async () => layout,
      execute,
      classify: () => "rejected",
    },
    () => `operation-${++serial}`,
  );
  const queryClient = new QueryClient();
  const cacheWrite = vi.spyOn(queryClient, "setQueryData");
  const focusWindow = vi.fn(async (_id: string) => {});
  const options = {
    projectId: "project",
    queryClient,
    surfaceRef: { kind: "builtin", definitionId: "project.tasks" } as const,
    workspace: { controller, windowId: "main", focusWindow },
  };
  return { controller, execute, cacheWrite, focusWindow, options };
}

it("opens through ownership and returns the existing opaque view without writing legacy layout", async () => {
  const h = setup();
  const result = await openOrFocusProjectSurface(h.options);
  expect(result.viewId).toBe("opaque-view");
  expect(result.layout.panes[0]!.members[0]!.tabKey).toBe("opaque-view");
  expect(h.cacheWrite).not.toHaveBeenCalled();
  expect(h.focusWindow).not.toHaveBeenCalled();
  h.controller.dispose();
});

it("focuses the owning native window without projecting a duplicate into main", async () => {
  const h = setup("detached");
  const result = await openOrFocusProjectSurface(h.options);
  expect(result).toMatchObject({
    viewId: "opaque-view",
    focusWindowId: "detached",
  });
  expect(result.layout.panes).toEqual([]);
  expect(h.focusWindow).toHaveBeenCalledExactlyOnceWith("detached");
  expect(h.cacheWrite).not.toHaveBeenCalled();
  h.controller.dispose();
});

it("rejects a different project before issuing an ownership command", async () => {
  const h = setup();
  await expect(
    openOrFocusProjectSurface({ ...h.options, projectId: "other" }),
  ).rejects.toThrow("another project");
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.cacheWrite).not.toHaveBeenCalled();
  h.controller.dispose();
});

it("does not fall back to a legacy layout while the owned connection is loading", async () => {
  const h = setup();
  const cacheRead = vi.spyOn(h.options.queryClient, "getQueryData");
  await expect(
    openOrFocusProjectSurface({ ...h.options, workspace: null }),
  ).rejects.toThrow("not ready");
  expect(cacheRead).not.toHaveBeenCalled();
  expect(h.cacheWrite).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  h.controller.dispose();
});

it.each(["main", "detached"])(
  "shell opening selects only the owned opaque tab (%s)",
  async (owner) => {
    const h = setup(owner);
    const setWorkspaceSelection = vi.fn();
    const surfaceOpenRequestRef = { current: 0 };
    const setPendingSurfaceSelection = vi.fn((value) => {
      // Match application-shell's cancellation wrapper, not just its setter.
      if (value === null) surfaceOpenRequestRef.current += 1;
    });
    const commands = createShellProjectNavigationCommands({
      compactShell: false,
      getActiveProjectWorkspaceId: () => "workspace",
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
      persistAppDestination: async () => {},
      queryClient: h.options.queryClient,
      setCreatedRepositoryOnboarding: vi.fn(),
      setDesktopSidebarDrawerOpen: vi.fn(),
      setFolderProjectDialogMode: vi.fn(),
      setFolderProjectDialogOpen: vi.fn(),
      setPendingSurfaceSelection,
      setProjectTaskChatIds: vi.fn(),
      setSidebarFilePreview: vi.fn(),
      surfaceOpenRequestRef,
      setWorkspaceSelection,
      workspace: h.options.workspace,
    });
    expect(
      await commands.openOrFocusSurface("project", h.options.surfaceRef),
    ).toBe(true);
    if (owner === "main") {
      expect(setWorkspaceSelection).toHaveBeenCalledOnce();
      expect(
        setWorkspaceSelection.mock.calls[0]![0](
          emptyWorkspaceSelection("project"),
        ),
      ).toMatchObject({
        focusedPaneId: "pane",
        activeTabByPane: { pane: "opaque-view" },
      });
    } else {
      expect(setWorkspaceSelection).not.toHaveBeenCalled();
    }
    expect(
      setPendingSurfaceSelection.mock.calls.every(([value]) => value === null),
    ).toBe(true);
    expect(h.cacheWrite).not.toHaveBeenCalled();
    if (owner === "main") {
      const cases = [
        ["chat", "project.agent"],
        ["terminal", "project.terminal"],
        ["browser", "project.browser"],
        ["code", "project.code"],
        ["explorer", "project.explorer"],
        ["history", "project.git-history"],
        ["graph", "project.git-graph"],
        ["issues", "project.github-issues"],
        ["prs", "project.github-pull-requests"],
        ["actions", "project.github-actions"],
        ["remote-desktop", "project.remote-desktop"],
      ] as const;
      for (const [kind, definitionId] of cases) {
        commands.openCreatedTab("project", kind, `resource-${kind}`, {
          paneId: "pane",
          targetRegion: "center",
        });
        await vi.waitFor(() =>
          expect(h.controller.getSnapshot().pendingCount).toBe(0),
        );
        const tabs = h.controller
          .getSnapshot()
          .authoritative.windows.flatMap((window) =>
            window.panes.flatMap((pane) => pane.tabs),
          );
        expect(
          tabs.find(
            (tab) =>
              tab.resource.kind === "entity" &&
              tab.resource.resourceId === `resource-${kind}`,
          )?.resource,
        ).toEqual({
          kind: "entity",
          definitionId,
          resourceId: `resource-${kind}`,
        });
        expect(
          h.controller
            .getSnapshot()
            .authoritative.windows[0]!.panes[0]!.tabs.some(
              (tab) =>
                tab.resource.kind === "entity" &&
                tab.resource.resourceId === `resource-${kind}`,
            ),
        ).toBe(true);
      }
      expect(h.cacheWrite).not.toHaveBeenCalled();
    }
    h.controller.dispose();
  },
);
