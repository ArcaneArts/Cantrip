import { describe, expect, it } from "vitest";

import {
  desktopExplorerWindowChannelName,
  desktopExplorerWindowInitialMode,
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

  it("offers only modes supported by the shared Explorer file classifier", () => {
    expect(desktopExplorerWindowModes("src/index.ts")).toEqual([
      "preview",
      "edit",
    ]);
    expect(desktopExplorerWindowModes("config/settings.yaml")).toEqual([
      "preview",
      "visual",
      "edit",
    ]);
    expect(desktopExplorerWindowModes("README.md")).toEqual([
      "preview",
      "edit",
    ]);
    expect(desktopExplorerWindowModes("assets/photo.png")).toEqual(["preview"]);
  });

  it("opens files in the same default mode as the embedded Explorer", () => {
    expect(desktopExplorerWindowInitialMode("src/index.ts")).toBe("edit");
    expect(desktopExplorerWindowInitialMode("README.md")).toBe("preview");
    expect(desktopExplorerWindowInitialMode("assets/photo.png")).toBe(
      "preview",
    );
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
        nonce: "mount_nonce_1234567890",
        type: "editor.workbench-ready",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowRequest({
        launchId: "launch-one",
        type: "editor.workbench-ready",
      }),
    ).toBe(false);
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
        configuredAtMs: 123,
        launchId: "launch-one",
        nonce: "mount_nonce_1234567890",
        path: "src/index.ts",
        requestedAtMs: 1,
        type: "editor.ready",
      }),
    ).toBe(true);
    expect(
      isDesktopExplorerWindowResponse({
        launchId: "launch-one",
        type: "editor.ready",
      }),
    ).toBe(false);
    expect(
      isDesktopExplorerWindowResponse({
        context: {},
        launchId: "launch-one",
        type: "launch.ready",
      }),
    ).toBe(false);
  });
});
