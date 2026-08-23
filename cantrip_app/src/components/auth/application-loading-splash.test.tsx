import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_SPLASH_GLITCH_CONFIG,
  APPLICATION_SPLASH_GLITCH_INTERVAL_MS,
  ApplicationLoadingSplash,
} from "./application-loading-splash";

describe("ApplicationLoadingSplash", () => {
  it("shows only the oversized Cantrip mark and name", () => {
    const markup = renderToStaticMarkup(<ApplicationLoadingSplash />);

    expect(markup).toContain("data-application-loading-splash");
    expect(markup).toContain("application-loading-splash__mark");
    expect(markup).toContain('data-content-kind="text"');
    expect(markup).toContain(">Cantrip</h1>");
    expect(markup).not.toContain("Connecting to Cantrip");
    expect(markup).not.toContain("animate-spin");
  });

  it("continuously replays rapid three-frame brand glitches", () => {
    expect(APPLICATION_SPLASH_GLITCH_INTERVAL_MS).toBe(48);
    expect(APPLICATION_SPLASH_GLITCH_CONFIG).toMatchObject({
      glitchCountMax: 3,
      glitchCountMin: 3,
      glitchShowMs: 16,
      staggerSpreadMs: 0,
    });
    expect(
      APPLICATION_SPLASH_GLITCH_CONFIG.glitchShowMs *
        APPLICATION_SPLASH_GLITCH_CONFIG.glitchCountMin,
    ).toBe(APPLICATION_SPLASH_GLITCH_INTERVAL_MS);
    expect(APPLICATION_SPLASH_GLITCH_CONFIG.variants).toEqual([
      "chromatic",
      "spatial-shift",
      "scanline",
      "text-jitter",
    ]);
  });
});
