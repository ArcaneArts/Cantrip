import { describe, expect, it } from "vitest";

import {
  createEliteGlitchSequence,
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

  it("keeps the public variant catalog stable and unique", () => {
    expect(new Set(ELITE_GLITCH_VARIANTS).size).toBe(
      ELITE_GLITCH_VARIANTS.length,
    );
    expect(ELITE_GLITCH_VARIANTS).toContain("left-frame");
    expect(ELITE_GLITCH_VARIANTS).toContain("right-frame");
    expect(ELITE_GLITCH_VARIANTS).toContain("noise");
  });
});
