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
    expect(markup).toContain(">Cantrip</h1>");
    expect(markup).not.toContain("Connecting to Cantrip");
    expect(markup).not.toContain("animate-spin");
  });

  it("replays one short bolt glitch every 100 milliseconds", () => {
    expect(APPLICATION_SPLASH_GLITCH_INTERVAL_MS).toBe(100);
    expect(APPLICATION_SPLASH_GLITCH_CONFIG).toMatchObject({
      glitchCountMax: 1,
      glitchCountMin: 1,
      glitchShowMs: 72,
      staggerSpreadMs: 0,
    });
    expect(APPLICATION_SPLASH_GLITCH_CONFIG.glitchShowMs).toBeLessThan(
      APPLICATION_SPLASH_GLITCH_INTERVAL_MS,
    );
    expect(APPLICATION_SPLASH_GLITCH_CONFIG.variants).toEqual([
      "chromatic",
      "spatial-shift",
      "scanline",
    ]);
  });
});
