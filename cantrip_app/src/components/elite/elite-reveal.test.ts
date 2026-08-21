import { describe, expect, it } from "vitest";

import {
  createEliteGlitchFrame,
  createEliteGlitchSequence,
  DEFAULT_ELITE_REVEAL_CONFIG,
  ELITE_GLITCH_VARIANTS,
  normalizeEliteRevealConfig,
  variantsForEliteContent,
  type EliteRevealConfig,
} from "./elite-reveal";

const config: EliteRevealConfig = {
  glitchCountMax: 4,
  glitchCountMin: 2,
  glitchShowMs: 15,
  staggerDelayMs: 25,
  variants: ["outline", "chromatic", "text-jitter"],
};

describe("Elite reveal sequencing", () => {
  it("uses the intentionally brief default cadence", () => {
    expect(DEFAULT_ELITE_REVEAL_CONFIG).toMatchObject({
      glitchCountMax: 3,
      glitchCountMin: 1,
      glitchShowMs: 9,
      staggerDelayMs: 7,
    });
  });

  it("normalizes timing and count boundaries", () => {
    expect(
      normalizeEliteRevealConfig({
        glitchCountMax: -10,
        glitchCountMin: 99,
        glitchShowMs: 2,
        staggerDelayMs: 999,
        variants: ["outline", "outline"],
      }),
    ).toEqual({
      glitchCountMax: 8,
      glitchCountMin: 8,
      glitchShowMs: 5,
      staggerDelayMs: 250,
      variants: ["outline"],
    });
  });

  it("uses the configured randomized count and variants", () => {
    const randomValues = [0.99, 0, 0.5, 0.99, 0];
    const sequence = createEliteGlitchSequence(
      config,
      "text",
      () => randomValues.shift() ?? 0,
    );

    expect(sequence).toEqual([
      "outline",
      "chromatic",
      "text-jitter",
      "outline",
    ]);
  });

  it("keeps text-only variants away from boxes and controls", () => {
    expect(variantsForEliteContent(config.variants, "box")).toEqual([
      "outline",
      "chromatic",
    ]);
    expect(variantsForEliteContent(config.variants, "control")).toEqual([
      "outline",
      "chromatic",
    ]);
    expect(variantsForEliteContent(config.variants, "text")).toEqual(
      config.variants,
    );
  });

  it("settles immediately when every variant is disabled", () => {
    expect(
      createEliteGlitchSequence({ ...config, variants: [] }, "text", () => 0),
    ).toEqual([]);
  });

  it("randomizes chromatic split angle and distance", () => {
    const randomValues = [0.25, 0.5];
    const frame = createEliteGlitchFrame(
      "chromatic",
      () => randomValues.shift() ?? 0,
    );

    expect(frame.chromaticAngleDeg).toBe(90);
    expect(frame.chromaticDistancePx).toBe(3.5);
    expect(frame.chromaticOffsetXPx).toBeCloseTo(0);
    expect(frame.chromaticOffsetYPx).toBe(3.5);
  });

  it("limits spatial displacement to fifteen percent of element size", () => {
    const randomValues = [0.125, 0.8];
    const frame = createEliteGlitchFrame(
      "spatial-shift",
      () => randomValues.shift() ?? 0,
    );

    expect(Math.hypot(frame.shiftXPercent, frame.shiftYPercent)).toBeCloseTo(
      12,
      3,
    );
    expect(Math.abs(frame.shiftXPercent)).toBeLessThanOrEqual(15);
    expect(Math.abs(frame.shiftYPercent)).toBeLessThanOrEqual(15);
  });

  it("keeps randomized pixel blocks within compact bounds", () => {
    const randomValues = [0.999, 0, 0.999];
    const frame = createEliteGlitchFrame(
      "pixelate",
      () => randomValues.shift() ?? 0,
    );

    expect(frame.pixelSizePx).toBe(12);
    expect(Math.abs(frame.pixelOffsetXPx)).toBeLessThanOrEqual(12);
    expect(Math.abs(frame.pixelOffsetYPx)).toBeLessThanOrEqual(12);
  });

  it("keeps the public variant catalog stable and unique", () => {
    expect(new Set(ELITE_GLITCH_VARIANTS).size).toBe(
      ELITE_GLITCH_VARIANTS.length,
    );
    expect(ELITE_GLITCH_VARIANTS).toContain("left-frame");
    expect(ELITE_GLITCH_VARIANTS).toContain("right-frame");
    expect(ELITE_GLITCH_VARIANTS).toContain("noise");
    expect(ELITE_GLITCH_VARIANTS).toContain("pixelate");
    expect(ELITE_GLITCH_VARIANTS).toContain("spatial-shift");
  });
});
