import { z } from "zod";

export const DEFAULT_MAX_CONCURRENT_INFERENCE = 8;

// Match PostgreSQL's integer storage rather than accepting an unrepresentable setting.
export const providerInferenceLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);
export const providerInferenceRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647);

export const providerInferenceConfigurationSchema = z.object({
  providerId: z.string().min(1),
  maxConcurrentInference: providerInferenceLimitSchema.default(
    DEFAULT_MAX_CONCURRENT_INFERENCE,
  ),
  inferenceConfigRevision: providerInferenceRevisionSchema.default(0),
  inferenceCatalogCreatedRevision: providerInferenceRevisionSchema.default(0),
});

export const providerInferenceCatalogSchema = z.object({
  catalogRevision: providerInferenceRevisionSchema,
  configurations: z.array(providerInferenceConfigurationSchema).max(10_000),
});

export type ProviderInferenceCatalog = z.infer<
  typeof providerInferenceCatalogSchema
>;

export const inferenceTicketStateSchema = z.enum([
  "waiting",
  "granted",
  "running",
  "cancelling",
  "suspended",
  "released",
]);

// These monotonic durations describe observation in the current worker generation.
// Wall-clock timestamps and total elapsed retain their existing meaning.
export const inferenceTimingSchema = z.object({
  queueWaitMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reservedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  executionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  suspendedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** Exclusive command phases measured by the worker's monotonic clock.
 * Execution includes the admitted turn's ordinary tool round trips. A complete
 * sample ends at command settlement; it is not proof of native settlement. */
export const inferenceCommandTimingSchema = z
  .object({
    queueWaitMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    preparationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    executionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    suspendedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    complete: z.boolean(),
  })
  .strict();
export type InferenceCommandTiming = z.infer<
  typeof inferenceCommandTimingSchema
>;

/** Provider-local timing, never attributed by display name or account. */
export const inferenceProviderCommandTimingSchema = z
  .object({
    providerId: z.string().min(1),
    timing: inferenceCommandTimingSchema,
  })
  .strict();
export type InferenceProviderCommandTiming = z.infer<
  typeof inferenceProviderCommandTimingSchema
>;

export const inferenceOperationStatusSchema = z.object({
  purpose: z.enum(["turn", "label", "child", "helper"]).default("helper"),
  operationId: z.string().min(1),
  runtimeGeneration: z.string().min(1),
  providerId: z.string().min(1),
  chatId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable(),
  // Recovery preparation owns no provider slot and has no queue position.
  state: z.union([inferenceTicketStateSchema, z.literal("recovering")]),
  queuePosition: z.number().int().positive().nullable(),
  enqueuedAt: z.number().int().nonnegative(),
  grantedAt: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
  timing: inferenceTimingSchema.optional(),
});

export const inferencePoolStatusSchema =
  providerInferenceConfigurationSchema.extend({
    activeCount: z.number().int().nonnegative(),
    queuedCount: z.number().int().nonnegative(),
    operations: z.array(inferenceOperationStatusSchema),
  });

export const workerInferenceStatusSchema = z.object({
  serverId: z.string().min(1),
  ownerId: z.string().min(1),
  workerId: z.string().min(1),
  workerGeneration: z.string().min(1),
  revision: z.number().int().nonnegative(),
  providerCatalogRevision: providerInferenceRevisionSchema.optional(),
  pools: z.array(inferencePoolStatusSchema),
});

export type ProviderInferenceConfiguration = z.infer<
  typeof providerInferenceConfigurationSchema
>;
export type InferenceTicketState = z.infer<typeof inferenceTicketStateSchema>;
export type InferenceTiming = z.infer<typeof inferenceTimingSchema>;
export type InferenceOperationStatus = z.infer<
  typeof inferenceOperationStatusSchema
>;
export type InferencePoolStatus = z.infer<typeof inferencePoolStatusSchema>;
export type WorkerInferenceStatus = z.infer<typeof workerInferenceStatusSchema>;
