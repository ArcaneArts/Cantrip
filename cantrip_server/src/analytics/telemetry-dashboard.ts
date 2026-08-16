import type {
  DetailedTokenUsageTotals,
  ModelBehaviorSummary,
} from "@cantrip/protocol";

import { quotaValueStatistics } from "./quota-token.js";

export interface TelemetryTokenRow {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  startedAt: Date;
}

export interface TelemetryBehaviorRow {
  attemptStatus: string;
  startedAt: Date;
  firstActivityAt: Date | null;
  firstVisibleResponseAt: Date | null;
  durationMs: number | null;
  finalAnswerAppeared: boolean;
  toolCallCount: number;
  invalidToolCallCount: number;
  retryFailoverCount: number;
  compactionCount: number;
  approvalRequestCount: number;
  filesChangedCount: number;
  testCommandCount: number;
  testFailureCount: number;
  immediateCorrectiveFollowup: boolean;
}

export const EMPTY_DETAILED_TOKEN_USAGE: DetailedTokenUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export function sumDetailedTokenUsage(
  rows: readonly TelemetryTokenRow[],
): DetailedTokenUsageTotals {
  return rows.reduce<DetailedTokenUsageTotals>(
    (total, row) => ({
      inputTokens: total.inputTokens + row.inputTokens,
      cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
      cacheWriteInputTokens:
        total.cacheWriteInputTokens + row.cacheWriteInputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      reasoningOutputTokens:
        total.reasoningOutputTokens + row.reasoningOutputTokens,
      totalTokens: total.totalTokens + row.inputTokens + row.outputTokens,
    }),
    { ...EMPTY_DETAILED_TOKEN_USAGE },
  );
}

export function summarizeModelBehavior(
  rows: readonly TelemetryBehaviorRow[],
): ModelBehaviorSummary {
  const terminal = rows.filter(
    ({ attemptStatus }) => attemptStatus !== "running",
  );
  const completedCount = terminal.filter(
    ({ attemptStatus }) => attemptStatus === "completed",
  ).length;
  const failedCount = terminal.filter(
    ({ attemptStatus }) => attemptStatus === "failed",
  ).length;
  const interruptedCount = terminal.filter(({ attemptStatus }) =>
    ["cancelled", "interrupted"].includes(attemptStatus),
  ).length;
  const toolCallCount = rows.reduce((sum, row) => sum + row.toolCallCount, 0);
  const invalidToolCallCount = rows.reduce(
    (sum, row) => sum + row.invalidToolCallCount,
    0,
  );
  const statistics = (values: Array<number | null>) =>
    quotaValueStatistics(
      values.filter((value): value is number => value !== null),
    );
  return {
    attemptCount: rows.length,
    completedCount,
    failedCount,
    interruptedCount,
    completionRate: terminal.length ? completedCount / terminal.length : null,
    finalAnswerRate: terminal.length
      ? terminal.filter(({ finalAnswerAppeared }) => finalAnswerAppeared)
          .length / terminal.length
      : null,
    toolCallCount,
    invalidToolCallCount,
    toolErrorRate: toolCallCount ? invalidToolCallCount / toolCallCount : null,
    retryFailoverCount: rows.reduce(
      (sum, row) => sum + row.retryFailoverCount,
      0,
    ),
    compactionCount: rows.reduce((sum, row) => sum + row.compactionCount, 0),
    approvalRequestCount: rows.reduce(
      (sum, row) => sum + row.approvalRequestCount,
      0,
    ),
    filesChangedCount: rows.reduce(
      (sum, row) => sum + row.filesChangedCount,
      0,
    ),
    testCommandCount: rows.reduce((sum, row) => sum + row.testCommandCount, 0),
    testFailureCount: rows.reduce((sum, row) => sum + row.testFailureCount, 0),
    immediateCorrectiveFollowupCount: rows.filter(
      ({ immediateCorrectiveFollowup }) => immediateCorrectiveFollowup,
    ).length,
    durationMs: statistics(rows.map(({ durationMs }) => durationMs)),
    timeToFirstActivityMs: statistics(
      rows.map(({ firstActivityAt, startedAt }) =>
        firstActivityAt
          ? Math.max(0, firstActivityAt.getTime() - startedAt.getTime())
          : null,
      ),
    ),
    timeToVisibleResponseMs: statistics(
      rows.map(({ firstVisibleResponseAt, startedAt }) =>
        firstVisibleResponseAt
          ? Math.max(0, firstVisibleResponseAt.getTime() - startedAt.getTime())
          : null,
      ),
    ),
  };
}

export function groupModelBehavior<Row extends TelemetryBehaviorRow>(
  rows: readonly Row[],
  keyFor: (row: Row) => string,
): Map<string, ModelBehaviorSummary> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyFor(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return new Map(
    [...grouped.entries()].map(([key, entries]) => [
      key,
      summarizeModelBehavior(entries),
    ]),
  );
}
