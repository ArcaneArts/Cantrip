import type { ExplorerSummary } from "@cantrip/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
const brokerModule = vi.hoisted(() => ({
  createDesktopExplorerWindowBroker: vi.fn(),
}));
const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  getWorkers: vi.fn(async () => []),
}));
const surfaceReadiness = vi.hoisted(() => ({
  waitForSurfacePrivateStateWorkerEncryption: vi.fn(
    async (): Promise<void> => undefined,
  ),
}));
const identityRuntime = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let session = {
    serverId: "11111111-1111-4111-8111-111111111111",
    user: { id: "account-one" },
  };
  let snapshot = {
    clientId: "client-one",
    identity: { ownerId: session.user.id, serverId: session.serverId },
    masterKeyRevision: 1,
    status: "ready" as const,
  };
  return {
    getSession: () => session,
    getSnapshot: () => snapshot,
    reset() {
      session = {
        serverId: "11111111-1111-4111-8111-111111111111",
        user: { id: "account-one" },
      };
      snapshot = {
        clientId: "client-one",
        identity: { ownerId: session.user.id, serverId: session.serverId },
        masterKeyRevision: 1,
        status: "ready",
      };
      for (const listener of listeners) listener();
    },
    setIdentity(serverId: string, ownerId: string, revision = 1) {
      session = { serverId, user: { id: ownerId } };
      snapshot = {
        clientId: `client-${serverId}`,
        identity: { ownerId, serverId },
        masterKeyRevision: revision,
        status: "ready",
      };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const webviews = vi.hoisted(() => {
  const windows = new Map<string, MockWebviewWindow>();
  class MockWebviewWindow {
    readonly close = vi.fn(async () => {
      windows.delete(this.label);
      this.destroyed?.();
    });
    private destroyed: (() => void) | undefined;
    readonly hide = vi.fn(async () => undefined);
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
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    getSnapshot: identityRuntime.getSnapshot,
    subscribe: identityRuntime.subscribe,
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSession: identityRuntime.getSession,
}));
vi.mock("@/lib/client-log-relay", () => ({ clientLogger: logs }));
vi.mock("@/lib/desktop-explorer-window-broker", () => brokerModule);
vi.mock(
  "@/lib/surface-private-state-worker-encryption",
  () => surfaceReadiness,
);

import {
  clearDesktopExplorerFilePrewarm,
  desktopBackgroundThrottlingPolicy,
  desktopExplorerFileSearch,
  desktopExplorerFileWindowLabel,
  desktopPopoutTitlebarLeftInset,
  desktopPopoutGroupSearch,
  desktopPopoutGroupWindowLabel,
  desktopPopoutPaneSearch,
  desktopPopoutPaneWindowLabel,
  discoverDesktopPopoutPaneIds,
  desktopProjectOverviewSearch,
  desktopProjectOverviewWindowLabel,
  desktopStandaloneChatFileSearch,
  desktopStandaloneChatFileWindowLabel,
  desktopWindowThemeOverride,
  isMacosDesktopRuntime,
  observeDesktopPopoutClosure,
  observeDesktopWindowFocus,
  openSyntheticBuildProgressWindow,
  openDesktopPopoutGroup,
  openDesktopPopoutPane,
  openDesktopExplorerFile,
  openDesktopStandaloneChatFile,
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  parseDesktopPopoutPaneTarget,
  parseDesktopProjectOverviewTarget,
  parseDesktopStandaloneChatFileTarget,
  prewarmDesktopExplorerFile,
  restoreMainWindowAfterSyntheticBuild,
  shouldUseOverlayTitlebar,
  type DesktopExplorerFileTarget,
  type DesktopPopoutGroupTarget,
  type DesktopPopoutPaneTarget,
  type DesktopProjectOverviewTarget,
  type DesktopStandaloneChatFileTarget,
} from "./desktop-popout";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

beforeEach(() => {
  identityRuntime.reset();
  api.getWorkers.mockClear();
  surfaceReadiness.waitForSurfacePrivateStateWorkerEncryption.mockReset();
  surfaceReadiness.waitForSurfacePrivateStateWorkerEncryption.mockResolvedValue(
    undefined,
  );
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

  it("lets detached chat groups receive frontend file drops", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", {
      location: { pathname: "/" },
    });

    try {
      await expect(
        openDesktopPopoutGroup(target, "Detached chat"),
      ).resolves.toBe("created");

      expect(
        webviews.windows.get(desktopPopoutGroupWindowLabel(target.groupId))
          ?.options,
      ).toMatchObject({ dragDropEnabled: false });
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

  it("opens the canonical pane window", async () => {
    tauri.isTauri.mockReturnValue(true);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    try {
      await expect(
        openDesktopPopoutPane(target, "Detached pane"),
      ).resolves.toBe("created");
      expect(
        webviews.windows.get(desktopPopoutPaneWindowLabel(target.paneId))
          ?.options,
      ).toMatchObject({ dragDropEnabled: false });
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
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

  it("switches a bound editor to another file before focusing the same window", async () => {
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    const broker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "bound-editor",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker.mockReturnValue(broker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const boundTarget = {
      explorerId: "explorer-bound",
      path: "src/bound.ts",
      projectId: "project-one",
    };
    const boundContext = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "worker-one",
        id: boundTarget.explorerId,
        projectId: boundTarget.projectId,
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    };
    const nextTarget = { ...boundTarget, path: "src/next.ts" };

    try {
      await expect(
        openDesktopExplorerFile(boundTarget, "bound.ts", boundContext),
      ).resolves.toBe("created");
      await expect(
        openDesktopExplorerFile(nextTarget, "next.ts", boundContext),
      ).resolves.toBe("focused");

      expect(broker.openFile).toHaveBeenCalledOnce();
      expect(broker.openFile).toHaveBeenCalledWith(nextTarget.path);
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledOnce();
    } finally {
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
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

describe("desktop Explorer editor prewarm", () => {
  it("does not replenish a hidden warm slot while the opened editor remains reusable", async () => {
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    const openedBroker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "opened-from-warm-slot",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    const automaticWarmBroker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "unexpected-automatic-warm-slot",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker
      .mockReturnValueOnce(openedBroker)
      .mockReturnValueOnce(automaticWarmBroker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const context = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-one",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    };
    const target = {
      explorerId: context.explorer.id,
      path: "src/opened.ts",
      projectId: context.explorer.projectId,
    };

    try {
      await prewarmDesktopExplorerFile(context);
      await expect(
        openDesktopExplorerFile(target, "opened.ts", context),
      ).resolves.toBe("created");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(openedBroker.openFile).toHaveBeenCalledOnce();
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledOnce();
      expect(webviews.windows.size).toBe(1);
      expect(automaticWarmBroker.dispose).not.toHaveBeenCalled();
    } finally {
      clearDesktopExplorerFilePrewarm();
      for (const window of [...webviews.windows.values()]) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("waits for current surface encryption readiness before creating a protected editor broker", async () => {
    const readiness = deferred();
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    surfaceReadiness.waitForSurfacePrivateStateWorkerEncryption.mockReturnValue(
      readiness.promise,
    );
    const broker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "warm-after-readiness",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker.mockReturnValue(broker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const context = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "worker-readiness",
        id: "explorer-readiness",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    };

    try {
      const prewarm = prewarmDesktopExplorerFile(context);
      await vi.waitFor(() =>
        expect(
          surfaceReadiness.waitForSurfacePrivateStateWorkerEncryption,
        ).toHaveBeenCalledOnce(),
      );
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).not.toHaveBeenCalled();

      readiness.resolve();
      await prewarm;
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledOnce();
    } finally {
      clearDesktopExplorerFilePrewarm();
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("disposes a server A warm slot before same-ID server B opens a fresh editor", async () => {
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    const serverABroker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "warm-server-a",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    const serverBBroker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "fresh-server-b",
      openFile: vi.fn(async () => undefined),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker
      .mockReturnValueOnce(serverABroker)
      .mockReturnValueOnce(serverBBroker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const context = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "same-worker",
        id: "same-explorer",
        projectId: "same-project",
        worktreeId: "same-worktree",
      } as ExplorerSummary,
    };
    const target = {
      explorerId: context.explorer.id,
      path: "src/server-b.ts",
      projectId: context.explorer.projectId,
    };

    try {
      identityRuntime.setIdentity(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "same-account",
      );
      await prewarmDesktopExplorerFile(context);
      expect(webviews.windows.size).toBe(1);
      const serverALabel = [...webviews.windows.keys()][0];

      identityRuntime.setIdentity(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "same-account",
      );
      await vi.waitFor(() =>
        expect(serverABroker.dispose).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() => expect(webviews.windows.size).toBe(0));

      await expect(
        openDesktopExplorerFile(target, "server-b.ts", context),
      ).resolves.toBe("created");
      await expect(serverBBroker.ready).resolves.toBeUndefined();

      expect(serverABroker.openFile).not.toHaveBeenCalled();
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledTimes(2);
      expect(
        brokerModule.createDesktopExplorerWindowBroker.mock.calls[1]?.[0],
      ).toMatchObject({ path: target.path });
      expect(webviews.windows.size).toBe(1);
      expect([...webviews.windows.keys()][0]).not.toBe(serverALabel);

      identityRuntime.setIdentity(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "same-account",
        2,
      );
      await vi.waitFor(() =>
        expect(serverBBroker.dispose).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() => expect(webviews.windows.size).toBe(0));
    } finally {
      clearDesktopExplorerFilePrewarm();
      for (const window of [...webviews.windows.values()]) await window.close();
      await vi.waitFor(() =>
        expect(serverBBroker.dispose).toHaveBeenCalledOnce(),
      );
      expect(webviews.windows.size).toBe(0);
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("coalesces concurrent opens of the same prewarmed target", async () => {
    const opened = deferred();
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    const broker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "warm-coalesced",
      openFile: vi.fn(() => opened.promise),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker.mockReturnValue(broker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const warmContext = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-coalesced",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    };
    const warmTarget = {
      explorerId: warmContext.explorer.id,
      path: "src/coalesced.ts",
      projectId: warmContext.explorer.projectId,
    };

    try {
      await prewarmDesktopExplorerFile(warmContext);
      const first = openDesktopExplorerFile(
        warmTarget,
        "coalesced.ts",
        warmContext,
      );
      await vi.waitFor(() => expect(broker.openFile).toHaveBeenCalledOnce());
      const second = openDesktopExplorerFile(
        warmTarget,
        "coalesced.ts",
        warmContext,
      );
      clearDesktopExplorerFilePrewarm();

      expect(second).toBe(first);
      opened.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([
        "created",
        "created",
      ]);
      expect(broker.openFile).toHaveBeenCalledOnce();
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledOnce();
    } finally {
      clearDesktopExplorerFilePrewarm();
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("serializes different-file clicks and leaves the shared editor on the latest path", async () => {
    const firstOpened = deferred();
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    const broker = {
      dispose: vi.fn(async () => undefined),
      failed: false,
      launchId: "warm-switching",
      openFile: vi
        .fn<(path: string) => Promise<void>>()
        .mockReturnValueOnce(firstOpened.promise)
        .mockResolvedValueOnce(undefined),
      ready: Promise.resolve(),
    };
    brokerModule.createDesktopExplorerWindowBroker.mockReturnValue(broker);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const context = {
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-switching",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    };
    const firstTarget = {
      explorerId: context.explorer.id,
      path: "src/a.ts",
      projectId: context.explorer.projectId,
    };
    const secondTarget = { ...firstTarget, path: "src/b.ts" };

    try {
      await prewarmDesktopExplorerFile(context);
      const first = openDesktopExplorerFile(firstTarget, "a.ts", context);
      await vi.waitFor(() => expect(broker.openFile).toHaveBeenCalledOnce());
      const second = openDesktopExplorerFile(secondTarget, "b.ts", context);
      clearDesktopExplorerFilePrewarm();

      expect(second).not.toBe(first);
      expect(broker.openFile).toHaveBeenCalledTimes(1);
      firstOpened.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([
        "created",
        "focused",
      ]);
      expect(broker.openFile.mock.calls.map(([path]) => path)).toEqual([
        "src/a.ts",
        "src/b.ts",
      ]);
      expect(
        brokerModule.createDesktopExplorerWindowBroker,
      ).toHaveBeenCalledOnce();
    } finally {
      clearDesktopExplorerFilePrewarm();
      for (const window of webviews.windows.values()) await window.close();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });

  it("aborts and retires a delayed warm broker before its replacement mounts", async () => {
    const firstReady = deferred();
    const secondReady = deferred();
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    tauri.isTauri.mockReturnValue(true);
    brokerModule.createDesktopExplorerWindowBroker.mockReset();
    brokerModule.createDesktopExplorerWindowBroker
      .mockReturnValueOnce({
        dispose: firstDispose,
        failed: false,
        launchId: "warm-first",
        openFile: vi.fn(),
        ready: firstReady.promise,
      })
      .mockReturnValueOnce({
        dispose: secondDispose,
        failed: false,
        launchId: "warm-second",
        openFile: vi.fn(),
        ready: secondReady.promise,
      });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/" },
    });
    const context = (id: string, workerId = "worker-one") => ({
      appearance: "dark" as const,
      explorer: {
        activeWorkerId: workerId,
        id,
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
    });

    try {
      const firstPrewarm = prewarmDesktopExplorerFile(
        context("explorer-one", "worker-one"),
      );
      await vi.waitFor(() =>
        expect(
          brokerModule.createDesktopExplorerWindowBroker,
        ).toHaveBeenCalledTimes(1),
      );
      const firstSignal = brokerModule.createDesktopExplorerWindowBroker.mock
        .calls[0]?.[1]?.signal as AbortSignal;

      const secondPrewarm = prewarmDesktopExplorerFile(
        context("explorer-one", "worker-two"),
      );
      await vi.waitFor(() =>
        expect(
          brokerModule.createDesktopExplorerWindowBroker,
        ).toHaveBeenCalledTimes(2),
      );
      const secondSignal = brokerModule.createDesktopExplorerWindowBroker.mock
        .calls[1]?.[1]?.signal as AbortSignal;

      expect(firstSignal.aborted).toBe(true);
      expect(secondSignal.aborted).toBe(false);
      firstReady.resolve();
      secondReady.resolve();
      await Promise.all([firstPrewarm, secondPrewarm]);
      await vi.waitFor(() => expect(firstDispose).toHaveBeenCalled());

      clearDesktopExplorerFilePrewarm();
      expect(secondSignal.aborted).toBe(true);
      await vi.waitFor(() => expect(secondDispose).toHaveBeenCalled());
    } finally {
      clearDesktopExplorerFilePrewarm();
      tauri.isTauri.mockReturnValue(false);
      webviews.windows.clear();
      vi.unstubAllGlobals();
    }
  });
});
