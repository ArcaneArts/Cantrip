import {
  MODEL_OPERATION_USAGE_METRICS,
  modelOperationUsageSchema,
  type ModelOperationUsage,
  type ModelOperationUsageMetric,
} from "@cantrip/protocol";

type Counters = Partial<Record<ModelOperationUsageMetric, unknown>>;
type RequestStatus = "succeeded" | "failed" | "cancelled";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Extract only documented counter fields. Missing or invalid counts stay unknown. */
export function reportedModelOperationUsage(
  raw: Record<string, unknown>,
  operation: "embedding" | "decision",
): Counters {
  const usage = object(raw.usage);
  const input = object(
    usage.input_tokens_details ?? usage.prompt_tokens_details,
  );
  const output = object(
    usage.output_tokens_details ?? usage.completion_tokens_details,
  );
  return {
    inputTokens:
      operation === "embedding"
        ? (usage.prompt_tokens ??
          usage.input_tokens ??
          raw.prompt_eval_count ??
          object(object(raw.meta).billed_units).input_tokens)
        : (usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: usage.output_tokens ?? usage.completion_tokens,
    totalTokens:
      usage.total_tokens ??
      (operation === "embedding" ? raw.prompt_eval_count : undefined),
    cachedInputTokens: input.cached_tokens,
    cacheWriteInputTokens: input.cache_write_tokens,
    reasoningOutputTokens: output.reasoning_tokens,
  };
}

export class ModelOperationUsageCollector {
  private requests = 0;
  private succeededRequests = 0;
  private failedRequests = 0;
  private cancelledRequests = 0;
  private startedAt: string | null = null;
  private durationMs = 0;
  private observedTotalTokens: number | null = null;
  private observedTotalOverflowed = false;
  private readonly metrics: ModelOperationUsage["metrics"] = {
    inputTokens: { observed: null, reportedRequests: 0, overflowed: false },
    outputTokens: { observed: null, reportedRequests: 0, overflowed: false },
    totalTokens: { observed: null, reportedRequests: 0, overflowed: false },
    cachedInputTokens: {
      observed: null,
      reportedRequests: 0,
      overflowed: false,
    },
    cacheWriteInputTokens: {
      observed: null,
      reportedRequests: 0,
      overflowed: false,
    },
    reasoningOutputTokens: {
      observed: null,
      reportedRequests: 0,
      overflowed: false,
    },
  };
  constructor(
    private readonly identity: Pick<
      ModelOperationUsage,
      "operation" | "modelId" | "routeId" | "providerId" | "workerVersion"
    >,
  ) {}

  begin() {
    this.requests++;
    this.startedAt ??= new Date().toISOString();
    const began = performance.now();
    let counters: Counters = {};
    let ended = false;
    return {
      report: (usage: Counters) => {
        counters = usage;
      },
      end: (status: RequestStatus) => {
        if (ended) return;
        ended = true;
        this.durationMs += Math.max(0, performance.now() - began);
        if (status === "succeeded") this.succeededRequests++;
        else if (status === "cancelled") this.cancelledRequests++;
        else this.failedRequests++;
        const known = (value: unknown): number | null =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0
            ? value
            : null;
        const input = known(counters.inputTokens),
          output = known(counters.outputTokens);
        const total =
          known(counters.totalTokens) ??
          (input !== null || output !== null
            ? (input ?? 0) + (output ?? 0)
            : null);
        if (total !== null && !this.observedTotalOverflowed) {
          const sum = (this.observedTotalTokens ?? 0) + total;
          if (Number.isSafeInteger(sum)) this.observedTotalTokens = sum;
          else {
            this.observedTotalTokens = null;
            this.observedTotalOverflowed = true;
          }
        }
        for (const name of MODEL_OPERATION_USAGE_METRICS) {
          const value = counters[name];
          if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            continue;
          const metric = this.metrics[name];
          metric.reportedRequests++;
          if (metric.overflowed) continue;
          const sum = (metric.observed ?? 0) + value;
          if (Number.isSafeInteger(sum)) metric.observed = sum;
          else {
            metric.observed = null;
            metric.overflowed = true;
          }
        }
      },
    };
  }
  finish(status: ModelOperationUsage["status"]): ModelOperationUsage {
    return modelOperationUsageSchema.parse({
      ...this.identity,
      status,
      requests: this.requests,
      succeededRequests: this.succeededRequests,
      failedRequests: this.failedRequests,
      cancelledRequests: this.cancelledRequests,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: this.durationMs,
      observedTotalTokens: this.observedTotalTokens,
      observedTotalOverflowed: this.observedTotalOverflowed,
      metrics: this.metrics,
    });
  }
}

/** Observation never performs I/O or holds capacity beyond HTTP teardown. */
export async function observeModelOperationRequest<T>(
  collector: ModelOperationUsageCollector | undefined,
  signal: AbortSignal,
  execute: (report: (usage: Counters) => void) => Promise<T>,
): Promise<T> {
  const observation = collector?.begin();
  let status: RequestStatus = "failed";
  try {
    const result = await execute(observation?.report ?? (() => {}));
    status = "succeeded";
    return result;
  } catch (error) {
    if (
      signal.aborted &&
      !(signal.reason instanceof Error && signal.reason.name === "TimeoutError")
    )
      status = "cancelled";
    throw error;
  } finally {
    observation?.end(status);
  }
}
