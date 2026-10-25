import { describe, expect, it, vi } from "vitest";
import * as desktopPopout from "./desktop-popout";

it("does not expose the retired unowned Explorer window producers", () => {
  for (const name of [
    "openDesktopExplorerFile",
    "prewarmDesktopExplorerFile",
    "clearDesktopExplorerFilePrewarm",
  ]) {
    expect(desktopPopout).not.toHaveProperty(name);
  }
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn() }));
const webviews = vi.hoisted(() => {
  const windows = new Map<string, MockWebviewWindow>();
  class MockWebviewWindow {
    readonly close = vi.fn(async () => {
      windows.delete(this.label);
      this.destroyed?.();
    });
    private destroyed: (() => void) | undefined;
    readonly hide = vi.fn(async () => undefined);
    readonly destroy = this.close;
    readonly setFocus = vi.fn(async () => undefined);
    readonly show = vi.fn(async () => undefined);
    readonly unminimize = vi.fn(async () => undefined);

    constructor(
      readonly label: string,
      readonly options?: Record<string, unknown>,
    ) {
      windows.set(label, this);
    }

    static async getByLabel(label: string): Promise<MockWebviewWindow | null> {
      return windows.get(label) ?? null;
    }

    async once(event: string, listener: () => void): Promise<() => void> {
      if (event === "tauri://created") queueMicrotask(listener);
      if (event === "tauri://destroyed") this.destroyed = listener;
      return () => undefined;
    }
  }
  return { MockWebviewWindow, windows };
});

vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: webviews.MockWebviewWindow,
}));
vi.mock("@/lib/client-log-relay", () => ({ clientLogger: logs }));

it("destroys only a cancelled workspace destination, never main", async () => {
  tauri.isTauri.mockReturnValue(true);
  const window = new webviews.MockWebviewWindow(
    "cantrip-pane-workspace-cancelled",
  );
  try {
    await desktopPopout.destroyCancelledWorkspaceWindow(window.label);
    expect(window.destroy).toHaveBeenCalledOnce();
    await expect(
      desktopPopout.destroyCancelledWorkspaceWindow("main"),
    ).rejects.toThrow("cancelled transfer destination");
  } finally {
    tauri.isTauri.mockReturnValue(false);
  }
});
import {
  desktopBackgroundThrottlingPolicy,
  desktopExplorerFileSearch,
  desktopExplorerFileWindowLabel,
  desktopPopoutTitlebarLeftInset,
  desktopPopoutGroupSearch,
  desktopPopoutGroupWindowLabel,
  desktopPopoutPaneSearch,
  desktopPopoutPaneWindowLabel,
  discoverDesktopPopoutPaneIds,
  discoverDesktopPopoutPanes,
  desktopProjectOverviewSearch,
  desktopProjectOverviewWindowLabel,
  desktopStandaloneChatFileSearch,
  desktopStandaloneChatFileWindowLabel,
  desktopWindowThemeOverride,
  isMacosDesktopRuntime,
  observeDesktopPopoutClosure,
  observeDesktopWindowFocus,
  watchWorkspaceNativeWindow,
  openSyntheticBuildProgressWindow,
  openWorkspaceTransferWindow,
  reopenWorkspaceWindow,
  openDesktopStandaloneChatFile,
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  parseDesktopPopoutPaneTarget,
  parseDesktopProjectOverviewTarget,
  parseDesktopStandaloneChatFileTarget,
  restoreMainWindowAfterSyntheticBuild,
  shouldUseOverlayTitlebar,
  type DesktopExplorerFileTarget,
  type DesktopPopoutGroupTarget,
  type DesktopPopoutPaneTarget,
  type DesktopProjectOverviewTarget,
  type DesktopStandaloneChatFileTarget,
} from "./desktop-popout";

it("reopens the committed native identity without focusing or replacing a surviving window", async () => {
  tauri.isTauri.mockReturnValue(true);
  vi.stubGlobal("window", { location: { pathname: "/" } });
  try {
    const target = {
      projectId: "project",
      paneId: "pane",
      activeTabKey: "tab",
    };
    await reopenWorkspaceWindow("committed-window", target, () => true);
    const native = webviews.windows.get("committed-window")!;
    expect(native.options).toMatchObject({ visible: true, focus: false });
    expect(native.options?.url).not.toContain("cantrip-transfer");
    await reopenWorkspaceWindow("committed-window", target, () => true);
    expect(webviews.windows.get("committed-window")).toBe(native);
    expect(native.setFocus).not.toHaveBeenCalled();
    expect(native.show).not.toHaveBeenCalled();
  } finally {
    webviews.windows.clear();
    tauri.isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  }
});

it("does not create a recovery window after its scope expires", async () => {
  tauri.isTauri.mockReturnValue(true);
  try {
    await reopenWorkspaceWindow(
      "expired-window",
      {
        projectId: "project",
        paneId: "pane",
        activeTabKey: "tab",
      },
      () => false,
    );
    expect(webviews.windows.has("expired-window")).toBe(false);
  } finally {
    tauri.isTauri.mockReturnValue(false);
  }
});

describe("desktop pop-out groups", () => {
  const target: DesktopPopoutGroupTarget = {
    activeTabKey: "chat:chat/1",
    groupId: "group one",
    projectId: "project one",
  };

  it("round-trips the group and active member", () => {
    expect(
      parseDesktopPopoutGroupTarget(desktopPopoutGroupSearch(target)),
    ).toEqual(target);
  });

  it("rejects incomplete targets", () => {
    expect(
      parseDesktopPopoutGroupTarget(
        "?cantrip-popout-group=group&project=project",
      ),
    ).toBeNull();
    expect(
      parseDesktopPopoutGroupTarget(
        "?cantrip-popout-group=group&active=chat%3Achat",
      ),
    ).toBeNull();
    expect(parseDesktopPopoutGroupTarget("?cantrip-popout=chat")).toBeNull();
  });

  it("uses one stable Tauri window label per group", () => {
    expect(desktopPopoutGroupWindowLabel("abc-123")).toBe(
      "cantrip-group-abc-123",
    );
    expect(desktopPopoutGroupWindowLabel("group with spaces")).toBe(
      "cantrip-group-group_with_spaces",
    );
  });

  it("keeps live pop-out clients running while macOS considers them occluded", () => {
    expect(desktopBackgroundThrottlingPolicy).toBe("disabled");
  });

  it("lets workspace-owned chat windows receive frontend file drops", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", {
      location: { pathname: "/" },
    });

    try {
      await expect(
        openWorkspaceTransferWindow(
          {
            activeTabKey: target.activeTabKey,
            paneId: target.groupId,
            projectId: target.projectId,
            transfer: {
              id: "transfer",
              workspaceId: "workspace",
              windowId: "owned-chat",
              generation: 0,
            },
          },
          "Detached chat",
        ),
      ).resolves.toBe("created");

      expect(webviews.windows.get("owned-chat")?.options).toMatchObject({
        dragDropEnabled: false,
      });
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("resumes immediately when the detached window is already gone", async () => {
    const onClosed = vi.fn();

    const stop = await observeDesktopPopoutClosure(
      vi.fn().mockResolvedValue(null),
      onClosed,
    );

    expect(onClosed).toHaveBeenCalledOnce();
    expect(stop()).toBeUndefined();
  });

  it("observes the exact workspace window label independently of pane identity", async () => {
    tauri.isTauri.mockReturnValue(true);
    const owned = new webviews.MockWebviewWindow(
      "cantrip-pane-workspace-owned",
    );
    const other = new webviews.MockWebviewWindow(
      "cantrip-pane-workspace-other",
    );
    const closed = vi.fn();
    const stop = await watchWorkspaceNativeWindow(owned.label, closed);
    try {
      await other.close();
      expect(closed).not.toHaveBeenCalled();
      await owned.close();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      stop();
      webviews.windows.clear();
      tauri.isTauri.mockReturnValue(false);
    }
  });

  it("resumes when the detached window is destroyed", async () => {
    const onClosed = vi.fn();
    const unlisten = vi.fn();
    let destroyed: () => void = () => undefined;
    const popout = {
      listenDestroyed: vi.fn().mockImplementation((listener: () => void) => {
        destroyed = listener;
        return Promise.resolve(unlisten);
      }),
    };

    const stop = await observeDesktopPopoutClosure(
      vi.fn().mockResolvedValue(popout),
      onClosed,
    );
    destroyed();
    destroyed();
    stop();

    expect(popout.listenDestroyed).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("cancels observation and closes the setup race", async () => {
    const onClosed = vi.fn();
    const unlisten = vi.fn();
    const popout = {
      listenDestroyed: vi.fn().mockResolvedValue(unlisten),
    };
    const lookup = vi
      .fn<() => Promise<typeof popout | null>>()
      .mockResolvedValueOnce(popout)
      .mockResolvedValueOnce(popout);

    const stop = await observeDesktopPopoutClosure(lookup, onClosed);
    stop();

    expect(onClosed).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();

    lookup.mockReset();
    lookup.mockResolvedValueOnce(popout).mockResolvedValueOnce(null);
    await observeDesktopPopoutClosure(lookup, onClosed);

    expect(onClosed).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("desktop pop-out panes", () => {
  const target: DesktopPopoutPaneTarget = {
    activeTabKey: "terminal:terminal/1",
    paneId: "pane one",
    projectId: "project one",
  };

  it("round-trips transfer routing without treating URL metadata as workspace ownership", () => {
    const owned = {
      ...target,
      transfer: {
        id: "transfer one",
        workspaceId: "workspace:device",
        windowId: "reserved-window",
        generation: 0,
      },
    };
    const search = desktopPopoutPaneSearch(owned);
    expect(parseDesktopPopoutPaneTarget(search)).toEqual(owned);
    for (const field of [
      "cantrip-transfer",
      "workspace",
      "window",
      "generation",
    ]) {
      const parameters = new URLSearchParams(search);
      parameters.delete(field);
      expect(parseDesktopPopoutPaneTarget(`?${parameters}`)).toBeNull();
    }
    for (const generation of ["-1", "1.5", "NaN", "9007199254740992"]) {
      const parameters = new URLSearchParams(search);
      parameters.set("generation", generation);
      expect(parseDesktopPopoutPaneTarget(`?${parameters}`)).toBeNull();
    }
  });

  it("shows a new transfer window immediately without refocusing an existing transfer", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const owned = {
      ...target,
      transfer: {
        id: "transfer",
        workspaceId: "workspace",
        windowId: "reserved-window",
        generation: 0,
      },
    };
    try {
      await expect(
        openWorkspaceTransferWindow(owned, "Transfer"),
      ).resolves.toBe("created");
      const destination = webviews.windows.get("reserved-window")!;
      expect(destination.options).toMatchObject({
        focus: true,
        visible: true,
        dragDropEnabled: false,
      });
      expect(destination.options?.url).toBe(
        `/${desktopPopoutPaneSearch(owned)}`,
      );
      expect(
        webviews.windows.has(desktopPopoutPaneWindowLabel(target.paneId)),
      ).toBe(false);
      await expect(
        openWorkspaceTransferWindow(owned, "Transfer retry"),
      ).resolves.toBe("existing");
      expect(webviews.windows.get("reserved-window")).toBe(destination);
      expect(destination.show).not.toHaveBeenCalled();
      expect(destination.setFocus).not.toHaveBeenCalled();
      expect(destination.unminimize).not.toHaveBeenCalled();
      await expect(
        openWorkspaceTransferWindow(
          { ...owned, transfer: { ...owned.transfer, windowId: "main" } },
          "Invalid",
        ),
      ).rejects.toThrow(/Invalid workspace/);
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      webviews.windows.clear();
      tauri.isTauri.mockReturnValue(false);
      vi.unstubAllGlobals();
    }
  });

  it("writes the canonical pane route and reads canonical or legacy routes", () => {
    expect(desktopPopoutPaneSearch(target)).toContain(
      "cantrip-popout-pane=pane+one",
    );
    expect(
      parseDesktopPopoutPaneTarget(desktopPopoutPaneSearch(target)),
    ).toEqual(target);
    expect(
      parseDesktopPopoutPaneTarget(
        "?cantrip-popout-group=legacy-pane&active=chat%3A1&project=project-1",
      ),
    ).toEqual({
      activeTabKey: "chat:1",
      paneId: "legacy-pane",
      projectId: "project-1",
    });
  });

  it("uses a pane-scoped window label", () => {
    expect(desktopPopoutPaneWindowLabel("pane with spaces")).toBe(
      "cantrip-pane-pane_with_spaces",
    );
  });

  it("discovers multiple canonical and compatibility pane windows", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    new webviews.MockWebviewWindow(desktopPopoutPaneWindowLabel("pane-a"));
    new webviews.MockWebviewWindow(desktopPopoutGroupWindowLabel("pane-b"));
    try {
      expect(
        await discoverDesktopPopoutPaneIds(["pane-a", "pane-b", "pane-c"]),
      ).toEqual(new Set(["pane-a", "pane-b"]));
      expect(
        await discoverDesktopPopoutPanes(["pane-a", "pane-b", "pane-c"]),
      ).toEqual([
        { paneId: "pane-a", windowId: desktopPopoutPaneWindowLabel("pane-a") },
        { paneId: "pane-b", windowId: desktopPopoutGroupWindowLabel("pane-b") },
      ]);
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });
});

describe("synthetic build progress window", () => {
  it("hides the main window after opening and can restore it", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Macintosh" });
    const mainWindow = new webviews.MockWebviewWindow("main");

    try {
      await expect(openSyntheticBuildProgressWindow()).resolves.toBe("created");
      expect(mainWindow.hide).toHaveBeenCalledOnce();
      expect(
        webviews.windows.get("synthetic-build-progress")?.options,
      ).toMatchObject({ hiddenTitle: true, titleBarStyle: "overlay" });

      await restoreMainWindowAfterSyntheticBuild();

      expect(mainWindow.show).toHaveBeenCalledOnce();
      expect(mainWindow.unminimize).toHaveBeenCalledOnce();
      expect(mainWindow.setFocus).toHaveBeenCalledOnce();
    } finally {
      webviews.windows.clear();
      tauri.isTauri.mockReturnValue(false);
      vi.unstubAllGlobals();
    }
  });
});

describe("desktop project overview pop-outs", () => {
  const target: DesktopProjectOverviewTarget = {
    projectId: "project one",
    section: "history",
    worktreeId: "worktree one",
  };

  it("round-trips the locked overview section and worktree", () => {
    expect(
      parseDesktopProjectOverviewTarget(desktopProjectOverviewSearch(target)),
    ).toEqual(target);
  });

  it("rejects unknown overview sections", () => {
    expect(
      parseDesktopProjectOverviewTarget(
        "?cantrip-project-overview=unknown&project=project",
      ),
    ).toBeNull();
  });

  it("uses a stable label scoped to the overview view", () => {
    expect(desktopProjectOverviewWindowLabel(target)).toBe(
      desktopProjectOverviewWindowLabel({ ...target }),
    );
    expect(desktopProjectOverviewWindowLabel(target)).not.toBe(
      desktopProjectOverviewWindowLabel({ ...target, section: "graph" }),
    );
  });
});

describe("desktop window focus", () => {
  it("notifies only when the native window regains focus", async () => {
    const onFocused = vi.fn();
    const unlisten = vi.fn();
    let focusChanged: (focused: boolean) => void = () => undefined;
    const currentWindow = {
      listenFocusChanged: vi
        .fn()
        .mockImplementation((listener: (focused: boolean) => void) => {
          focusChanged = listener;
          return Promise.resolve(unlisten);
        }),
    };

    const stop = await observeDesktopWindowFocus(
      vi.fn().mockResolvedValue(currentWindow),
      onFocused,
    );
    focusChanged(false);
    focusChanged(true);
    stop();

    expect(onFocused).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("is a no-op when no native window is available", async () => {
    const onFocused = vi.fn();
    const stop = await observeDesktopWindowFocus(
      vi.fn().mockResolvedValue(null),
      onFocused,
    );

    expect(stop()).toBeUndefined();
    expect(onFocused).not.toHaveBeenCalled();
  });
});

describe("desktop Explorer file windows", () => {
  const target: DesktopExplorerFileTarget = {
    explorerId: "explorer/one",
    path: "src/components/file name.tsx",
    projectId: "project one",
  };

  it("round-trips the transient file target", () => {
    expect(
      parseDesktopExplorerFileTarget(desktopExplorerFileSearch(target)),
    ).toEqual({ ...target, launchId: null });
    expect(
      parseDesktopExplorerFileTarget(
        desktopExplorerFileSearch(target, "launch-one"),
      ),
    ).toEqual({ ...target, launchId: "launch-one" });
  });

  it("rejects incomplete file targets", () => {
    expect(
      parseDesktopExplorerFileTarget(
        "?cantrip-explorer-file=src%2Findex.ts&project=project",
      ),
    ).toBeNull();
    expect(
      parseDesktopExplorerFileTarget(
        "?cantrip-explorer-file=src%2Findex.ts&explorer=explorer",
      ),
    ).toBeNull();
  });

  it("uses one bounded stable label per Explorer binding", () => {
    const label = desktopExplorerFileWindowLabel(
      "explorer with spaces",
      "src/components/file.tsx",
    );

    expect(label).toMatch(/^cantrip-editor-explorer_with_spaces-[a-z0-9]+$/u);
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/other.tsx",
        "worktree-one",
        "worker-one",
      ),
    ).toBe(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-one",
      ),
    );
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/other.tsx",
      ),
    ).not.toBe(label);
    expect(
      desktopExplorerFileWindowLabel("x".repeat(1_000), "file.ts").length,
    ).toBeLessThan(100);
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-two",
        "worker-one",
      ),
    ).not.toBe(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-one",
      ),
    );
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-two",
      ),
    ).not.toBe(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-one",
      ),
    );
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-one",
        "server-a/account/revision-1",
      ),
    ).not.toBe(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
        "worktree-one",
        "worker-one",
        "server-b/account/revision-1",
      ),
    );
  });
});

describe("desktop standalone Chat file windows", () => {
  const target: DesktopStandaloneChatFileTarget = {
    chatId: "chat one",
    path: "reports/file name.md",
  };

  it("round-trips the Chat file target", () => {
    expect(
      parseDesktopStandaloneChatFileTarget(
        desktopStandaloneChatFileSearch(target),
      ),
    ).toEqual(target);
  });

  it("rejects incomplete Chat file targets", () => {
    expect(
      parseDesktopStandaloneChatFileTarget(
        "?cantrip-chat-file=reports%2Ffile.md",
      ),
    ).toBeNull();
    expect(
      parseDesktopStandaloneChatFileTarget("?cantrip-chat-id=chat-one"),
    ).toBeNull();
  });

  it("opens one stable native window per Chat file", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", { location: { pathname: "/" } });

    try {
      await expect(
        openDesktopStandaloneChatFile(target, "file name.md"),
      ).resolves.toBe("created");

      const label = desktopStandaloneChatFileWindowLabel(target);
      expect(label).toMatch(/^cantrip-chat-file-[a-z0-9]+$/u);
      expect(webviews.windows.get(label)?.options).toMatchObject({
        url: `/${desktopStandaloneChatFileSearch(target)}`,
      });
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });
});

describe("desktop title bar layout", () => {
  it("uses the overlay layout only for the macOS Tauri runtime", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

    expect(shouldUseOverlayTitlebar(true, mac)).toBe(true);
    expect(shouldUseOverlayTitlebar(false, mac)).toBe(false);
    expect(
      shouldUseOverlayTitlebar(true, "Mozilla/5.0 (Windows NT 10.0)"),
    ).toBe(false);
    expect(
      shouldUseOverlayTitlebar(true, "Mozilla/5.0 (X11; Linux x86_64)"),
    ).toBe(false);
  });

  it("does not expose macOS desktop-only behavior in the browser", () => {
    expect(isMacosDesktopRuntime()).toBe(false);
  });

  it("reserves the macOS traffic-light area only in overlay pop-outs", () => {
    expect(desktopPopoutTitlebarLeftInset(true, true)).toBe("5.5rem");
    expect(desktopPopoutTitlebarLeftInset(false, true)).toBeUndefined();
    expect(desktopPopoutTitlebarLeftInset(true, false)).toBeUndefined();
  });
});

describe("desktop window theme", () => {
  it("clears the native override when brightness follows the system", () => {
    expect(desktopWindowThemeOverride("system")).toBeNull();
    expect(desktopWindowThemeOverride("light")).toBe("light");
    expect(desktopWindowThemeOverride("dark")).toBe("dark");
  });
});
