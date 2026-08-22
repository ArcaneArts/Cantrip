import { describe, expect, it, vi } from "vitest";

import {
  desktopBackgroundThrottlingPolicy,
  desktopExplorerFileSearch,
  desktopExplorerFileWindowLabel,
  desktopPopoutTitlebarLeftInset,
  desktopPopoutGroupSearch,
  desktopPopoutGroupWindowLabel,
  isMacosDesktopRuntime,
  observeDesktopPopoutClosure,
  observeDesktopWindowFocus,
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  shouldUseOverlayTitlebar,
  type DesktopExplorerFileTarget,
  type DesktopPopoutGroupTarget,
} from "./desktop-popout";

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
    ).toEqual(target);
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
