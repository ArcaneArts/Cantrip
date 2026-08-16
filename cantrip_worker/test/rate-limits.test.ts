import { describe, expect, it } from "vitest";

import { weeklyUsageFromRateLimits } from "../src/codex/rate-limits.js";

const weekly = (usedPercent: number) => ({
  usedPercent,
  windowDurationMins: 10_080,
  resetsAt: 1_787_000_000,
});

describe("Codex weekly rate limits", () => {
  it("prefers the canonical snapshot over unordered additional limits", () => {
    expect(
      weeklyUsageFromRateLimits({
        rateLimits: { primary: null, secondary: weekly(37) },
        rateLimitsByLimitId: {
          another_limit: { primary: weekly(100), secondary: null },
          codex: { primary: null, secondary: weekly(37) },
        },
      }),
    ).toEqual({ usedPercent: 37, resetsAt: 1_787_000_000 });
  });

  it("falls back to the named canonical snapshot and rejects invalid values", () => {
    expect(
      weeklyUsageFromRateLimits({
        rateLimitsByLimitId: {
          codex: { primary: weekly(42), secondary: null },
        },
      })?.usedPercent,
    ).toBe(42);
    expect(
      weeklyUsageFromRateLimits({
        rateLimits: { primary: weekly(101), secondary: null },
      }),
    ).toBeNull();
  });
});
