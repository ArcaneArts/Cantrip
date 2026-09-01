import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/desktop-popout", () => ({
  desktopPopoutTitlebarLeftInset: () => "5.5rem",
  hideMainWindowForSyntheticBuild: vi.fn(async () => undefined),
  isMacosDesktopRuntime: () => true,
  restoreMainWindowAfterSyntheticBuild: vi.fn(async () => undefined),
}));

import {
  SyntheticBuildProgressWindow,
  syntheticBuildMainWindowDisposition,
} from "./synthetic-build-progress-window";

describe("SyntheticBuildProgressWindow", () => {
  it("clears the macOS traffic lights and makes the header draggable", () => {
    const markup = renderToStaticMarkup(<SyntheticBuildProgressWindow />);

    expect(markup).toContain('style="padding-left:5.5rem"');
    expect(markup).toContain('data-tauri-drag-region=""');
    expect(markup).toContain("Synthetic Cantrip build");
  });

  it("restores the main window for failures and closes after cancellation", () => {
    expect(syntheticBuildMainWindowDisposition("running", null)).toBe(
      "keep-hidden",
    );
    expect(syntheticBuildMainWindowDisposition("ready-to-install", null)).toBe(
      "keep-hidden",
    );
    expect(syntheticBuildMainWindowDisposition("failed", null)).toBe("restore");
    expect(syntheticBuildMainWindowDisposition("running", "Disconnected")).toBe(
      "restore",
    );
    expect(syntheticBuildMainWindowDisposition("cancelled", null)).toBe(
      "restore-and-close",
    );
  });
});
