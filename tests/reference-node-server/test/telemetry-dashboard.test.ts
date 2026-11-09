import { describe, expect, it } from "vitest";

import {
  sumDetailedTokenUsage,
  summarizeModelBehavior,
} from "../src/analytics/telemetry-dashboard.js";

describe("telemetry dashboard derivation", () => {
  it("keeps raw token categories visible while deriving comparable totals", () => {
    expect(
      sumDetailedTokenUsage([
        {
          startedAt: new Date("2026-08-16T10:00:00Z"),
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 10,
          outputTokens: 30,
          reasoningOutputTokens: 12,
        },
        {
          startedAt: new Date("2026-08-16T10:01:00Z"),
          inputTokens: 25,
          cachedInputTokens: 5,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 4,
        },
      ]),
    ).toEqual({
      inputTokens: 125,
      cachedInputTokens: 45,
      cacheWriteInputTokens: 10,
      outputTokens: 40,
      reasoningOutputTokens: 16,
      totalTokens: 165,
    });
  });

  it("derives objective completion, latency, and tool-error signals", () => {
    const startedAt = new Date("2026-08-16T10:00:00Z");
    const summary = summarizeModelBehavior([
      {
        attemptStatus: "completed",
        startedAt,
        firstActivityAt: new Date(startedAt.getTime() + 200),
        firstVisibleResponseAt: new Date(startedAt.getTime() + 800),
        durationMs: 2_000,
        finalAnswerAppeared: true,
        toolCallCount: 4,
        invalidToolCallCount: 1,
        retryFailoverCount: 0,
        compactionCount: 1,
        approvalRequestCount: 1,
        filesChangedCount: 2,
        testCommandCount: 1,
        testFailureCount: 0,
        immediateCorrectiveFollowup: false,
      },
      {
        attemptStatus: "failed",
        startedAt,
        firstActivityAt: new Date(startedAt.getTime() + 400),
        firstVisibleResponseAt: null,
        durationMs: 4_000,
        finalAnswerAppeared: false,
        toolCallCount: 1,
        invalidToolCallCount: 0,
        retryFailoverCount: 1,
        compactionCount: 0,
        approvalRequestCount: 0,
        filesChangedCount: 0,
        testCommandCount: 1,
        testFailureCount: 1,
        immediateCorrectiveFollowup: true,
      },
    ]);

    expect(summary).toMatchObject({
      attemptCount: 2,
      completedCount: 1,
      failedCount: 1,
      completionRate: 0.5,
      finalAnswerRate: 0.5,
      toolCallCount: 5,
      invalidToolCallCount: 1,
      toolErrorRate: 0.2,
      retryFailoverCount: 1,
      compactionCount: 1,
      testFailureCount: 1,
      immediateCorrectiveFollowupCount: 1,
      durationMs: { sampleCount: 2, median: 3_000 },
      timeToFirstActivityMs: { sampleCount: 2, median: 300 },
      timeToVisibleResponseMs: { sampleCount: 1, median: 800 },
    });
  });
});
