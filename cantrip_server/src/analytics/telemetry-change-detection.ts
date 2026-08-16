import type { QuotaMovementSample } from "./quota-token.js";
import type { TelemetryBehaviorRow } from "./telemetry-dashboard.js";

export type TelemetryChangeMetric =
  | "tokens-per-percent"
  | "effective-weekly-allowance"
  | "failure-rate"
  | "tool-error-rate"
  | "latency"
  | "compaction-frequency"
  | "completion-rate"
  | "output-reasoning-mix";

export type TelemetryChangeScope = "account" | "model" | "account-model";

export interface TelemetryChangePoint {
  id: string;
  metric: TelemetryChangeMetric;
  scope: TelemetryChangeScope;
  providerAccountId: string | null;
  modelId: string | null;
  detectedAt: string;
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  beforeValue: number;
  afterValue: number;
  relativeChangePercent: number | null;
  beforeSampleCount: number;
  afterSampleCount: number;
  confidence: "high" | "medium";
  direction: "increased" | "decreased";
  impact: "improvement" | "degradation" | "neutral";
  unit: "tokens" | "ratio" | "milliseconds";
}

export interface ChangeDetectionBehaviorRow extends TelemetryBehaviorRow {
  providerAccountId: string | null;
  modelId: string | null;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface MetricPoint {
  at: Date;
  value: number;
  reliable: boolean;
}

interface MetricSpec {
  metric: TelemetryChangeMetric;
  unit: TelemetryChangePoint["unit"];
  minSamples: number;
  highConfidenceSamples: number;
  relativeThreshold: number;
  absoluteThreshold: number;
  aggregate: "mean" | "median";
  increasedImpact: TelemetryChangePoint["impact"];
}

interface ScopeIdentity {
  scope: TelemetryChangeScope;
  providerAccountId: string | null;
  modelId: string | null;
}

const MAX_SIDE_SAMPLES = 40;

const specs: Record<TelemetryChangeMetric, MetricSpec> = {
  "tokens-per-percent": {
    metric: "tokens-per-percent",
    unit: "tokens",
    minSamples: 5,
    highConfidenceSamples: 10,
    relativeThreshold: 0.25,
    absoluteThreshold: 0,
    aggregate: "median",
    increasedImpact: "improvement",
  },
  "effective-weekly-allowance": {
    metric: "effective-weekly-allowance",
    unit: "tokens",
    minSamples: 5,
    highConfidenceSamples: 10,
    relativeThreshold: 0.25,
    absoluteThreshold: 0,
    aggregate: "median",
    increasedImpact: "improvement",
  },
  "failure-rate": {
    metric: "failure-rate",
    unit: "ratio",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.4,
    absoluteThreshold: 0.1,
    aggregate: "mean",
    increasedImpact: "degradation",
  },
  "tool-error-rate": {
    metric: "tool-error-rate",
    unit: "ratio",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.4,
    absoluteThreshold: 0.1,
    aggregate: "mean",
    increasedImpact: "degradation",
  },
  latency: {
    metric: "latency",
    unit: "milliseconds",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.3,
    absoluteThreshold: 500,
    aggregate: "median",
    increasedImpact: "degradation",
  },
  "compaction-frequency": {
    metric: "compaction-frequency",
    unit: "ratio",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.5,
    absoluteThreshold: 0.12,
    aggregate: "mean",
    increasedImpact: "degradation",
  },
  "completion-rate": {
    metric: "completion-rate",
    unit: "ratio",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.25,
    absoluteThreshold: 0.1,
    aggregate: "mean",
    increasedImpact: "improvement",
  },
  "output-reasoning-mix": {
    metric: "output-reasoning-mix",
    unit: "ratio",
    minSamples: 8,
    highConfidenceSamples: 16,
    relativeThreshold: 0.35,
    absoluteThreshold: 0.12,
    aggregate: "median",
    increasedImpact: "neutral",
  },
};

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function aggregate(
  points: readonly MetricPoint[],
  kind: MetricSpec["aggregate"],
): number {
  if (kind === "median") return median(points.map(({ value }) => value));
  return points.reduce((sum, { value }) => sum + value, 0) / points.length;
}

function relativeChange(before: number, after: number): number | null {
  if (Math.abs(before) < Number.EPSILON) return after === 0 ? 0 : null;
  return ((after - before) / Math.abs(before)) * 100;
}

function changeImpact(
  spec: MetricSpec,
  direction: TelemetryChangePoint["direction"],
): TelemetryChangePoint["impact"] {
  if (spec.increasedImpact === "neutral") return "neutral";
  if (direction === "increased") return spec.increasedImpact;
  return spec.increasedImpact === "improvement" ? "degradation" : "improvement";
}

function detectOne(
  identity: ScopeIdentity,
  points: readonly MetricPoint[],
  spec: MetricSpec,
): TelemetryChangePoint | null {
  const ordered = points
    .filter(({ value }) => Number.isFinite(value))
    .slice()
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  if (ordered.length < spec.minSamples * 2) return null;

  let best:
    | {
        split: number;
        before: MetricPoint[];
        after: MetricPoint[];
        beforeValue: number;
        afterValue: number;
        relativeMagnitude: number;
        thresholdStrength: number;
        score: number;
      }
    | undefined;
  for (
    let split = spec.minSamples;
    split <= ordered.length - spec.minSamples;
    split += 1
  ) {
    const before = ordered.slice(Math.max(0, split - MAX_SIDE_SAMPLES), split);
    const after = ordered.slice(
      split,
      Math.min(ordered.length, split + MAX_SIDE_SAMPLES),
    );
    const beforeValue = aggregate(before, spec.aggregate);
    const afterValue = aggregate(after, spec.aggregate);
    const absoluteDelta = Math.abs(afterValue - beforeValue);
    const relativeMagnitude =
      Math.abs(beforeValue) < Number.EPSILON
        ? afterValue === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : absoluteDelta / Math.abs(beforeValue);
    const passesAbsolute = absoluteDelta >= spec.absoluteThreshold;
    const passesRelative = relativeMagnitude >= spec.relativeThreshold;
    if (!passesAbsolute || !passesRelative) continue;

    const relativeStrength = Number.isFinite(relativeMagnitude)
      ? relativeMagnitude / spec.relativeThreshold
      : 2;
    const absoluteStrength = spec.absoluteThreshold
      ? absoluteDelta / spec.absoluteThreshold
      : relativeStrength;
    const balance =
      Math.min(before.length, after.length) /
      Math.max(before.length, after.length);
    const reliability =
      [...before, ...after].filter(({ reliable }) => reliable).length /
      (before.length + after.length);
    const thresholdStrength = Math.min(relativeStrength, absoluteStrength);
    const score = thresholdStrength * balance * (0.75 + reliability * 0.25);
    if (!best || score > best.score) {
      best = {
        split,
        before,
        after,
        beforeValue,
        afterValue,
        relativeMagnitude,
        thresholdStrength,
        score,
      };
    }
  }
  if (!best) return null;

  const direction =
    best.afterValue >= best.beforeValue ? "increased" : "decreased";
  const reliableShare =
    [...best.before, ...best.after].filter(({ reliable }) => reliable).length /
    (best.before.length + best.after.length);
  const confidence =
    Math.min(best.before.length, best.after.length) >=
      spec.highConfidenceSamples &&
    best.thresholdStrength >= 1.5 &&
    reliableShare >= 0.75
      ? "high"
      : "medium";
  const detectedAt = ordered[best.split]!.at.toISOString();
  const scopeKey = [identity.providerAccountId, identity.modelId]
    .filter(Boolean)
    .join(":");
  return {
    id: `${spec.metric}:${identity.scope}:${scopeKey}:${detectedAt}`,
    metric: spec.metric,
    scope: identity.scope,
    providerAccountId: identity.providerAccountId,
    modelId: identity.modelId,
    detectedAt,
    beforeStart: best.before[0]!.at.toISOString(),
    beforeEnd: best.before.at(-1)!.at.toISOString(),
    afterStart: best.after[0]!.at.toISOString(),
    afterEnd: best.after.at(-1)!.at.toISOString(),
    beforeValue: best.beforeValue,
    afterValue: best.afterValue,
    relativeChangePercent: relativeChange(best.beforeValue, best.afterValue),
    beforeSampleCount: best.before.length,
    afterSampleCount: best.after.length,
    confidence,
    direction,
    impact: changeImpact(spec, direction),
    unit: spec.unit,
  };
}

function groupByScope<Row>(
  rows: readonly Row[],
  accountFor: (row: Row) => string | null,
  modelFor: (row: Row) => string | null,
): Array<{ identity: ScopeIdentity; rows: Row[] }> {
  const grouped = new Map<string, { identity: ScopeIdentity; rows: Row[] }>();
  const add = (identity: ScopeIdentity, row: Row) => {
    const key = `${identity.scope}:${identity.providerAccountId ?? ""}:${identity.modelId ?? ""}`;
    const existing = grouped.get(key) ?? { identity, rows: [] };
    existing.rows.push(row);
    grouped.set(key, existing);
  };
  for (const row of rows) {
    const accountId = accountFor(row);
    const modelId = modelFor(row);
    if (accountId) {
      add(
        { scope: "account", providerAccountId: accountId, modelId: null },
        row,
      );
    }
    if (modelId) {
      add({ scope: "model", providerAccountId: null, modelId }, row);
    }
    if (accountId && modelId) {
      add(
        { scope: "account-model", providerAccountId: accountId, modelId },
        row,
      );
    }
  }
  return [...grouped.values()];
}

function behaviorPoints(
  rows: readonly ChangeDetectionBehaviorRow[],
  metric: TelemetryChangeMetric,
): MetricPoint[] {
  return rows.flatMap((row): MetricPoint[] => {
    const terminal = row.attemptStatus !== "running";
    if (!terminal) return [];
    let value: number | null = null;
    switch (metric) {
      case "failure-rate":
        value = row.attemptStatus === "failed" ? 1 : 0;
        break;
      case "tool-error-rate":
        value = row.toolCallCount
          ? row.invalidToolCallCount / row.toolCallCount
          : null;
        break;
      case "latency":
        value = row.durationMs;
        break;
      case "compaction-frequency":
        value = row.compactionCount;
        break;
      case "completion-rate":
        value = row.attemptStatus === "completed" ? 1 : 0;
        break;
      case "output-reasoning-mix":
        value = row.outputTokens
          ? row.reasoningOutputTokens / row.outputTokens
          : null;
        break;
      default:
        break;
    }
    return value === null || !Number.isFinite(value)
      ? []
      : [{ at: row.startedAt, value, reliable: terminal }];
  });
}

function isWeeklyQuotaSample(sample: QuotaMovementSample): boolean {
  return /(^|:)(weekly|week|7d|10080)(:|$)/iu.test(sample.bucketKey);
}

export function detectTelemetryChanges(
  quotaSamples: readonly QuotaMovementSample[],
  behaviorRows: readonly ChangeDetectionBehaviorRow[],
): TelemetryChangePoint[] {
  const changes: TelemetryChangePoint[] = [];
  const eligibleQuota = quotaSamples.filter(
    ({ unattributed }) => !unattributed,
  );
  for (const group of groupByScope(
    eligibleQuota,
    (sample) => sample.accountId,
    (sample) => (sample.modelIds.length === 1 ? sample.modelIds[0]! : null),
  )) {
    const tokenPoints = group.rows.map((sample) => ({
      at: new Date(sample.toObservedAt),
      value: sample.tokensPerPercent.comparableTokens,
      reliable: sample.confidence === "high",
    }));
    const tokensChange = detectOne(
      group.identity,
      tokenPoints,
      specs["tokens-per-percent"],
    );
    if (tokensChange) changes.push(tokensChange);

    const weeklyPoints = group.rows
      .filter(isWeeklyQuotaSample)
      .map((sample) => ({
        at: new Date(sample.toObservedAt),
        value: sample.effectiveTokensPer100Percent,
        reliable: sample.confidence === "high",
      }));
    const allowanceChange = detectOne(
      group.identity,
      weeklyPoints,
      specs["effective-weekly-allowance"],
    );
    if (allowanceChange) changes.push(allowanceChange);
  }

  const behaviorMetrics: TelemetryChangeMetric[] = [
    "failure-rate",
    "tool-error-rate",
    "latency",
    "compaction-frequency",
    "completion-rate",
    "output-reasoning-mix",
  ];
  for (const group of groupByScope(
    behaviorRows,
    (row) => row.providerAccountId,
    (row) => row.modelId,
  )) {
    for (const metric of behaviorMetrics) {
      const change = detectOne(
        group.identity,
        behaviorPoints(group.rows, metric),
        specs[metric],
      );
      if (change) changes.push(change);
    }
  }

  return changes
    .sort((left, right) => {
      if (left.confidence !== right.confidence)
        return left.confidence === "high" ? -1 : 1;
      return right.detectedAt.localeCompare(left.detectedAt);
    })
    .slice(0, 100);
}
