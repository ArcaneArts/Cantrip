import type { TerminalHydrationMetadata } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  TerminalHydrationController,
  terminalHydrationRecoveryError,
} from "./terminal-hydration";

const canonical: TerminalHydrationMetadata = {
  activeBuffer: "alternate",
  cols: 120,
  cursor: { x: 5, y: 7 },
  format: "canonical-xterm",
  generation: 3,
  modes: {
    applicationCursorKeysMode: true,
    applicationKeypadMode: false,
    bracketedPasteMode: true,
    insertMode: false,
    mouseTrackingMode: "none",
    originMode: false,
    reverseWraparoundMode: false,
    sendFocusMode: false,
    synchronizedOutputMode: false,
    wraparoundMode: true,
  },
  outputBoundary: 42,
  processGeneration: 2,
  rows: 40,
  scrollbackRows: 0,
  snapshotCharacters: 50_000,
  snapshotChunks: 2,
  version: 1,
};

describe("TerminalHydrationController", () => {
  it("resets once for canonical hydration and opens after every chunk", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };

    controller.begin(canonical, target);
    expect(target.reset).toHaveBeenCalledOnce();
    controller.consumedOutput();
    expect(() => controller.assertReady()).toThrow("snapshot was incomplete");
    controller.consumedOutput();
    expect(controller.assertReady()).toEqual(canonical);
  });

  it("keeps legacy replay compatible without clearing the client", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };
    controller.begin(
      {
        cols: 80,
        format: "legacy-raw",
        generation: 0,
        outputBoundary: 12,
        processGeneration: 1,
        recovery: "redraw-requested",
        rows: 24,
        snapshotCharacters: 100,
        snapshotChunks: 1,
        truncated: true,
        version: 1,
      },
      target,
    );
    controller.consumedOutput();

    expect(target.reset).not.toHaveBeenCalled();
    expect(() => controller.assertReady()).not.toThrow();
  });

  it("rejects overlapping snapshots", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };
    controller.begin(canonical, target);

    expect(() => controller.begin(canonical, target)).toThrow(
      "hydration frames overlapped",
    );
  });

  it("rejects a stale boundary within the same process generation", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };
    controller.begin({ ...canonical, snapshotChunks: 1 }, target);
    controller.consumedOutput();
    controller.assertReady();

    expect(() =>
      controller.begin({ ...canonical, outputBoundary: 41 }, target),
    ).toThrow("stale terminal snapshot");
  });

  it("accepts a lower boundary from a newer process generation", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };
    controller.begin({ ...canonical, snapshotChunks: 1 }, target);
    controller.consumedOutput();
    controller.assertReady();

    expect(() =>
      controller.begin(
        {
          ...canonical,
          outputBoundary: 1,
          processGeneration: 3,
        },
        target,
      ),
    ).not.toThrow();
  });

  it("warns only when canonical and automatic redraw recovery both fail", () => {
    const legacy = {
      cols: 80,
      format: "legacy-raw" as const,
      generation: 1,
      outputBoundary: 44,
      processGeneration: 2,
      rows: 24,
      snapshotCharacters: 2_000_000,
      snapshotChunks: 62,
      truncated: true,
      version: 1 as const,
    };

    expect(
      terminalHydrationRecoveryError({
        ...legacy,
        recovery: "redraw-failed",
        recoveryReason: "resize-failed",
      }),
    ).toContain("automatic redraw could not be started");
    expect(
      terminalHydrationRecoveryError({
        ...legacy,
        recovery: "redraw-requested",
      }),
    ).toBeNull();
    expect(terminalHydrationRecoveryError(canonical)).toBeNull();
  });
});
