import type { ExplorerSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
const brokerModule = vi.hoisted(() => ({
  createDesktopExplorerWindowBroker: vi.fn(),
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
    readonly setFocus = vi.fn(async () => undefined);
    readonly show = vi.fn(async () => undefined);
    readonly unminimize = vi.fn(async () => undefined);

    constructor(readonly label: string) {
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
vi.mock("@/lib/desktop-explorer-window-broker", () => brokerModule);

import {
  clearDesktopExplorerFilePrewarm,
  desktopBackgroundThrottlingPolicy,
  desktopExplorerFileSearch,
  desktopExplorerFileWindowLabel,
  desktopPopoutTitlebarLeftInset,
  desktopPopoutGroupSearch,
  desktopPopoutGroupWindowLabel,
  desktopWindowThemeOverride,
  isMacosDesktopRuntime,
  observeDesktopPopoutClosure,
  observeDesktopWindowFocus,
  openDesktopExplorerFile,
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  prewarmDesktopExplorerFile,
  shouldUseOverlayTitlebar,
  type DesktopExplorerFileTarget,
  type DesktopPopoutGroupTarget,
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

  it("uses one bounded stable label per Explorer path", () => {
    const label = desktopExplorerFileWindowLabel(
      "explorer with spaces",
      "src/components/file.tsx",
    );

    expect(label).toMatch(/^cantrip-editor-explorer_with_spaces-[a-z0-9]+$/u);
    expect(
      desktopExplorerFileWindowLabel(
        "explorer with spaces",
        "src/components/file.tsx",
      ),
    ).toBe(label);
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
  });

  it("reasserts the requested file before focusing an existing bound editor", async () => {
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

    try {
      await expect(
        openDesktopExplorerFile(boundTarget, "bound.ts", boundContext),
      ).resolves.toBe("created");
      await expect(
        openDesktopExplorerFile(boundTarget, "bound.ts", boundContext),
      ).resolves.toBe("focused");

      expect(broker.openFile).toHaveBeenCalledOnce();
      expect(broker.openFile).toHaveBeenCalledWith(boundTarget.path);
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
