import { describe, expect, it } from "vitest";

import { measuredAgentUsageSchema } from "../src/agent-usage.js";

describe("measured agent usage", () => {
  it("normalizes an empty measurement", () => {
    expect(measuredAgentUsageSchema.parse({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      estimatedCostUsd: null,
      costAvailable: false,
    });
  });

  it("rejects negative or fractional counters", () => {
    expect(
      measuredAgentUsageSchema.safeParse({ inputTokens: -1 }).success,
    ).toBe(false);
    expect(
      measuredAgentUsageSchema.safeParse({ durationMs: 1.5 }).success,
    ).toBe(false);
  });
});
