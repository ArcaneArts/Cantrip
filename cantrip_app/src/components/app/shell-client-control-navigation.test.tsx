import type {
  ClientControlCommand,
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ClientControlHandler } from "@/lib/app-live-client";
import {
  selectedWorkspaceTabKey,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";
import {
  createShellProjectNavigationCommands,
  useShellClientControlNavigation,
} from "./shell-navigation";

const live = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@/lib/app-live-react", () => ({
  useAppLiveClientControl: live.register,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const projectId = "project-one";
const surfaceId = "browser-one";
const viewId = `browser:${surfaceId}`;
const timestamp = "2026-10-08T12:00:00.000Z";
type HookInput = Parameters<typeof useShellClientControlNavigation>[0];
type NavigationInput = Parameters<
  typeof createShellProjectNavigationCommands
>[0];
let renderer: TestRenderer.ReactTestRenderer | undefined;

function layout(open = false, dock = false): ProjectTabLayoutSummary {
  return {
    projectId,
    revision: open ? 2 : 1,
    panes: [
      {
        id: "pane-one",
        projectId,
        title: "Main",
        region: dock ? "right" : "center",
        position: 0,
        anchorTabKey: viewId,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: open
          ? [
              {
                projectId,
                paneId: "pane-one",
                tabKey: viewId,
                tabKind: "browser",
                tabId: surfaceId,
                title: "Browser",
                position: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
                ...(dock
                  ? {
                      dockPresentation: {
                        preferredMode: "closed" as const,
                        restoreFraction: 0.32,
                        splitFraction: 0.32,
                      },
                    }
                  : {}),
              },
            ]
          : [],
      },
    ],
  };
}
function Bridge({ input }: { input: HookInput }) {
  useShellClientControlNavigation(input);
  return null;
}
async function mount(initial = layout()) {
  vi.stubGlobal("window", { focus: vi.fn() });
  let selection: WorkspaceSelection = {
    activeTabByPane: {},
    destination: "overview",
    focusedPaneId: null,
    projectId,
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(["project-tab-layout", projectId], initial);
  const options = {
    compactShell: false,
    getActiveProjectWorkspaceId: () => "workspace-one",
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
    setPendingSurfaceSelection: vi.fn(),
    setProjectTaskChatIds: vi.fn(),
    setSidebarFilePreview: vi.fn(),
    setWorkspaceSelection: vi.fn<NavigationInput["setWorkspaceSelection"]>(
      (update) => {
        selection = typeof update === "function" ? update(selection) : update;
      },
    ),
    surfaceOpenRequestRef: { current: 0 },
  } satisfies NavigationInput;
  const commands = createShellProjectNavigationCommands(options);
  const input = {
    activeProjectWorkspace: null,
    activeProjectWorkspaceStorageKey: "workspace",
    chats: [],
    openCreatedTab: vi.fn(),
    openOrFocusSurface: commands.openOrFocusSurface,
    openProjectTask: commands.openProjectTask,
    projectWorkspaces: [],
    projects: [{ id: projectId }] as ProjectSummary[],
    queryClient,
    selectProjectFromCommandBar: vi.fn().mockReturnValue(true),
    showAppToast: vi.fn(),
  };
  await act(async () => {
    renderer = TestRenderer.create(<Bridge input={input} />);
  });
  const handler = live.register.mock.lastCall![0] as ClientControlHandler;
  const focus = async (
    surfaceKind: Extract<
      ClientControlCommand,
      { kind: "focus-surface" }
    >["surfaceKind"] = "browser",
  ) => handler({ kind: "focus-surface", projectId, surfaceId, surfaceKind });
  return { focus, input, options, queryClient, selection: () => selection };
}
const opened = (value = layout(true)) => ({
  disposition: "opened" as const,
  layout: value,
  paneId: "pane-one",
  viewId,
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  live.register.mockClear();
});

describe("client surface focus", () => {
  it("opens a closed Browser and selects it before acknowledging applied", async () => {
    let resolve!: (value: ReturnType<typeof opened>) => void;
    const open = vi
      .spyOn(api, "openProjectSurfaceView")
      .mockImplementation(() => new Promise((done) => (resolve = done)));
    const fixture = await mount();
    let acknowledged = false;
    const pending = fixture.focus().then((result) => {
      acknowledged = true;
      return result;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    expect(selectedWorkspaceTabKey(fixture.selection())).toBeNull();
    resolve(opened());
    expect(await pending).toEqual({ status: "applied" });
    expect(selectedWorkspaceTabKey(fixture.selection())).toBe(viewId);
    expect(fixture.input.openCreatedTab).not.toHaveBeenCalled();
  });

  it.each([
    ["browser", "project.browser"],
    ["chat", "project.agent"],
    ["code", "project.code"],
    ["explorer", "project.explorer"],
    ["terminal", "project.terminal"],
  ] as const)("opens the existing %s resource", async (kind, definitionId) => {
    const open = vi
      .spyOn(api, "openProjectSurfaceView")
      .mockResolvedValue(opened());
    const fixture = await mount();
    await fixture.focus(kind);
    expect(open).toHaveBeenCalledWith(projectId, {
      revision: 1,
      surfaceRef: { kind: "entity", definitionId, resourceId: surfaceId },
    });
  });

  it("focuses an already visible Browser without duplicating its layout member", async () => {
    vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue({
      ...opened(),
      disposition: "focused",
    });
    const fixture = await mount(layout(true));
    expect(await fixture.focus()).toEqual({ status: "applied" });
    expect(await fixture.focus()).toEqual({ status: "applied" });
    const saved = fixture.queryClient.getQueryData<ProjectTabLayoutSummary>([
      "project-tab-layout",
      projectId,
    ]);
    expect(saved?.panes.flatMap((pane) => pane.members)).toHaveLength(1);
    expect(selectedWorkspaceTabKey(fixture.selection())).toBe(viewId);
  });

  it.each([false, true])(
    "retries a layout conflict once (persistent=%s)",
    async (persistent) => {
      const conflict = new api.CantripApiError("Layout changed", 409);
      const open = vi
        .spyOn(api, "openProjectSurfaceView")
        .mockRejectedValueOnce(conflict);
      if (persistent) open.mockRejectedValue(conflict);
      else open.mockResolvedValue(opened());
      const refreshed = { ...layout(), revision: 8 };
      const read = vi
        .spyOn(api, "getProjectTabLayout")
        .mockResolvedValue(refreshed);
      const fixture = await mount();
      const result = await fixture.focus();
      expect(result?.status).toBe(persistent ? "declined" : "applied");
      expect(open).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenCalledOnce();
      expect(open.mock.calls[1]?.[1].revision).toBe(8);
      expect(selectedWorkspaceTabKey(fixture.selection())).toBe(
        persistent ? null : viewId,
      );
    },
  );

  it("declines an actual open failure without claiming focus", async () => {
    vi.spyOn(api, "openProjectSurfaceView").mockRejectedValue(
      new Error("Offline"),
    );
    const fixture = await mount();
    expect((await fixture.focus())?.status).toBe("declined");
    expect(selectedWorkspaceTabKey(fixture.selection())).toBeNull();
  });

  it("declines a request superseded by newer navigation", async () => {
    let resolve!: (value: ReturnType<typeof opened>) => void;
    vi.spyOn(api, "openProjectSurfaceView").mockImplementation(
      () => new Promise((done) => (resolve = done)),
    );
    const fixture = await mount();
    const pending = fixture.focus();
    fixture.options.surfaceOpenRequestRef.current += 1;
    resolve(opened());
    expect((await pending)?.status).toBe("declined");
    expect(selectedWorkspaceTabKey(fixture.selection())).toBeNull();
  });

  it("reports a declined project selection without opening its surface", async () => {
    const open = vi.spyOn(api, "openProjectSurfaceView");
    const fixture = await mount();
    fixture.input.selectProjectFromCommandBar.mockReturnValue(false);
    expect((await fixture.focus())?.status).toBe("declined");
    expect(open).not.toHaveBeenCalled();
  });

  it("reveals a Browser whose dock presentation is closed before acknowledging", async () => {
    vi.spyOn(api, "openProjectSurfaceView").mockResolvedValue(
      opened(layout(true, true)),
    );
    const reveal = vi
      .spyOn(api, "updateProjectPaneMemberPresentation")
      .mockResolvedValue(layout(true));
    const fixture = await mount(layout(true, true));
    expect(await fixture.focus()).toEqual({ status: "applied" });
    expect(reveal).toHaveBeenCalledWith(projectId, {
      revision: 2,
      tabKey: viewId,
      preferredMode: "split",
      restoreFraction: 0.32,
      splitFraction: 0.32,
    });
    expect(selectedWorkspaceTabKey(fixture.selection())).toBe(viewId);
  });
});
