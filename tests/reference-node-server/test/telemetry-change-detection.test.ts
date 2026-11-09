import { describe, expect, it } from "vitest";

import {
  detectTelemetryChanges,
  type ChangeDetectionBehaviorRow,
} from "../src/analytics/telemetry-change-detection.js";
import type { QuotaMovementSample } from "../src/analytics/quota-token.js";

const day = (index: number) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString();

function quotaSample(
  index: number,
  effectiveAllowance: number,
): QuotaMovementSample {
  const comparableTokens = effectiveAllowance / 100;
  return {
    accountId: "account-one",
    providerId: "provider-one",
    bucketKey: "provider-one:account-one:weekly:secondary:10080",
    resetWindowKey: `window-${Math.floor(index / 7)}`,
    fromObservedAt: day(index),
    toObservedAt: day(index + 1),
    usedPercentDelta: 1,
    stationaryReadingCount: 1,
    attemptCount: 1,
    tokens: {
      inputTokens: comparableTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      visibleOutputTokens: null,
      reportedTotalTokens: comparableTokens,
      comparableTokens,
    },
    tokensPerPercent: {
      inputTokens: comparableTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      visibleOutputTokens: null,
      reportedTotalTokens: comparableTokens,
      comparableTokens,
    },
    effectiveTokensPer100Percent: effectiveAllowance,
    modelIds: ["model-one"],
    modelNames: ["Model one"],
    reasoningEfforts: ["high"],
    projectIds: ["project-one"],
    observationLagMs: 100,
    confidence: "high",
    confidenceReasons: [],
    unattributed: false,
  };
}

function behaviorRow(
  index: number,
  overrides: Partial<ChangeDetectionBehaviorRow> = {},
): ChangeDetectionBehaviorRow {
  const startedAt = new Date(day(index));
  return {
    providerAccountId: "account-one",
    modelId: "model-one",
    attemptStatus: "completed",
    startedAt,
    firstActivityAt: new Date(startedAt.getTime() + 100),
    firstVisibleResponseAt: new Date(startedAt.getTime() + 500),
    durationMs: 1_000,
    finalAnswerAppeared: true,
    toolCallCount: 2,
    invalidToolCallCount: 0,
    retryFailoverCount: 0,
    compactionCount: 0,
    approvalRequestCount: 0,
    filesChangedCount: 0,
    testCommandCount: 0,
    testFailureCount: 0,
    immediateCorrectiveFollowup: false,
    outputTokens: 100,
    reasoningOutputTokens: 20,
    ...overrides,
  };
}

describe("telemetry change detection", () => {
  it("finds conservative allowance and behavior shifts with attribution", () => {
    const quota = Array.from({ length: 24 }, (_, index) =>
      quotaSample(index, index < 12 ? 100_000 : 60_000),
    );
    const behavior = Array.from({ length: 40 }, (_, index) =>
      behaviorRow(index, {
        attemptStatus:
          index < 20 ? "completed" : index % 2 ? "failed" : "completed",
        durationMs: index < 20 ? 1_000 : 2_000,
        toolCallCount: 2,
        invalidToolCallCount: index < 20 ? 0 : 1,
        compactionCount: index < 20 ? 0 : 1,
        outputTokens: 100,
        reasoningOutputTokens: index < 20 ? 20 : 60,
      }),
    );

    const changes = detectTelemetryChanges(quota, behavior);
    const accountAllowance = changes.find(
      ({ metric, scope }) =>
        metric === "effective-weekly-allowance" && scope === "account",
    );
    expect(accountAllowance).toMatchObject({
      providerAccountId: "account-one",
      beforeValue: 100_000,
      afterValue: 60_000,
      direction: "decreased",
      impact: "degradation",
      confidence: "high",
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "latency",
          scope: "model",
          modelId: "model-one",
          impact: "degradation",
        }),
        expect.objectContaining({
          metric: "completion-rate",
          scope: "account-model",
          providerAccountId: "account-one",
          modelId: "model-one",
          impact: "degradation",
        }),
        expect.objectContaining({
          metric: "output-reasoning-mix",
          impact: "neutral",
        }),
      ]),
    );
  });

  it("does not flag stationary noise or undersampled series", () => {
    const quota = Array.from({ length: 8 }, (_, index) =>
      quotaSample(index, 100_000 + (index % 2) * 2_000),
    );
    const behavior = Array.from({ length: 12 }, (_, index) =>
      behaviorRow(index, { durationMs: 1_000 + (index % 3) * 50 }),
    );

    expect(detectTelemetryChanges(quota, behavior)).toEqual([]);
  });

  it("ignores incomplete running attempts", () => {
    const behavior = [
      ...Array.from({ length: 12 }, (_, index) => behaviorRow(index)),
      ...Array.from({ length: 12 }, (_, index) =>
        behaviorRow(index + 12, {
          attemptStatus: "running",
          durationMs: 60_000,
          invalidToolCallCount: 2,
          compactionCount: 4,
          reasoningOutputTokens: 100,
        }),
      ),
    ];

    expect(detectTelemetryChanges([], behavior)).toEqual([]);
  });
});
