import { describe, expect, it } from "vitest";

import {
  desktopPopoutSearch,
  parseDesktopPopoutTarget,
  shouldUseOverlayTitlebar,
  type DesktopPopoutTarget,
} from "./desktop-popout";

describe("desktop pop-out targets", () => {
  const targets: DesktopPopoutTarget[] = [
    { kind: "chat", projectId: "project one", tabId: "chat/1" },
    { kind: "terminal", projectId: "project one", tabId: "terminal:1" },
    { kind: "explorer", projectId: "project one", tabId: "explorer_1" },
    { kind: "browser", projectId: "project one", tabId: "browser-1" },
    { kind: "code", projectId: "project one", tabId: "code-1" },
    { kind: "view", projectId: "project one", tabId: "history-1" },
    { kind: "view", projectId: "project one", tabId: "issues-1" },
  ];

  it.each(targets)("round-trips $kind targets", (target) => {
    expect(parseDesktopPopoutTarget(desktopPopoutSearch(target))).toEqual(
      target,
    );
  });

  it("rejects incomplete and unsupported targets", () => {
    expect(
      parseDesktopPopoutTarget("?cantrip-popout=chat&project=p"),
    ).toBeNull();
    expect(
      parseDesktopPopoutTarget("?cantrip-popout=git&project=p&view=branches"),
    ).toBeNull();
    expect(
      parseDesktopPopoutTarget("?cantrip-popout=settings&project=p&tab=s"),
    ).toBeNull();
    expect(parseDesktopPopoutTarget("?cantrip-popout=chat&tab=c")).toBeNull();
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
});
