import { describe, expect, it } from "vitest";

import {
  desktopExplorerWindowChannelName,
  desktopExplorerWindowModes,
  isDesktopExplorerWindowRequest,
  isDesktopExplorerWindowResponse,
} from "./desktop-explorer-window-protocol";

describe("desktop Explorer window protocol", () => {
  it("isolates every launch on its own same-origin channel", () => {
    expect(desktopExplorerWindowChannelName("launch-one")).toBe(
      "cantrip.explorer-window.v1.launch-one",
    );
  });

  it("keeps read-only and editor modes available around optional visuals", () => {
    expect(desktopExplorerWindowModes("src/index.ts")).toEqual([
      "preview",
      "edit",
    ]);
    expect(desktopExplorerWindowModes("config/settings.yaml")).toEqual([
      "preview",
      "visual",
      "edit",
    ]);
  });

  it("accepts only complete child requests", () => {
    expect(
      isDesktopExplorerWindowRequest({
        launchId: "launch-one",
        type: "launch.request",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowRequest({
        launchId: "launch-one",
        requestId: "request-one",
        type: "file.read",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowRequest({
        content: "next",
        launchId: "launch-one",
        requestId: "request-one",
        type: "file.save",
        version: "version-one",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowRequest({
        launchId: "launch-one",
        type: "file.save",
      }),
    ).toBe(false);
  });

  it("rejects unrelated window messages", () => {
    expect(isDesktopExplorerWindowResponse(null)).toBe(false);
    expect(
      isDesktopExplorerWindowResponse({
        launchId: "launch-one",
        type: "something.else",
      }),
    ).toBe(false);
    expect(
      isDesktopExplorerWindowResponse({
        context: {
          explorer: {},
          path: "src/index.ts",
          requestedAtMs: 1,
        },
        launchId: "launch-one",
        type: "launch.ready",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowResponse({
        context: {},
        launchId: "launch-one",
        type: "launch.ready",
      }),
    ).toBe(false);
  });
});
