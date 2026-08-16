export type QuotaAnalyticsConfidence = "high" | "medium" | "low";

export interface QuotaAnalyticsReading {
  id: string;
  providerId: string;
  providerAccountId: string;
  limitId: string | null;
  limitName: string | null;
  windowKind: string;
  windowDurationMinutes: number | null;
  resetsAt: Date | null;
  observedAt: Date;
  receivedAt: Date;
  usedPercent: number;
}

export interface QuotaAnalyticsTokenAttempt {
  id: string;
  providerId: string | null;
  providerAccountId: string | null;
  modelId: string | null;
  modelName: string;
  reasoningEffort: string | null;
  projectId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  finalizedAt: Date | null;
  attemptStatus: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  visibleOutputTokens: number | null;
  reportedTotalTokens: number | null;
}

export interface QuotaTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  visibleOutputTokens: number | null;
  reportedTotalTokens: number | null;
  comparableTokens: number;
}

export interface QuotaAnalyticsInterval {
  accountId: string;
  providerId: string;
  bucketKey: string;
  resetWindowKey: string;
  fromReadingId: string;
  toReadingId: string;
  fromObservedAt: string;
  toObservedAt: string;
  usedPercentBefore: number;
  usedPercentAfter: number;
  usedPercentDelta: number;
  kind: "stationary" | "movement" | "unattributed-movement" | "rebaseline";
  intervalTokens: QuotaTokenTotals;
  attemptCount: number;
}

export interface QuotaMovementSample {
  accountId: string;
  providerId: string;
  bucketKey: string;
  resetWindowKey: string;
  fromObservedAt: string;
  toObservedAt: string;
  usedPercentDelta: number;
  stationaryReadingCount: number;
  attemptCount: number;
  tokens: QuotaTokenTotals;
  tokensPerPercent: QuotaTokenTotals;
  effectiveTokensPer100Percent: number;
  modelIds: string[];
  modelNames: string[];
  reasoningEfforts: string[];
  projectIds: string[];
  observationLagMs: number;
  confidence: QuotaAnalyticsConfidence;
  confidenceReasons: string[];
  unattributed: boolean;
}

export interface QuotaPendingConsumption {
  accountId: string;
  providerId: string;
  bucketKey: string;
  resetWindowKey: string;
  sinceObservedAt: string;
  attemptCount: number;
  tokens: QuotaTokenTotals;
}

export interface QuotaValueStatistics {
  sampleCount: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

export type QuotaBreakdownDimension =
  | "provider"
  | "account"
  | "model"
  | "reasoningEffort"
  | "project"
  | "day"
  | "week"
  | "month"
  | "quotaWindow";

export interface QuotaAnalyticsBreakdown {
  dimension: QuotaBreakdownDimension;
  key: string;
  sampleCount: number;
  highConfidenceSamples: number;
  unattributedSamples: number;
  totals: QuotaTokenTotals;
  tokensPerPercent: QuotaValueStatistics;
  effectiveTokensPer100Percent: QuotaValueStatistics;
}

export interface QuotaPeriodComparison {
  current: QuotaValueStatistics;
  previous: QuotaValueStatistics;
  changePercent: number | null;
}

export interface QuotaTokenAnalytics {
  generatedAt: string;
  readings: Array<
    QuotaAnalyticsReading & {
      observedAt: Date;
      receivedAt: Date;
      resetsAt: Date | null;
    }
  >;
  intervals: QuotaAnalyticsInterval[];
  movementSamples: QuotaMovementSample[];
  pendingConsumption: QuotaPendingConsumption[];
  breakdowns: Record<QuotaBreakdownDimension, QuotaAnalyticsBreakdown[]>;
  rolling7Days: QuotaPeriodComparison;
  rolling30Days: QuotaPeriodComparison;
  monthOverMonth: QuotaPeriodComparison;
}

const ZERO_TOTALS: QuotaTokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  visibleOutputTokens: null,
  reportedTotalTokens: null,
  comparableTokens: 0,
};

function addTotals(
  attempts: readonly QuotaAnalyticsTokenAttempt[],
): QuotaTokenTotals {
  let visibleKnown = true;
  let reportedKnown = true;
  const totals = { ...ZERO_TOTALS };
  for (const attempt of attempts) {
    totals.inputTokens += attempt.inputTokens;
    totals.cachedInputTokens += attempt.cachedInputTokens;
    totals.cacheWriteInputTokens += attempt.cacheWriteInputTokens;
    totals.outputTokens += attempt.outputTokens;
    totals.reasoningOutputTokens += attempt.reasoningOutputTokens;
    totals.comparableTokens += attempt.inputTokens + attempt.outputTokens;
    if (attempt.visibleOutputTokens === null) visibleKnown = false;
    else
      totals.visibleOutputTokens =
        (totals.visibleOutputTokens ?? 0) + attempt.visibleOutputTokens;
    if (attempt.reportedTotalTokens === null) reportedKnown = false;
    else
      totals.reportedTotalTokens =
        (totals.reportedTotalTokens ?? 0) + attempt.reportedTotalTokens;
  }
  if (!visibleKnown) totals.visibleOutputTokens = null;
  if (!reportedKnown) totals.reportedTotalTokens = null;
  return totals;
}

function divideTotals(
  totals: QuotaTokenTotals,
  divisor: number,
): QuotaTokenTotals {
  const divide = (value: number): number => value / divisor;
  return {
    inputTokens: divide(totals.inputTokens),
    cachedInputTokens: divide(totals.cachedInputTokens),
    cacheWriteInputTokens: divide(totals.cacheWriteInputTokens),
    outputTokens: divide(totals.outputTokens),
    reasoningOutputTokens: divide(totals.reasoningOutputTokens),
    visibleOutputTokens:
      totals.visibleOutputTokens === null
        ? null
        : divide(totals.visibleOutputTokens),
    reportedTotalTokens:
      totals.reportedTotalTokens === null
        ? null
        : divide(totals.reportedTotalTokens),
    comparableTokens: divide(totals.comparableTokens),
  };
}

function readingBucket(reading: QuotaAnalyticsReading): string {
  return [
    reading.providerId,
    reading.providerAccountId,
    reading.limitId ?? reading.limitName ?? "unnamed",
    reading.windowKind,
    reading.windowDurationMinutes ?? "unknown-duration",
  ].join(":");
}

function resetWindow(reading: QuotaAnalyticsReading): string {
  return `${readingBucket(reading)}:${reading.resetsAt?.toISOString() ?? "unknown-reset"}`;
}

function attemptTime(attempt: QuotaAnalyticsTokenAttempt): number {
  return (
    attempt.finalizedAt ??
    attempt.completedAt ??
    attempt.startedAt
  ).getTime();
}

function attemptsBetween(
  attempts: readonly QuotaAnalyticsTokenAttempt[],
  accountId: string,
  after: Date,
  through: Date,
): QuotaAnalyticsTokenAttempt[] {
  const afterMs = after.getTime();
  const throughMs = through.getTime();
  return attempts.filter((attempt) => {
    const time = attemptTime(attempt);
    return (
      attempt.providerAccountId === accountId &&
      attempt.attemptStatus !== "running" &&
      time > afterMs &&
      time <= throughMs
    );
  });
}

function unique(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ].sort();
}

function sampleConfidence(
  attempts: readonly QuotaAnalyticsTokenAttempt[],
  tokens: QuotaTokenTotals,
  observationLagMs: number,
): { confidence: QuotaAnalyticsConfidence; reasons: string[] } {
  const reasons: string[] = [];
  if (tokens.comparableTokens === 0)
    reasons.push("meter-movement-without-tokens");
  if (unique(attempts.map((attempt) => attempt.modelId)).length > 1)
    reasons.push("multiple-models");
  if (unique(attempts.map((attempt) => attempt.reasoningEffort)).length > 1)
    reasons.push("multiple-reasoning-efforts");
  if (unique(attempts.map((attempt) => attempt.projectId)).length > 1)
    reasons.push("multiple-projects");
  if (observationLagMs > 5_000) reasons.push("delayed-observation");
  if (attempts.some((attempt) => attempt.attemptStatus !== "completed"))
    reasons.push("non-completed-attempts");
  return {
    confidence:
      tokens.comparableTokens === 0
        ? "low"
        : reasons.length === 0
          ? "high"
          : "medium",
    reasons,
  };
}

function quantile(sorted: readonly number[], value: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * value;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

export function quotaValueStatistics(
  values: readonly number[],
): QuotaValueStatistics {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    mean:
      sorted.length === 0
        ? null
        : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: quantile(sorted, 0.5),
    min: sorted[0] ?? null,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted.at(-1) ?? null,
  };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function weekKey(date: Date): string {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function breakdownKeys(
  sample: QuotaMovementSample,
): Record<QuotaBreakdownDimension, string> {
  const endedAt = new Date(sample.toObservedAt);
  return {
    provider: sample.providerId,
    account: sample.accountId,
    model:
      sample.modelIds.length === 1 ? sample.modelIds[0]! : "mixed-or-unknown",
    reasoningEffort:
      sample.reasoningEfforts.length === 1
        ? sample.reasoningEfforts[0]!
        : "mixed-or-default",
    project:
      sample.projectIds.length === 1 ? sample.projectIds[0]! : "mixed-or-none",
    day: dayKey(endedAt),
    week: weekKey(endedAt),
    month: monthKey(endedAt),
    quotaWindow: sample.resetWindowKey,
  };
}

function addTokenTotals(
  left: QuotaTokenTotals,
  right: QuotaTokenTotals,
): QuotaTokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    visibleOutputTokens:
      left.visibleOutputTokens === null || right.visibleOutputTokens === null
        ? null
        : left.visibleOutputTokens + right.visibleOutputTokens,
    reportedTotalTokens:
      left.reportedTotalTokens === null || right.reportedTotalTokens === null
        ? null
        : left.reportedTotalTokens + right.reportedTotalTokens,
    comparableTokens: left.comparableTokens + right.comparableTokens,
  };
}

function buildBreakdowns(
  samples: readonly QuotaMovementSample[],
): Record<QuotaBreakdownDimension, QuotaAnalyticsBreakdown[]> {
  const dimensions: QuotaBreakdownDimension[] = [
    "provider",
    "account",
    "model",
    "reasoningEffort",
    "project",
    "day",
    "week",
    "month",
    "quotaWindow",
  ];
  return Object.fromEntries(
    dimensions.map((dimension) => {
      const grouped = new Map<string, QuotaMovementSample[]>();
      for (const sample of samples) {
        const key = breakdownKeys(sample)[dimension];
        grouped.set(key, [...(grouped.get(key) ?? []), sample]);
      }
      return [
        dimension,
        [...grouped.entries()]
          .map(([key, entries]) => ({
            dimension,
            key,
            sampleCount: entries.length,
            highConfidenceSamples: entries.filter(
              ({ confidence }) => confidence === "high",
            ).length,
            unattributedSamples: entries.filter(
              ({ unattributed }) => unattributed,
            ).length,
            totals: entries
              .map(({ tokens }) => tokens)
              .reduce((totals, tokens) => addTokenTotals(totals, tokens)),
            tokensPerPercent: quotaValueStatistics(
              entries
                .filter(({ unattributed }) => !unattributed)
                .map(
                  ({ tokensPerPercent }) => tokensPerPercent.comparableTokens,
                ),
            ),
            effectiveTokensPer100Percent: quotaValueStatistics(
              entries
                .filter(({ unattributed }) => !unattributed)
                .map(
                  ({ effectiveTokensPer100Percent }) =>
                    effectiveTokensPer100Percent,
                ),
            ),
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      ];
    }),
  ) as Record<QuotaBreakdownDimension, QuotaAnalyticsBreakdown[]>;
}

function comparison(
  samples: readonly QuotaMovementSample[],
  currentStart: number,
  currentEnd: number,
  previousStart: number,
): QuotaPeriodComparison {
  const values = (from: number, through: number) =>
    samples
      .filter((sample) => {
        const time = new Date(sample.toObservedAt).getTime();
        return !sample.unattributed && time > from && time <= through;
      })
      .map(({ effectiveTokensPer100Percent }) => effectiveTokensPer100Percent);
  const current = quotaValueStatistics(values(currentStart, currentEnd));
  const previous = quotaValueStatistics(values(previousStart, currentStart));
  return {
    current,
    previous,
    changePercent:
      current.median === null ||
      previous.median === null ||
      previous.median === 0
        ? null
        : ((current.median - previous.median) / previous.median) * 100,
  };
}

export function deriveQuotaTokenAnalytics(
  readings: readonly QuotaAnalyticsReading[],
  attempts: readonly QuotaAnalyticsTokenAttempt[],
  now = new Date(),
): QuotaTokenAnalytics {
  const orderedReadings = [...readings].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );
  const groups = new Map<string, QuotaAnalyticsReading[]>();
  for (const reading of orderedReadings) {
    const key = resetWindow(reading);
    groups.set(key, [...(groups.get(key) ?? []), reading]);
  }

  const intervals: QuotaAnalyticsInterval[] = [];
  const movementSamples: QuotaMovementSample[] = [];
  const pendingConsumption: QuotaPendingConsumption[] = [];

  for (const [resetWindowKey, group] of groups) {
    if (group.length === 0) continue;
    let movementAnchor = group[0]!;
    let stationaryReadingCount = 0;
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!;
      const current = group[index]!;
      const delta = current.usedPercent - previous.usedPercent;
      const directAttempts = attemptsBetween(
        attempts,
        current.providerAccountId,
        previous.observedAt,
        current.observedAt,
      );
      const kind =
        delta < 0
          ? "rebaseline"
          : delta === 0
            ? "stationary"
            : directAttempts.length === 0
              ? "unattributed-movement"
              : "movement";
      intervals.push({
        accountId: current.providerAccountId,
        providerId: current.providerId,
        bucketKey: readingBucket(current),
        resetWindowKey,
        fromReadingId: previous.id,
        toReadingId: current.id,
        fromObservedAt: previous.observedAt.toISOString(),
        toObservedAt: current.observedAt.toISOString(),
        usedPercentBefore: previous.usedPercent,
        usedPercentAfter: current.usedPercent,
        usedPercentDelta: delta,
        kind,
        intervalTokens: addTotals(directAttempts),
        attemptCount: directAttempts.length,
      });
      if (delta === 0) {
        stationaryReadingCount += 1;
        continue;
      }
      if (delta < 0) {
        movementAnchor = current;
        stationaryReadingCount = 0;
        continue;
      }
      const accumulatedAttempts = attemptsBetween(
        attempts,
        current.providerAccountId,
        movementAnchor.observedAt,
        current.observedAt,
      );
      const tokens = addTotals(accumulatedAttempts);
      const observationLagMs = Math.max(
        0,
        current.receivedAt.getTime() - current.observedAt.getTime(),
      );
      const confidence = sampleConfidence(
        accumulatedAttempts,
        tokens,
        observationLagMs,
      );
      const tokensPerPercent = divideTotals(tokens, delta);
      movementSamples.push({
        accountId: current.providerAccountId,
        providerId: current.providerId,
        bucketKey: readingBucket(current),
        resetWindowKey,
        fromObservedAt: movementAnchor.observedAt.toISOString(),
        toObservedAt: current.observedAt.toISOString(),
        usedPercentDelta: delta,
        stationaryReadingCount,
        attemptCount: accumulatedAttempts.length,
        tokens,
        tokensPerPercent,
        effectiveTokensPer100Percent: tokensPerPercent.comparableTokens * 100,
        modelIds: unique(accumulatedAttempts.map((attempt) => attempt.modelId)),
        modelNames: unique(
          accumulatedAttempts.map((attempt) => attempt.modelName),
        ),
        reasoningEfforts: unique(
          accumulatedAttempts.map((attempt) => attempt.reasoningEffort),
        ),
        projectIds: unique(
          accumulatedAttempts.map((attempt) => attempt.projectId),
        ),
        observationLagMs,
        confidence: confidence.confidence,
        confidenceReasons: confidence.reasons,
        unattributed: tokens.comparableTokens === 0,
      });
      movementAnchor = current;
      stationaryReadingCount = 0;
    }
    const lastReading = group.at(-1)!;
    const pendingAttempts = attemptsBetween(
      attempts,
      lastReading.providerAccountId,
      movementAnchor.observedAt,
      now,
    );
    const pendingTokens = addTotals(pendingAttempts);
    if (pendingTokens.comparableTokens > 0) {
      pendingConsumption.push({
        accountId: lastReading.providerAccountId,
        providerId: lastReading.providerId,
        bucketKey: readingBucket(lastReading),
        resetWindowKey,
        sinceObservedAt: movementAnchor.observedAt.toISOString(),
        attemptCount: pendingAttempts.length,
        tokens: pendingTokens,
      });
    }
  }

  const nowMs = now.getTime();
  const dayMs = 86_400_000;
  const currentMonthStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    1,
  );
  const previousMonthStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - 1,
    1,
  );
  return {
    generatedAt: now.toISOString(),
    readings: orderedReadings,
    intervals,
    movementSamples,
    pendingConsumption,
    breakdowns: buildBreakdowns(movementSamples),
    rolling7Days: comparison(
      movementSamples,
      nowMs - 7 * dayMs,
      nowMs,
      nowMs - 14 * dayMs,
    ),
    rolling30Days: comparison(
      movementSamples,
      nowMs - 30 * dayMs,
      nowMs,
      nowMs - 60 * dayMs,
    ),
    monthOverMonth: comparison(
      movementSamples,
      currentMonthStart,
      nowMs,
      previousMonthStart,
    ),
  };
}
