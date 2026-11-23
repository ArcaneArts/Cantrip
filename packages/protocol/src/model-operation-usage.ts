import { z } from "zod";

export const MODEL_OPERATION_USAGE_METRICS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;
const count = z.number().int().nonnegative();
const metric = z
  .object({
    observed: count.nullable(),
    reportedRequests: count.max(4096),
    overflowed: z.boolean(),
  })
  .strict();
/** Counts only, never input, output, vectors, credentials, or provider errors. */
export const modelOperationUsageSchema = z
  .object({
    operation: z.enum(["embedding", "decision"]),
    modelId: z.string().min(1).max(1000),
    routeId: z.string().min(1).max(1000),
    providerId: z.string().min(1).max(1000),
    workerVersion: z.string().max(160).nullable(),
    status: z.enum(["completed", "failed", "cancelled"]),
    requests: count.max(4096),
    succeededRequests: count.max(4096),
    failedRequests: count.max(4096),
    cancelledRequests: count.max(4096),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime(),
    // Measured HTTP time, excluding admission waits and response encryption.
    durationMs: z.number().finite().nonnegative(),
    // Per HTTP request, prefer its reported total; otherwise include only
    // reported input/output counts. This preserves disjoint partial reports.
    observedTotalTokens: count.nullable(),
    observedTotalOverflowed: z.boolean(),
    metrics: z
      .object({
        inputTokens: metric,
        outputTokens: metric,
        totalTokens: metric,
        cachedInputTokens: metric,
        cacheWriteInputTokens: metric,
        reasoningOutputTokens: metric,
      })
      .strict(),
  })
  .strict();
export type ModelOperationUsage = z.infer<typeof modelOperationUsageSchema>;
export type ModelOperationUsageMetric =
  (typeof MODEL_OPERATION_USAGE_METRICS)[number];
export const modelOperationUsageIdentitySchema = modelOperationUsageSchema
  .pick({
    operation: true,
    modelId: true,
    routeId: true,
    providerId: true,
  })
  .extend({
    serverId: z.string().min(1).max(2000),
    workerId: z.string().min(1).max(255),
    operationId: z.uuid(),
  })
  .strict();
export type ModelOperationUsageIdentity = z.infer<
  typeof modelOperationUsageIdentitySchema
>;
export const modelOperationUsageEvidenceSchema = z
  .object({
    identity: modelOperationUsageIdentitySchema,
    receipt: modelOperationUsageSchema.nullable(),
    transportStatus: z.enum(["running", "replied", "unavailable"]),
  })
  .strict();
export type ModelOperationUsageEvidence = z.infer<
  typeof modelOperationUsageEvidenceSchema
>;
export function modelOperationUsageFitsIdentity(
  usage: ModelOperationUsage,
  identity: ModelOperationUsageIdentity,
): boolean {
  return (
    modelOperationUsageConsistent(usage) &&
    (["operation", "modelId", "routeId", "providerId"] as const).every(
      (key) => usage[key] === identity[key],
    )
  );
}
export const modelOperationUsageCoverageSchema = z.object({
  attemptCount: count,
  reportedAttemptCount: count,
  observedRequestCount: count,
  incompleteUsageCount: count,
});

export function modelOperationUsageCoverage(
  rows: readonly {
    attemptKind: string;
    modelOperationUsage?: ModelOperationUsageEvidence | null;
  }[],
) {
  const direct = rows.filter(
    (row) => row.attemptKind === "embedding" || row.attemptKind === "decision",
  );
  return {
    attemptCount: direct.length,
    reportedAttemptCount: direct.filter(
      (row) => row.modelOperationUsage?.receipt,
    ).length,
    observedRequestCount: direct.reduce(
      (sum, row) => sum + (row.modelOperationUsage?.receipt?.requests ?? 0),
      0,
    ),
    incompleteUsageCount: direct.filter((row) =>
      modelOperationUsageIncomplete(row.modelOperationUsage?.receipt),
    ).length,
  };
}

export function modelOperationUsageConsistent(
  usage: ModelOperationUsage,
): boolean {
  const hasReportedTokens = (
    ["inputTokens", "outputTokens", "totalTokens"] as const
  ).some((name) => usage.metrics[name].reportedRequests > 0);
  return (
    usage.requests ===
      usage.succeededRequests +
        usage.failedRequests +
        usage.cancelledRequests &&
    (usage.requests === 0) === (usage.startedAt === null) &&
    (usage.observedTotalTokens !== null
      ? hasReportedTokens && !usage.observedTotalOverflowed
      : usage.observedTotalOverflowed === hasReportedTokens) &&
    MODEL_OPERATION_USAGE_METRICS.every((name) => {
      const metric = usage.metrics[name];
      return (
        metric.reportedRequests <= usage.requests &&
        (metric.reportedRequests === 0
          ? metric.observed === null && !metric.overflowed
          : (metric.observed === null) === metric.overflowed)
      );
    })
  );
}

export function modelOperationUsageIncomplete(
  usage: ModelOperationUsage | null | undefined,
): boolean {
  if (!usage) return true;
  if (!usage.requests) return false;
  const required =
    usage.operation === "embedding"
      ? (["inputTokens", "totalTokens"] as const)
      : (["inputTokens", "outputTokens", "totalTokens"] as const);
  return required.some(
    (name) =>
      usage.metrics[name].observed === null ||
      usage.metrics[name].reportedRequests !== usage.requests,
  );
}

export function observedModelTokenTotal(row: {
  inputTokens: number;
  outputTokens: number;
  modelOperationUsage?: ModelOperationUsageEvidence | null;
}): number {
  const receipt = row.modelOperationUsage?.receipt;
  return receipt
    ? (receipt.observedTotalTokens ?? 0)
    : row.inputTokens + row.outputTokens;
}
