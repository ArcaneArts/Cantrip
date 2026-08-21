import { describe, expect, it } from "vitest";

import {
  createEliteGlitchFrame,
  createEliteGlitchSequence,
  DEFAULT_ELITE_REVEAL_CONFIG,
  ELITE_CHROMATIC_PAIRS,
  ELITE_GLITCH_VARIANTS,
  ELITE_GLITCH_VARIANT_WEIGHTS,
  eliteStaggerDelayForVisibleRank,
  normalizeEliteRevealConfig,
  selectEliteGlitchVariant,
  variantsForEliteContent,
  type EliteRevealConfig,
} from "./elite-reveal";

const config: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 4,
  glitchCountMin: 2,
  glitchShowMs: 15,
  staggerSpreadMs: 50,
  variants: ["outline", "chromatic", "text-jitter"],
};

describe("Elite reveal sequencing", () => {
  it("uses the intentionally brief default cadence", () => {
    expect(DEFAULT_ELITE_REVEAL_CONFIG).toMatchObject({
      glitchCountMax: 3,
      glitchCountMin: 1,
      glitchShowMs: 9,
      staggerSpreadMs: 50,
    });
  });

  it("normalizes timing and count boundaries", () => {
    expect(
      normalizeEliteRevealConfig({
        glitchCountMax: -10,
        glitchCountMin: 99,
        glitchShowMs: 2,
        staggerSpreadMs: 999,
        variants: ["outline", "outline"],
        variantWeights: {
          ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
          chromatic: -2,
          outline: 20,
        },
      }),
    ).toEqual({
      glitchCountMax: 8,
      glitchCountMin: 8,
      glitchShowMs: 5,
      staggerSpreadMs: 250,
      variants: ["outline"],
      variantWeights: {
        ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
        chromatic: 0,
        outline: 10,
      },
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

  it("uses the requested default weights", () => {
    expect(ELITE_GLITCH_VARIANT_WEIGHTS).toMatchObject({
      chromatic: 0.25,
      "full-frame": 0.1,
      "left-frame": 0.1,
      outline: 1,
      "right-frame": 0.1,
      scanline: 0.5,
      "spatial-shift": 1,
      "text-jitter": 1,
    });
    const variants = ["outline", "full-frame", "chromatic"] as const;
    expect(
      selectEliteGlitchVariant(
        variants,
        DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
        () => 0.5,
      ),
    ).toBe("outline");
    expect(
      selectEliteGlitchVariant(
        variants,
        DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
        () => 0.76,
      ),
    ).toBe("full-frame");
    expect(
      selectEliteGlitchVariant(
        variants,
        DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
        () => 0.9,
      ),
    ).toBe("chromatic");

    const selectionCounts = Object.fromEntries(
      ELITE_GLITCH_VARIANTS.map((variant) => [variant, 0]),
    ) as Record<(typeof ELITE_GLITCH_VARIANTS)[number], number>;
    for (let index = 0; index < 4_050; index += 1) {
      const variant = selectEliteGlitchVariant(
        ELITE_GLITCH_VARIANTS,
        DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
        () => (index + 0.5) / 4_050,
      );
      if (variant) selectionCounts[variant] += 1;
    }
    expect(selectionCounts).toMatchObject({
      "full-frame": 100,
      "left-frame": 100,
      "right-frame": 100,
      chromatic: 250,
      outline: 1_000,
      scanline: 500,
      "spatial-shift": 1_000,
      "text-jitter": 1_000,
    });
  });

  it("uses configured weights and skips zero-weight variants", () => {
    const weights = {
      ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
      chromatic: 0,
      outline: 1,
      "spatial-shift": 3,
    };
    const variants = ["outline", "chromatic", "spatial-shift"] as const;

    expect(selectEliteGlitchVariant(variants, weights, () => 0.2)).toBe(
      "outline",
    );
    expect(selectEliteGlitchVariant(variants, weights, () => 0.3)).toBe(
      "spatial-shift",
    );
    expect(selectEliteGlitchVariant(["chromatic"], weights, () => 0)).toBe(
      undefined,
    );
  });

  it("spreads every visible density through the configured time window", () => {
    expect(eliteStaggerDelayForVisibleRank(0, 100, 50)).toBe(0);
    expect(eliteStaggerDelayForVisibleRank(49, 100, 50)).toBe(25);
    expect(eliteStaggerDelayForVisibleRank(99, 100, 50)).toBe(50);
    expect(eliteStaggerDelayForVisibleRank(0, 1, 50)).toBe(0);
    expect(eliteStaggerDelayForVisibleRank(-1, 100, 50)).toBe(50);
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

  it("settles immediately when every enabled variant has zero weight", () => {
    expect(
      createEliteGlitchSequence(
        {
          ...config,
          variants: ["chromatic"],
          variantWeights: {
            ...config.variantWeights,
            chromatic: 0,
          },
        },
        "text",
        () => 0,
      ),
    ).toEqual([]);
  });

  it("randomizes chromatic split angle and distance", () => {
    const randomValues = [0.25, 0.5, 0.6];
    const frame = createEliteGlitchFrame(
      "chromatic",
      () => randomValues.shift() ?? 0,
    );

    expect(frame.chromaticAngleDeg).toBe(90);
    expect(frame.chromaticDistancePx).toBe(3.5);
    expect(frame.chromaticOffsetXPx).toBeCloseTo(0);
    expect(frame.chromaticOffsetYPx).toBe(3.5);
    expect(frame.chromaticChannelA).toBe(ELITE_CHROMATIC_PAIRS[3].channelA);
    expect(frame.chromaticChannelB).toBe(ELITE_CHROMATIC_PAIRS[3].channelB);
  });

  it("offers several contrasting chromatic palettes", () => {
    expect(ELITE_CHROMATIC_PAIRS.length).toBeGreaterThanOrEqual(5);
    expect(
      new Set(ELITE_CHROMATIC_PAIRS.map((pair) => pair.channelA)).size,
    ).toBe(ELITE_CHROMATIC_PAIRS.length);
  });

  it("limits spatial displacement to seven and a half percent", () => {
    const randomValues = [0.125, 0.8];
    const frame = createEliteGlitchFrame(
      "spatial-shift",
      () => randomValues.shift() ?? 0,
    );

    expect(Math.hypot(frame.shiftXPercent, frame.shiftYPercent)).toBeCloseTo(
      6,
      2,
    );
    expect(Math.abs(frame.shiftXPercent)).toBeLessThanOrEqual(7.5);
    expect(Math.abs(frame.shiftYPercent)).toBeLessThanOrEqual(7.5);
  });

  it("randomizes which outline sides are visible", () => {
    const randomValues = [0.6, 0.4, 0.8, 0.2];
    const frame = createEliteGlitchFrame(
      "outline",
      () => randomValues.shift() ?? 0,
    );

    expect(frame).toMatchObject({
      outlineBottom: true,
      outlineLeft: false,
      outlineRight: false,
      outlineTop: true,
    });
  });

  it("creates one to five scanline bands on a randomized side", () => {
    const randomValues = [0.8, 0.6];
    const frame = createEliteGlitchFrame(
      "scanline",
      () => randomValues.shift() ?? 0.5,
    );

    expect(frame.scanlineBands).toHaveLength(5);
    expect(frame.scanlineSide).toBe("left");
    expect(frame.scanlineBands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heightPx: 7, topPercent: 50 }),
      ]),
    );
  });

  it("keeps the public variant catalog stable and unique", () => {
    expect(new Set(ELITE_GLITCH_VARIANTS).size).toBe(
      ELITE_GLITCH_VARIANTS.length,
    );
    expect(ELITE_GLITCH_VARIANTS).toContain("left-frame");
    expect(ELITE_GLITCH_VARIANTS).toContain("right-frame");
    expect(ELITE_GLITCH_VARIANTS).not.toContain("noise");
    expect(ELITE_GLITCH_VARIANTS).not.toContain("pixelate");
    expect(ELITE_GLITCH_VARIANTS).toContain("spatial-shift");
  });
});
