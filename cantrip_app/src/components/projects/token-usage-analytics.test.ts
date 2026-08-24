import { describe, expect, it } from "vitest";

import {
  formatAgentTime,
  formatConcurrency,
  formatTokenCount,
  tokenUsageCalendar,
  tokenUsageConicGradient,
  tokenUsageIntensity,
  tokenUsageSlices,
} from "./token-usage-analytics";

describe("token usage analytics", () => {
  it("formats agent time and concurrency compactly", () => {
    expect(formatAgentTime(0)).toBe("0m");
    expect(formatAgentTime(45_000)).toBe("<1m");
    expect(formatAgentTime(3_720_000)).toBe("1h 2m");
    expect(formatAgentTime(93_600_000)).toBe("1d 2h");
    expect(formatConcurrency({ averageConcurrency: 2.17 })).toBe("2.2x");
  });
  it("formats compact counts without losing useful precision", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_250)).toBe("1.25K");
    expect(formatTokenCount(12_500_000)).toBe("12.5M");
  });

  it("fills missing calendar dates and aligns the first week", () => {
    const cells = tokenUsageCalendar({
      daily: [
        {
          date: "2026-08-11",
          inputTokens: 8,
          outputTokens: 2,
          cachedInputTokens: 1,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 1,
          totalTokens: 10,
        },
      ],
      range: { start: "2026-08-09", end: "2026-08-11" },
    });

    expect(cells).toHaveLength(3);
    expect(cells[1]).toMatchObject({ date: "2026-08-10", totalTokens: 0 });
    expect(cells[2]).toMatchObject({ date: "2026-08-11", totalTokens: 10 });
    expect(
      tokenUsageCalendar({ daily: [], range: { start: "bad", end: "bad" } }),
    ).toEqual([]);
  });

  it("creates stable intensity levels and combines small pie slices", () => {
    expect(tokenUsageIntensity(0, 100)).toBe(0);
    expect(tokenUsageIntensity(1, 100)).toBe(1);
    expect(tokenUsageIntensity(100, 100)).toBe(4);
    const slices = tokenUsageSlices(
      [10, 9, 8, 7, 6, 5].map((totalTokens, index) => ({
        id: `provider-${index}`,
        name: `Provider ${index}`,
        inputTokens: totalTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens,
        agentTime: {
          activeAgentCount: 0,
          agentTimeMs: 0,
          wallTimeMs: 0,
          averageConcurrency: 0,
        },
      })),
      3,
    );
    expect(slices).toHaveLength(4);
    expect(slices.at(-1)).toMatchObject({ name: "Other", totalTokens: 18 });
    expect(tokenUsageConicGradient(slices)).toContain("conic-gradient");
    expect(tokenUsageSlices([])).toEqual([]);
  });
});
