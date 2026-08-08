import { describe, expect, it } from "vitest";

import { AdaptiveDesktopStreamTuner } from "../src/desktop/desktop-frame-source.js";

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
