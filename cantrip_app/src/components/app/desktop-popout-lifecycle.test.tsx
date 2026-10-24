import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { workspaceOwnershipSchema } from "@cantrip/protocol";

import {
  openOwnedDesktopPane,
  useDetachedDesktopPaneState,
  useDesktopPopoutEffects,
  createDesktopPaneSelectionCommands,
  useOrphanedDesktopPopoutEffect,
  useDesktopPopoutModel,
} from "./desktop-popout-lifecycle";
import {
  focusDesktopPopoutPane,
  watchDesktopPopoutPane,
  closeCurrentDesktopWindow,
} from "@/lib/desktop-popout";

it("routes the active-tab popout through transfer without moving its siblings", async () => {
  const detachOwnedPane = vi.fn(async () => "destination");
  const setPopoutPending = vi.fn(),
    setPopoutError = vi.fn();
  const claimPane = vi.fn();
  let model!: ReturnType<typeof useDesktopPopoutModel>;
  const Probe = () => {
    model = useDesktopPopoutModel({
      detachOwnedPane,
      activeProjectOverviewSection: "overview",
      currentSurface: { tabKey: "tab", title: "Files" },
      desktopRuntime: true,
      detached: {
        claims: new Map([["pane", {}]]),
        inspectedPaneIds: new Set(),
        claimPane,
      } as unknown as Parameters<typeof useDesktopPopoutModel>[0]["detached"],
      explorerLifecycleRef: { current: new Map() },
      isPopout: false,
      projectOverviewSelected: false,
      queryClient: {} as Parameters<
        typeof useDesktopPopoutModel
      >[0]["queryClient"],
      resolvedProjectOverviewWorktreeId: null,
      selectedExplorer: undefined,
      selectedProject: { id: "project" } as Parameters<
        typeof useDesktopPopoutModel
      >[0]["selectedProject"],
      selectedProjectId: "project",
      selectedPaneId: "pane",
      status: {
        popoutError: null,
        popoutPending: false,
        setPopoutError,
        setPopoutPending,
      },
    });
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    expect(model.paneOwnedElsewhere("pane")).toBe(false);
    await act(async () => model.popOutActiveView());
    expect(detachOwnedPane).toHaveBeenCalledWith("pane", "Files", "tab");
    expect(claimPane).not.toHaveBeenCalled();
    expect(setPopoutPending.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
    ]);
    detachOwnedPane.mockRejectedValueOnce(new Error("destination failed"));
    await act(async () => model.popOutActiveView());
    expect(setPopoutError).toHaveBeenLastCalledWith("destination failed");
    expect(claimPane).not.toHaveBeenCalled();
    await act(async () =>
      model.popOutTab?.({
        paneId: "other-pane",
        tabKey: "inactive-tab",
        title: "Inactive file",
      }),
    );
    expect(detachOwnedPane).toHaveBeenLastCalledWith(
      "other-pane",
      "Inactive file",
      "inactive-tab",
    );
    let finish!: (value: string) => void;
    await act(async () =>
      model.popOutPane?.({ paneId: "other-pane", title: "All files" }),
    );
    expect(detachOwnedPane).toHaveBeenLastCalledWith("other-pane", "All files");
    detachOwnedPane.mockClear();
    detachOwnedPane.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      model.popOutTab?.({ paneId: "pane", tabKey: "tab", title: "Files" });
      model.popOutActiveView();
      model.popOutPane?.({ paneId: "pane", title: "All files" });
      model.popOutTab?.({ paneId: "pane", tabKey: "tab", title: "Files" });
    });
    expect(detachOwnedPane).toHaveBeenCalledOnce();
    expect(setPopoutPending).toHaveBeenLastCalledWith(true);
    await act(async () => finish("destination"));
    expect(setPopoutPending).toHaveBeenLastCalledWith(false);
    // A synchronous adapter failure must release the same guard as rejection.
    detachOwnedPane.mockImplementationOnce(() => {
      throw new Error("adapter unavailable");
    });
    await act(async () => model.popOutActiveView());
    expect(setPopoutError).toHaveBeenLastCalledWith("adapter unavailable");
    expect(setPopoutPending).toHaveBeenLastCalledWith(false);
    await act(async () => model.popOutActiveView());
    expect(detachOwnedPane).toHaveBeenCalledTimes(3);
    expect(claimPane).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer?.unmount());
  }
});

vi.mock("@/lib/desktop-popout", async (original) => ({
  ...(await original<typeof import("@/lib/desktop-popout")>()),
  focusDesktopPopoutPane: vi.fn(),
  watchDesktopPopoutPane: vi.fn(),
  closeCurrentDesktopWindow: vi.fn(async () => {}),
}));

it.each(["loading", "reserved", "surviving", "empty", "removed", "main"])(
  "uses window ownership rather than the launch pane for orphan cleanup: %s",
  async (scenario) => {
    vi.mocked(closeCurrentDesktopWindow).mockClear();
    const pane = {
      id: "source-pane",
      region: "center",
      titleProtection: null,
      tabs: [
        {
          id: "tab",
          resource: {
            kind: "entity",
            definitionId: "project.terminal",
            resourceId: "terminal",
          },
          titleProtection: null,
          preview: false,
          builtInState: null,
          dockPresentation: null,
        },
      ],
      activeTabId: "tab",
    };
    const layout = workspaceOwnershipSchema.parse({
      version: 1,
      id: "workspace",
      projectId: "project",
      revision: 1,
      mainWindowId: "main",
      windows: [
        {
          id: "main",
          attachmentGeneration: 0,
          panes: scenario === "surviving" ? [] : [pane],
          centerRoot:
            scenario === "surviving" ? null : { kind: "pane", paneId: pane.id },
          focusedPaneId: scenario === "surviving" ? null : pane.id,
          recentPaneIds: [],
        },
        ...(scenario === "removed"
          ? []
          : [
              {
                id: "destination",
                attachmentGeneration: 0,
                panes: scenario === "surviving" ? [pane] : [],
                centerRoot:
                  scenario === "surviving"
                    ? { kind: "pane", paneId: pane.id }
                    : null,
                focusedPaneId: scenario === "surviving" ? pane.id : null,
                recentPaneIds: [],
              },
            ]),
      ],
      pendingTransfers:
        scenario === "reserved"
          ? [
              {
                id: "transfer",
                sourceWindowId: "main",
                sourceGeneration: 0,
                sourcePaneId: pane.id,
                sourcePlacement: {
                  panePosition: 0,
                  tabPosition: 0,
                  region: "center",
                  centerRoot: { kind: "pane", paneId: pane.id },
                },
                tabIds: ["tab"],
                wholePane: true,
                destinationWindowId: "destination",
                destinationGeneration: 0,
                destinationPaneId: pane.id,
                phase: "preparing",
              },
            ]
          : [],
    });
    function Probe() {
      useOrphanedDesktopPopoutEffect({
        isLayoutMutationPending: false,
        layout: { projectId: "project", revision: 1, panes: [] },
        layoutIsSuccess: true,
        popoutTarget: {
          projectId: "project",
          paneId: "original-launch-pane",
          activeTabKey: "tab",
        },
        ownership:
          scenario === "loading"
            ? null
            : {
                layout,
                windowId: scenario === "main" ? "main" : "destination",
              },
      });
      return null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    expect(closeCurrentDesktopWindow).toHaveBeenCalledTimes(
      scenario === "empty" || scenario === "removed" ? 1 : 0,
    );
    await act(async () => renderer.unmount());
  },
);
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  operationalErrorMetadata: () => ({}),
}));

function detachedFixture(): ReturnType<typeof useDetachedDesktopPaneState> {
  return {
    claims: new Map([
      ["pane", { phase: "detached", projectId: "project", explorerId: null }],
    ]),
    claimPane: vi.fn(),
    completePaneClaim: vi.fn(),
    releasePane: vi.fn(),
    reconcileDiscovery: vi.fn(),
    inspectedPaneIds: new Set(["pane"]),
    ownedPaneIds: new Set(["pane"]),
  };
}
function modelFixture(
  resumeDetachedPane: (paneId: string) => Promise<void>,
): Parameters<typeof useDesktopPopoutEffects>[0]["model"] {
  return {
    activePopout: null,
    activeProjectOverviewPopout: null,
    selectedPaneOwnedElsewhere: true,
    paneOwnedElsewhere: () => true,
    popOutActiveView: vi.fn(),
    popOutTab: undefined,
    popOutPane: undefined,
    popOutProjectOverviewView: vi.fn(),
    resumeDetachedPane,
  };
}

it("does not reclaim a detached pane when observer installation fails", async () => {
  vi.mocked(watchDesktopPopoutPane).mockRejectedValueOnce(
    new Error("native observer unavailable"),
  );
  const resumeDetachedPane = vi.fn(async () => {});
  const detached = detachedFixture();
  function Probe() {
    useDesktopPopoutEffects({
      currentSurface: null,
      desktopRuntime: true,
      isPopout: false,
      detached,
      model: modelFixture(resumeDetachedPane),
      projectOverviewPopoutTarget: null,
      selectedProject: undefined,
    });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  expect(watchDesktopPopoutPane).toHaveBeenCalledWith(
    "pane",
    expect.any(Function),
  );
  expect(resumeDetachedPane).not.toHaveBeenCalled();
  expect(detached.claims.has("pane")).toBe(true);
  await act(async () => renderer.unmount());
});

it("reports focus errors without selecting or reclaiming the remote pane", async () => {
  vi.mocked(focusDesktopPopoutPane).mockRejectedValueOnce(
    new Error("native focus failed"),
  );
  const setWorkspaceSelection = vi.fn();
  const revealWorkspace = vi.fn();
  const setPopoutError = vi.fn();
  const resumeDetachedPane = vi.fn(async () => {});
  const commands = createDesktopPaneSelectionCommands({
    desktopRuntime: true,
    isPopout: false,
    detached: detachedFixture(),
    layout: { projectId: "project", revision: 0, panes: [] },
    model: modelFixture(resumeDetachedPane),
    revealWorkspace,
    setPopoutError,
    setSidebarFilePreview: vi.fn(),
    setWorkspaceSelection,
  });
  commands.selectPaneFromSidebar("pane");
  await vi.waitFor(() =>
    expect(setPopoutError).toHaveBeenCalledWith("native focus failed"),
  );
  expect(setWorkspaceSelection).not.toHaveBeenCalled();
  expect(revealWorkspace).not.toHaveBeenCalled();
  expect(resumeDetachedPane).not.toHaveBeenCalled();
});

it("recovers after an observed close but ignores callbacks after unmount", async () => {
  const stop = vi.fn();
  let closed!: () => void;
  vi.mocked(watchDesktopPopoutPane).mockImplementationOnce(
    async (_pane, onClosed) => {
      closed = onClosed;
      return stop;
    },
  );
  const resume = vi.fn(async () => {});
  const detached = detachedFixture();
  const model = modelFixture(resume);
  function Probe() {
    useDesktopPopoutEffects({
      currentSurface: null,
      desktopRuntime: true,
      isPopout: false,
      detached,
      model,
      projectOverviewPopoutTarget: null,
      selectedProject: undefined,
    });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  closed();
  expect(resume).toHaveBeenCalledExactlyOnceWith("pane");
  await act(async () => renderer.unmount());
  expect(stop).toHaveBeenCalledOnce();
  closed();
  expect(resume).toHaveBeenCalledTimes(1);
});

it("claims before native open and releases only a failed pane", async () => {
  const order: string[] = [];
  const target = {
    activeTabKey: "terminal:one",
    paneId: "pane-a",
    projectId: "project-a",
  };
  const release = vi.fn(() => order.push("release:pane-a"));

  await expect(
    openOwnedDesktopPane({
      claim: () => order.push("claim:pane-a"),
      complete: () => order.push("complete:pane-a"),
      open: async () => {
        order.push("open:pane-a");
        throw new Error("native open failed");
      },
      release,
      target,
      title: "Terminal",
    }),
  ).rejects.toThrow("native open failed");
  expect(order).toEqual(["claim:pane-a", "open:pane-a", "release:pane-a"]);
  expect(release).toHaveBeenCalledOnce();

  order.length = 0;
  await expect(
    openOwnedDesktopPane({
      claim: () => order.push("claim:pane-b"),
      complete: () => order.push("complete:pane-b"),
      open: async () => {
        order.push("open:pane-b");
        return "created";
      },
      release: () => order.push("release:pane-b"),
      target: { ...target, paneId: "pane-b" },
      title: "Terminal",
    }),
  ).resolves.toBe("created");
  expect(order).toEqual(["claim:pane-b", "open:pane-b", "complete:pane-b"]);
});

it("tracks multiple detached panes and releases only the window that closes", async () => {
  let state!: ReturnType<typeof useDetachedDesktopPaneState>;
  const Probe = () => {
    state = useDetachedDesktopPaneState();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });

  await act(async () => {
    state.claimPane("pane-a", "project-a", "explorer-a");
    state.claimPane("pane-b", "project-b", null);
    state.completePaneClaim("pane-a");
    state.completePaneClaim("pane-b");
  });
  expect([...state.ownedPaneIds].sort()).toEqual(["pane-a", "pane-b"]);
  expect(state.claims.get("pane-a")).toEqual({
    explorerId: "explorer-a",
    phase: "detached",
    projectId: "project-a",
  });

  await act(async () => state.releasePane("pane-a"));
  expect([...state.ownedPaneIds]).toEqual(["pane-b"]);
  expect(state.claims.has("pane-a")).toBe(false);
  expect(state.claims.has("pane-b")).toBe(true);

  await act(async () => renderer.unmount());
});

it("discovers existing pane windows without replacing in-flight claims", async () => {
  let state!: ReturnType<typeof useDetachedDesktopPaneState>;
  const Probe = () => {
    state = useDetachedDesktopPaneState();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  await act(async () => {
    state.claimPane("pane-opening", "project-opening", "explorer-opening");
    state.reconcileDiscovery(
      "project-existing",
      ["pane-opening", "pane-existing", "pane-local"],
      new Set(["pane-existing"]),
    );
  });

  expect(state.claims.get("pane-opening")?.phase).toBe("detaching");
  expect(state.claims.get("pane-existing")).toEqual({
    explorerId: null,
    phase: "detached",
    projectId: "project-existing",
  });
  expect(state.claims.has("pane-local")).toBe(false);
  expect([...state.inspectedPaneIds].sort()).toEqual([
    "pane-existing",
    "pane-local",
    "pane-opening",
  ]);

  await act(async () => renderer.unmount());
});
