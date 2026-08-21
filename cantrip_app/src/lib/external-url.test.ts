import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openExternalUrl } from "./external-url";

const externalMocks = vi.hoisted(() => ({
  openNative: vi.fn(),
  openTauri: vi.fn(),
}));

vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: externalMocks.openNative },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: externalMocks.openTauri,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  externalMocks.openNative.mockReset();
  externalMocks.openTauri.mockReset();
});

describe("openExternalUrl", () => {
  it("opens a new tab when running on the web", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal("window", { open });

    await openExternalUrl("https://example.com/docs");

    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("uses the device URL launcher on native mobile clients", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    externalMocks.openNative.mockResolvedValue({ completed: true });

    await openExternalUrl("https://example.com/mobile");

    expect(externalMocks.openNative).toHaveBeenCalledWith({
      url: "https://example.com/mobile",
    });
  });

  it("uses the Tauri opener on desktop clients", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, open: vi.fn() });
    externalMocks.openTauri.mockResolvedValue(undefined);

    await openExternalUrl("https://example.com/desktop");

    expect(externalMocks.openTauri).toHaveBeenCalledWith(
      "https://example.com/desktop",
    );
  });

  it("rejects non-web protocols", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    await expect(openExternalUrl("file:///tmp/example")).rejects.toThrow(
      "Only HTTP and HTTPS links can be opened externally.",
    );
    expect(open).not.toHaveBeenCalled();
  });
});
