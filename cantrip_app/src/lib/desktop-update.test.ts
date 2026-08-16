import { describe, expect, it } from "vitest";

import {
  desktopUpdateActiveWorkLabels,
  desktopUpdateActiveWorkTotal,
  formatDesktopUpdateBytes,
  normalizeDesktopUpdateError,
} from "./desktop-update";

describe("desktop update helpers", () => {
  it("normalizes structured native errors without losing guidance", () => {
    expect(
      normalizeDesktopUpdateError({
        code: "update_install_failed",
        message: "Close the installer and try again.",
        retryable: true,
      }),
    ).toEqual({
      code: "update_install_failed",
      message: "Close the installer and try again.",
      retryable: true,
    });
  });

  it("summarizes active work with singular and plural labels", () => {
    const summary = {
      activeChats: 1,
      queuedPrompts: 2,
      terminalServices: 0,
      backgroundJobs: 3,
    };
    expect(desktopUpdateActiveWorkTotal(summary)).toBe(6);
    expect(desktopUpdateActiveWorkLabels(summary)).toEqual([
      "1 active chat",
      "2 queued prompts",
      "3 background jobs",
    ]);
  });

  it("formats updater byte counts compactly", () => {
    expect(formatDesktopUpdateBytes(0)).toBe("0 B");
    expect(formatDesktopUpdateBytes(1024)).toBe("1.0 KB");
    expect(formatDesktopUpdateBytes(12 * 1024 * 1024)).toBe("12 MB");
  });
});
