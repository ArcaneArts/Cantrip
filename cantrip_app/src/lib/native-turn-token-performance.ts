import {
  nativeHistoryUsageSchema,
  reconcileNativeHistoryUsage,
  type AgentActivity,
  type NativeHistoryUsage,
} from "@cantrip/protocol";

export type TurnTokenPerformance = NonNullable<
  Extract<AgentActivity, { type: "turnSummary" }>["tokenPerformance"]
>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

function unionDuration(intervals: [number, number][]): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let duration = 0;
  let end = 0;
  for (const [start, nextEnd] of intervals) {
    duration += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return duration;
}

/** Called only after the archive and its public usage header are authenticated.
 * Never treat a thread/context snapshot's latest response as a whole turn. */
export function nativeTurnTokenPerformance(input: {
  source: unknown;
  threadId: string;
  turnId: string;
  usage?: NativeHistoryUsage;
}): TurnTokenPerformance | undefined {
  const { source } = input;
  if (!object(source)) return undefined;
  const reduced =
    source.version === 2 && object(source.reducedTurn)
      ? source.reducedTurn
      : null;
  const turn =
    reduced && object(reduced.body)
      ? reduced.body
      : source.version === 1 && object(source.nativeTurn)
        ? source.nativeTurn
        : null;
  const metadata = reduced?.metadata ?? source.history;
  if (!turn || turn.id !== input.turnId) return undefined;
  let usage = input.usage;
  if (
    !usage &&
    object(metadata) &&
    object(metadata.usage) &&
    Array.isArray(metadata.usage.responses)
  ) {
    const responses = metadata.usage.responses.filter(
      (entry) => object(entry) && entry.threadId === input.threadId,
    );
    if (metadata.usage.responses.length && !responses.length) return undefined;
    const responseIds = new Set(responses.map((entry) => entry.responseId));
    const parsed = nativeHistoryUsageSchema.safeParse({
      version: 1,
      responses: responses.map((entry) => ({
        responseId: entry.responseId,
        usage: entry.usage,
      })),
      complete: metadata.retention === "complete",
      conflictingResponseIds: Array.isArray(
        metadata.usage.conflictingResponseIds,
      )
        ? metadata.usage.conflictingResponseIds.filter((id) =>
            responseIds.has(id),
          )
        : undefined,
    });
    if (parsed.success) usage = parsed.data;
  }
  if (!usage?.complete || usage.conflictingResponseIds.length) return undefined;
  const { totals, evidence } = reconcileNativeHistoryUsage(undefined, usage);
  if (!totals || !evidence.complete) return undefined;

  const items = reduced?.items ?? (object(metadata) ? metadata.items : null);
  const intervals: [number, number][] = [];
  let timingComplete = Array.isArray(items);
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!object(item)) {
        timingComplete = false;
        continue;
      }
      // v1 item timing evidence refers to the corresponding native item body.
      const body = object(item.body)
        ? item.body
        : Array.isArray(turn.items)
          ? turn.items.find(
              (candidate) => object(candidate) && candidate.id === item.itemId,
            )
          : null;
      if (!object(body)) {
        timingComplete = false;
        continue;
      }
      if (!["reasoning", "agentMessage"].includes(String(body.type))) continue;
      const start = time(item.startedAtMs);
      const end = time(item.completedAtMs);
      if (
        start === null ||
        end === null ||
        end < start ||
        (Array.isArray(item.conflicts) && item.conflicts.length)
      ) {
        timingComplete = false;
      } else intervals.push([start, end]);
    }
  }
  const startedAt = time(turn.startedAt);
  const completedAt = time(turn.completedAt);
  const durationMs =
    time(turn.durationMs) ??
    (startedAt !== null && completedAt !== null && completedAt >= startedAt
      ? (completedAt - startedAt) * 1000
      : null);
  const outputDurationMs =
    timingComplete && intervals.length ? unionDuration(intervals) : null;
  return {
    totalTokens: totals.totalTokens,
    outputTokens: totals.outputTokens,
    durationMs,
    outputDurationMs:
      outputDurationMs !== null &&
      outputDurationMs > 0 &&
      (durationMs === null || outputDurationMs <= durationMs)
        ? outputDurationMs
        : null,
  };
}

export function turnTokenRates(
  performance: TurnTokenPerformance | undefined,
  elapsedMs: number | null,
) {
  const rate = (duration: number | null) =>
    performance &&
    duration !== null &&
    Number.isFinite(duration) &&
    duration > 0
      ? (performance.outputTokens * 1000) / duration
      : null;
  return {
    output: rate(performance?.outputDurationMs ?? null),
    real: rate(elapsedMs),
  };
}

export function mergeTurnTokenPerformance(
  samples: readonly TurnTokenPerformance[],
): TurnTokenPerformance | undefined {
  const first = samples[0];
  if (
    !first ||
    samples.some(
      (sample) =>
        sample.outputTokens !== first.outputTokens ||
        sample.totalTokens !== first.totalTokens,
    )
  )
    return undefined;
  const knownDuration = (field: "durationMs" | "outputDurationMs") => {
    const values = new Set(
      samples.flatMap((sample) =>
        sample[field] === null ? [] : [sample[field]],
      ),
    );
    return values.size === 1 ? [...values][0]! : null;
  };
  return {
    ...first,
    durationMs: knownDuration("durationMs"),
    outputDurationMs: knownDuration("outputDurationMs"),
  };
}

export function formatTokenRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return "—";
  if (rate > 0 && rate < 0.1) return "<0.1 tok/s";
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })} tok/s`;
}
