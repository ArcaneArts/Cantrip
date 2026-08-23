import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_SPLASH_BOLT_GLITCH_CONFIG,
  APPLICATION_SPLASH_GLITCH_DELAY_MAX_MS,
  APPLICATION_SPLASH_GLITCH_DELAY_MIN_MS,
  APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG,
  ApplicationLoadingSplash,
  applicationSplashGlitchDelayMs,
} from "./application-loading-splash";

describe("ApplicationLoadingSplash", () => {
  it("shows only the oversized Cantrip mark and name", () => {
    const markup = renderToStaticMarkup(<ApplicationLoadingSplash />);

    expect(markup).toContain("data-application-loading-splash");
    expect(markup).toContain("application-loading-splash__mark");
    expect(markup).toContain('data-content-kind="box"');
    expect(markup).toContain('data-content-kind="text"');
    expect(markup.match(/data-elite-reveal=""/g)).toHaveLength(2);
    expect(markup).toContain(">Cantrip</h1>");
    expect(markup).not.toContain("Connecting to Cantrip");
    expect(markup).not.toContain("animate-spin");
  });

  it("runs independent short glitches for the bolt and wordmark", () => {
    expect(APPLICATION_SPLASH_BOLT_GLITCH_CONFIG).toMatchObject({
      glitchCountMax: 3,
      glitchCountMin: 3,
      glitchShowMs: 16,
      staggerSpreadMs: 0,
    });
    expect(
      APPLICATION_SPLASH_BOLT_GLITCH_CONFIG.glitchShowMs *
        APPLICATION_SPLASH_BOLT_GLITCH_CONFIG.glitchCountMin,
    ).toBe(48);
    expect(APPLICATION_SPLASH_BOLT_GLITCH_CONFIG.variants).toEqual([
      "chromatic",
      "spatial-shift",
    ]);

    expect(APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG).toMatchObject({
      glitchCountMax: 3,
      glitchCountMin: 3,
      glitchShowMs: 14,
      staggerSpreadMs: 0,
    });
    expect(
      APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG.glitchShowMs *
        APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG.glitchCountMin,
    ).toBe(42);
    expect(APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG.variants).toEqual([
      "chromatic",
      "spatial-shift",
      "text-jitter",
    ]);
  });

  it("waits a randomized one to three seconds between glitch bursts", () => {
    expect(APPLICATION_SPLASH_GLITCH_DELAY_MIN_MS).toBe(1_000);
    expect(APPLICATION_SPLASH_GLITCH_DELAY_MAX_MS).toBe(3_000);
    expect(applicationSplashGlitchDelayMs(() => 0)).toBe(1_000);
    expect(applicationSplashGlitchDelayMs(() => 0.5)).toBe(2_000);
    expect(applicationSplashGlitchDelayMs(() => 1)).toBe(3_000);
    expect(applicationSplashGlitchDelayMs(() => -1)).toBe(1_000);
    expect(applicationSplashGlitchDelayMs(() => 2)).toBe(3_000);
    expect(applicationSplashGlitchDelayMs(() => Number.NaN)).toBe(1_000);
  });
});
