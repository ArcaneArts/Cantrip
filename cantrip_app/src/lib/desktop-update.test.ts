import { describe, expect, it } from "vitest";

import {
  desktopUpdateActiveWorkLabels,
  desktopUpdateActiveWorkTotal,
  formatDesktopUpdateBytes,
  groupDesktopUpdateHistory,
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

  it("groups version history into stable calendar sections", () => {
    const releases = (
      [
        ["1.0.6", "2026-08-22T08:00:00.000Z"],
        ["1.0.5", "2026-08-21T08:00:00.000Z"],
        ["1.0.4", "2026-08-19T08:00:00.000Z"],
        ["1.0.3", "2026-08-12T08:00:00.000Z"],
        ["1.0.2", "2026-08-01T08:00:00.000Z"],
        ["1.0.1", "2026-06-01T08:00:00.000Z"],
      ] as const
    ).map(([version, publishedAt]) => ({
      currentVersion: "1.0.4",
      version,
      publishedAt,
      releaseNotes: null,
    }));

    expect(
      groupDesktopUpdateHistory(
        releases,
        new Date("2026-08-22T12:00:00.000Z"),
      ).map((group) => [
        group.label,
        group.releases.map((release) => release.version),
      ]),
    ).toEqual([
      ["Today", ["1.0.6"]],
      ["Yesterday", ["1.0.5"]],
      ["Earlier This Week", ["1.0.4"]],
      ["Last Week", ["1.0.3"]],
      ["Last Month", ["1.0.2"]],
      ["Older", ["1.0.1"]],
    ]);
  });
});
