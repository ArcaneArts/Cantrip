import { describe, expect, it } from "vitest";

import {
  deriveQuotaTokenAnalytics,
  quotaValueStatistics,
  type QuotaAnalyticsReading,
  type QuotaAnalyticsTokenAttempt,
} from "../src/analytics/quota-token.js";

const resetA = new Date("2026-08-20T00:00:00Z");

function reading(
  id: string,
  observedAt: string,
  usedPercent: number,
  overrides: Partial<QuotaAnalyticsReading> = {},
): QuotaAnalyticsReading {
  const observed = new Date(observedAt);
  return {
    id,
    providerId: "provider-1",
    providerAccountId: "account-1",
    limitId: "weekly",
    limitName: "Weekly",
    windowKind: "primary",
    windowDurationMinutes: 10_080,
    resetsAt: resetA,
    observedAt: observed,
    receivedAt: new Date(observed.getTime() + 100),
    usedPercent,
    ...overrides,
  };
}

function attempt(
  id: string,
  finalizedAt: string,
  overrides: Partial<QuotaAnalyticsTokenAttempt> = {},
): QuotaAnalyticsTokenAttempt {
  const finalized = new Date(finalizedAt);
  return {
    id,
    providerId: "provider-1",
    providerAccountId: "account-1",
    modelId: "model-1",
    modelName: "Model 1",
    reasoningEffort: "high",
    projectId: "project-1",
    startedAt: new Date(finalized.getTime() - 1_000),
    completedAt: finalized,
    finalizedAt: finalized,
    attemptStatus: "completed",
    inputTokens: 80,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    visibleOutputTokens: null,
    reportedTotalTokens: 100,
    ...overrides,
  };
}

describe("quota/token analytics", () => {
  it("accumulates exact-account attempts across stationary meter readings", () => {
    const result = deriveQuotaTokenAnalytics(
      [
        reading("r1", "2026-08-16T10:00:00Z", 10),
        reading("r2", "2026-08-16T10:05:00Z", 10),
        reading("r3", "2026-08-16T10:10:00Z", 11),
      ],
      [
        attempt("a1", "2026-08-16T10:03:00Z"),
        attempt("a2", "2026-08-16T10:08:00Z", {
          inputTokens: 40,
          outputTokens: 10,
          cachedInputTokens: 10,
          reasoningOutputTokens: 2,
          reportedTotalTokens: 50,
        }),
        attempt("other-account", "2026-08-16T10:07:00Z", {
          providerAccountId: "account-2",
          inputTokens: 9_999,
        }),
      ],
      new Date("2026-08-16T10:10:00Z"),
    );

    expect(result.intervals.map(({ kind }) => kind)).toEqual([
      "stationary",
      "movement",
    ]);
    expect(result.movementSamples).toHaveLength(1);
    expect(result.movementSamples[0]).toMatchObject({
      usedPercentDelta: 1,
      stationaryReadingCount: 1,
      attemptCount: 2,
      confidence: "high",
      unattributed: false,
      tokens: {
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 30,
        reasoningOutputTokens: 7,
        comparableTokens: 150,
      },
      tokensPerPercent: { comparableTokens: 150 },
      effectiveTokensPer100Percent: 15_000,
    });
    expect(result.breakdowns.model[0]).toMatchObject({
      key: "model-1",
      sampleCount: 1,
      highConfidenceSamples: 1,
    });
  });

  it("separates reset windows and treats backwards movement as a rebaseline", () => {
    const resetB = new Date("2026-08-27T00:00:00Z");
    const result = deriveQuotaTokenAnalytics(
      [
        reading("a1", "2026-08-16T10:00:00Z", 20),
        reading("a2", "2026-08-16T10:05:00Z", 18),
        reading("a3", "2026-08-16T10:10:00Z", 19),
        reading("b1", "2026-08-20T00:01:00Z", 0, { resetsAt: resetB }),
        reading("b2", "2026-08-20T00:05:00Z", 1, { resetsAt: resetB }),
      ],
      [attempt("post-rebaseline", "2026-08-16T10:08:00Z")],
      new Date("2026-08-20T00:05:00Z"),
    );

    expect(result.intervals.map(({ kind }) => kind)).toEqual([
      "rebaseline",
      "movement",
      "unattributed-movement",
    ]);
    expect(result.intervals).not.toContainEqual(
      expect.objectContaining({ fromReadingId: "a3", toReadingId: "b1" }),
    );
    expect(result.movementSamples[0]).toMatchObject({
      fromObservedAt: "2026-08-16T10:05:00.000Z",
      confidence: "high",
    });
    expect(result.movementSamples[1]).toMatchObject({
      unattributed: true,
      confidence: "low",
      confidenceReasons: ["meter-movement-without-tokens"],
    });
  });

  it("retains pending tokens and lowers confidence for ambiguous samples", () => {
    const result = deriveQuotaTokenAnalytics(
      [
        reading("r1", "2026-08-16T10:00:00Z", 10),
        reading("r2", "2026-08-16T10:10:00Z", 11, {
          receivedAt: new Date("2026-08-16T10:10:10Z"),
        }),
      ],
      [
        attempt("a1", "2026-08-16T10:04:00Z"),
        attempt("a2", "2026-08-16T10:06:00Z", {
          modelId: "model-2",
          modelName: "Model 2",
          projectId: "project-2",
          reasoningEffort: "medium",
          attemptStatus: "failed",
        }),
        attempt("pending", "2026-08-16T10:12:00Z"),
      ],
      new Date("2026-08-16T10:15:00Z"),
    );

    expect(result.movementSamples[0]).toMatchObject({
      confidence: "medium",
      confidenceReasons: [
        "multiple-models",
        "multiple-reasoning-efforts",
        "multiple-projects",
        "delayed-observation",
        "non-completed-attempts",
      ],
    });
    expect(result.pendingConsumption[0]).toMatchObject({
      attemptCount: 1,
      tokens: { comparableTokens: 100 },
    });
    expect(result.breakdowns.model[0]?.key).toBe("mixed-or-unknown");
  });

  it("computes stable distribution statistics", () => {
    expect(quotaValueStatistics([100, 200, 300, 400])).toEqual({
      sampleCount: 4,
      mean: 250,
      median: 250,
      min: 100,
      p10: 130,
      p25: 175,
      p75: 325,
      p90: 370,
      max: 400,
    });
  });

  it("compares rolling and monthly effective allowances", () => {
    const julyReset = new Date("2026-08-01T00:00:00Z");
    const augustReset = new Date("2026-09-01T00:00:00Z");
    const result = deriveQuotaTokenAnalytics(
      [
        reading("j1", "2026-07-14T10:00:00Z", 1, { resetsAt: julyReset }),
        reading("j2", "2026-07-15T10:00:00Z", 2, { resetsAt: julyReset }),
        reading("a1", "2026-08-04T10:00:00Z", 1, { resetsAt: augustReset }),
        reading("a2", "2026-08-05T10:00:00Z", 2, { resetsAt: augustReset }),
        reading("a3", "2026-08-14T10:00:00Z", 2, { resetsAt: augustReset }),
        reading("a4", "2026-08-15T10:00:00Z", 3, { resetsAt: augustReset }),
      ],
      [
        attempt("july", "2026-07-15T09:00:00Z", {
          inputTokens: 40,
          outputTokens: 10,
        }),
        attempt("previous-week", "2026-08-05T09:00:00Z", {
          inputTokens: 80,
          outputTokens: 20,
        }),
        attempt("current-week", "2026-08-15T09:00:00Z", {
          inputTokens: 160,
          outputTokens: 40,
        }),
      ],
      new Date("2026-08-16T12:00:00Z"),
    );

    expect(result.rolling7Days.current.median).toBe(20_000);
    expect(result.rolling7Days.previous.median).toBe(10_000);
    expect(result.rolling7Days.changePercent).toBe(100);
    expect(result.monthOverMonth.previous.median).toBe(5_000);
    expect(result.monthOverMonth.current.sampleCount).toBe(2);
  });
});
