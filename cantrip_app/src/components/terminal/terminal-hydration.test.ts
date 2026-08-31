import type { TerminalHydrationMetadata } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { TerminalHydrationController } from "./terminal-hydration";

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
    expect(() => controller.assertReady()).not.toThrow();
  });

  it("keeps legacy replay compatible without clearing the client", () => {
    const controller = new TerminalHydrationController();
    const target = { reset: vi.fn() };
    controller.begin(
      {
        cols: 80,
        format: "legacy-raw",
        generation: 0,
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
});
