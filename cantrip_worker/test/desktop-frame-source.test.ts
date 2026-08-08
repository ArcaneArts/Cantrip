import { describe, expect, it } from "vitest";

import {
  AdaptiveDesktopStreamTuner,
  desktopApplicationAvailable,
  resolveDesktopTarget,
} from "../src/desktop/desktop-frame-source.js";

const targets = {
  monitors: [
    {
      kind: "monitor" as const,
      id: "display-1",
      name: "Studio Display",
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
      primary: true,
    },
    {
      kind: "monitor" as const,
      id: "display-2",
      name: "Side Display",
      x: 2560,
      y: 0,
      width: 1920,
      height: 1080,
      primary: false,
    },
  ],
  windows: [
    {
      kind: "window" as const,
      id: "window-1",
      application: "Code",
      title: "Cantrip",
      x: 120,
      y: 80,
      width: 1400,
      height: 900,
      minimized: false,
      focused: true,
    },
  ],
};

describe("AdaptiveDesktopStreamTuner", () => {
  it("reduces encoded bitrate before sacrificing responsiveness", () => {
    const tuner = new AdaptiveDesktopStreamTuner({
      targetFps: 30,
      quality: "adaptive",
    });
    const initial = tuner.encoding(1_920, 1_920);
    for (let index = 0; index < 6; index += 1) {
      tuner.recordFrame(500_000, true);
    }
    expect(tuner.quality).toBeLessThan(initial.quality);
    expect(tuner.encoding(1_920, 1_920).width).toBe(1_920);

    for (let index = 0; index < 10; index += 1) {
      tuner.recordFrame(500_000, false);
    }
    expect(tuner.encoding(1_920, 1_920).width).toBeLessThan(1_920);
  });

  it("uses render feedback to react to a slow client", () => {
    const tuner = new AdaptiveDesktopStreamTuner({
      targetFps: 60,
      quality: "sharp",
    });
    const initialQuality = tuner.quality;
    tuner.recordFeedback({
      intervalMs: 2_000,
      receivedFrames: 30,
      renderedFrames: 20,
      droppedFrames: 10,
      averageDecodeMs: 35,
    });
    expect(tuner.quality).toBeLessThan(initialQuality);
  });
});

describe("desktop capture target resolution", () => {
  it("restores monitors by stable name when their native id changes", () => {
    expect(
      resolveDesktopTarget(
        { kind: "monitor", id: "missing", name: "Side Display" },
        targets,
      ),
    ).toMatchObject({ kind: "monitor", id: "display-2" });
  });

  it("restores windows by application and title when ids are ephemeral", () => {
    expect(
      resolveDesktopTarget(
        {
          kind: "window",
          id: "missing",
          application: "Code",
          title: "Cantrip",
        },
        targets,
      ),
    ).toMatchObject({ kind: "window", id: "window-1" });
    expect(desktopApplicationAvailable("code", targets)).toBe(true);
  });

  it("falls back to the primary display when a saved window is absent", () => {
    expect(
      resolveDesktopTarget(
        {
          kind: "window",
          id: "missing",
          application: "Ghost App",
          title: "Missing",
        },
        targets,
      ),
    ).toMatchObject({ kind: "monitor", id: "display-1", primary: true });
  });
});
