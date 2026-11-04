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
});

export const inferenceTicketStateSchema = z.enum([
  "waiting",
  "granted",
  "running",
  "cancelling",
  "suspended",
  "released",
]);

export const inferenceOperationStatusSchema = z.object({
  operationId: z.string().min(1),
  runtimeGeneration: z.string().min(1),
  providerId: z.string().min(1),
  chatId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable(),
  state: inferenceTicketStateSchema,
  queuePosition: z.number().int().positive().nullable(),
  enqueuedAt: z.number().int().nonnegative(),
  grantedAt: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
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
  pools: z.array(inferencePoolStatusSchema),
});

export type ProviderInferenceConfiguration = z.infer<
  typeof providerInferenceConfigurationSchema
>;
export type InferenceTicketState = z.infer<typeof inferenceTicketStateSchema>;
export type InferenceOperationStatus = z.infer<
  typeof inferenceOperationStatusSchema
>;
export type InferencePoolStatus = z.infer<typeof inferencePoolStatusSchema>;
export type WorkerInferenceStatus = z.infer<typeof workerInferenceStatusSchema>;
