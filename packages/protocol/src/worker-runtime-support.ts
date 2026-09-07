import { z } from "zod";
import {
  attachmentChunkOpaqueSchema,
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSummarySchema,
} from "./attachment-content.js";
import { protectedSecretEnvelopeSchema } from "./protected-secrets.js";
import {
  modelProviderKindSchema,
  providerWeeklyUsageSchema,
  reasoningEffortSchema,
  modelReasoningEffortOptionSchema,
  providerModelCatalogEntrySchema,
} from "./providers.js";
import {
  projectSharePublicBasePathSchema,
  projectSharePublicOriginSchema,
} from "./code-surfaces.js";

export const workerRuntimeModelSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  name: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  catalog: providerModelCatalogEntrySchema
    .pick({
      nativeModelId: true,
      displayName: true,
      description: true,
      contextWindow: true,
      maxOutputTokens: true,
      inputModalities: true,
      outputModalities: true,
      supportsTools: true,
      supportsParallelTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedReasoningEfforts: true,
      defaultReasoningEffort: true,
      reasoningMandatory: true,
      metadataSource: true,
    })
    .nullable()
    .optional(),
});

export const workerRuntimeProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  protectedApiKey: protectedSecretEnvelopeSchema.nullable().default(null),
  accountId: z.string().min(1).nullable().default(null),
  credentialHomeKey: z.string().min(1).max(500).nullable().default(null),
});

export const workerChatAttachmentSchema = chatAttachmentOpaqueSummarySchema;

export const workerAttachmentUploadResultSchema = z.object({
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  verified: z.literal(true),
});

export const workerAttachmentReadResultSchema = z.object({
  chunk: attachmentChunkOpaqueSchema,
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
});

export const workerProjectShareDescriptorSchema = z
  .object({
    shareId: z.string().min(1).max(200),
    protocol: z.literal("webdav"),
    publicBasePath: projectSharePublicBasePathSchema,
    publicOrigin: projectSharePublicOriginSchema,
    loopbackHost: z.literal("127.0.0.1"),
    loopbackPort: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(128),
    password: z.string().min(24).max(256),
    realm: z.string().min(1).max(200),
  })
  .strict();

export const workerProjectShareOpenResultSchema = z
  .object({
    accepted: z.literal(true),
    shareId: z.string().min(1).max(200),
  })
  .strict();

export const ollamaModelInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  modifiedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  digest: z.string().trim().min(1).max(500).nullable(),
  family: z.string().trim().min(1).max(500).nullable(),
  families: z.array(z.string().trim().min(1).max(500)).max(32),
  parameterSize: z.string().trim().min(1).max(100).nullable(),
  quantization: z.string().trim().min(1).max(100).nullable(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(64),
  modelInfo: z.record(z.string(), z.unknown()),
});

export const ollamaModelInventorySchema = z.object({
  models: z.array(ollamaModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
});

export const chatGptModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: reasoningEffortSchema,
        description: z.string().max(500),
      }),
    )
    .max(32),
  defaultReasoningEffort: reasoningEffortSchema,
  modelSpecialty: z.string().max(500).nullable(),
  supportsPersonality: z.boolean(),
  upgrade: z.string().max(500).nullable(),
  upgradeInfo: z.record(z.string(), z.unknown()).nullable(),
  availabilityNux: z.record(z.string(), z.unknown()).nullable(),
  additionalSpeedTiers: z.array(z.string().max(100)).max(32),
  serviceTiers: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().max(200),
        description: z.string().max(2_000),
      }),
    )
    .max(32),
  defaultServiceTier: z.string().max(100).nullable(),
});

export const providerQuotaWindowObservationSchema = z.object({
  limitId: z.string().max(500).nullable(),
  limitName: z.string().max(500).nullable(),
  planType: z.string().max(500).nullable(),
  reachedType: z.string().max(500).nullable(),
  windowKind: z.enum(["primary", "secondary"]),
  usedPercent: z.number().min(0).max(100),
  windowDurationMinutes: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
  isWeeklyProjection: z.boolean(),
  rawPayload: z.record(z.string(), z.unknown()).default({}),
});

export const providerRateLimitResetCreditSchema = z.object({
  id: z.string().trim().min(1).max(1_000),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  title: z.string().max(1_000).nullable(),
  description: z.string().max(4_000).nullable(),
});

export const providerRateLimitResetCreditsSummarySchema = z.object({
  availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credits: z.array(providerRateLimitResetCreditSchema).max(100).nullable(),
});

export const providerRateLimitResetConsumeOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

export const providerRateLimitResetConsumeInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    creditId: z.string().trim().min(1).max(1_000).nullable().optional(),
  })
  .strict();

export const providerRateLimitResetConsumeRequestSchema =
  providerRateLimitResetConsumeInputSchema
    .extend({ workerId: z.string().min(1).max(500) })
    .strict();

export const providerQuotaSnapshotSchema = z.object({
  snapshotId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  workerVersion: z.string().max(200).nullable(),
  codexVersion: z.string().max(500).nullable(),
  windows: z.array(providerQuotaWindowObservationSchema).max(500),
  rateLimitResetCredits: providerRateLimitResetCreditsSummarySchema
    .nullable()
    .default(null),
});

export const providerRateLimitResetConsumeResultSchema = z.object({
  outcome: providerRateLimitResetConsumeOutcomeSchema,
  quotaSnapshot: providerQuotaSnapshotSchema.nullable(),
});

export const chatGptModelInventorySchema = z.object({
  models: z.array(chatGptModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const grokModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  outputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z.array(modelReasoningEffortOptionSchema).max(32),
  defaultReasoningEffort: reasoningEffortSchema.nullable(),
  supportsReasoning: z.boolean(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  rawMetadata: z.record(z.string(), z.unknown()),
});

export const grokModelInventorySchema = z.object({
  models: z.array(grokModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const serviceLogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

export const serviceLogRecordSchema = z.object({
  cursor: z.number().int().positive(),
  timestamp: z.string().datetime(),
  system: z.string().trim().min(1).max(100),
  level: serviceLogLevelSchema,
  message: z.string().max(16_384),
  context: z.unknown().optional(),
});

export const serviceLogReadResultSchema = z.object({
  records: z.array(serviceLogRecordSchema).max(500),
  nextCursor: z.number().int().nonnegative(),
  oldestCursor: z.number().int().positive().nullable(),
  latestCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});

export const workerLogStreamSubscriptionIdSchema = z.string().uuid();

export const workerLogStreamBatchSchema = z
  .object({
    records: z.array(serviceLogRecordSchema).max(200),
    nextCursor: z.number().int().nonnegative(),
    oldestCursor: z.number().int().positive().nullable(),
    latestCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const workerLogStreamStartResultSchema = z
  .object({
    accepted: z.literal(true),
    latestCursor: z.number().int().nonnegative(),
  })
  .strict();

export const workerLogStreamRenewResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const workerLogStreamServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      nextCursor: z.number().int().nonnegative(),
    })
    .strict(),
  workerLogStreamBatchSchema.extend({ type: z.literal("batch") }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum([
        "authorization-failed",
        "invalid-request",
        "worker-offline",
        "stream-unavailable",
      ]),
      message: z.string().min(1).max(500),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const workerLogReadQuerySchema = z
  .object({
    afterCursor: z.coerce.number().int().nonnegative().default(0),
    beforeCursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    minimumLevel: serviceLogLevelSchema.default("trace"),
  })
  .strict();

export type WorkerChatAttachment = z.infer<typeof workerChatAttachmentSchema>;
export type WorkerAttachmentUploadResult = z.infer<
  typeof workerAttachmentUploadResultSchema
>;
export type WorkerAttachmentReadResult = z.infer<
  typeof workerAttachmentReadResultSchema
>;
export type WorkerProjectShareOpenResult = z.infer<
  typeof workerProjectShareOpenResultSchema
>;
export type WorkerProjectShareDescriptor = z.infer<
  typeof workerProjectShareDescriptorSchema
>;
export type OllamaModelInventoryItem = z.infer<
  typeof ollamaModelInventoryItemSchema
>;
export type OllamaModelInventory = z.infer<typeof ollamaModelInventorySchema>;
export type ChatGptModelInventoryItem = z.infer<
  typeof chatGptModelInventoryItemSchema
>;
export type ChatGptModelInventory = z.infer<typeof chatGptModelInventorySchema>;
export type ProviderQuotaSnapshot = z.infer<typeof providerQuotaSnapshotSchema>;
export type ProviderQuotaWindowObservation = z.infer<
  typeof providerQuotaWindowObservationSchema
>;
export type ProviderRateLimitResetCredit = z.infer<
  typeof providerRateLimitResetCreditSchema
>;
export type ProviderRateLimitResetCreditsSummary = z.infer<
  typeof providerRateLimitResetCreditsSummarySchema
>;
export type ProviderRateLimitResetConsumeInput = z.infer<
  typeof providerRateLimitResetConsumeInputSchema
>;
export type ProviderRateLimitResetConsumeRequest = z.infer<
  typeof providerRateLimitResetConsumeRequestSchema
>;
export type ProviderRateLimitResetConsumeOutcome = z.infer<
  typeof providerRateLimitResetConsumeOutcomeSchema
>;
export type ProviderRateLimitResetConsumeResult = z.infer<
  typeof providerRateLimitResetConsumeResultSchema
>;
export type GrokModelInventoryItem = z.infer<
  typeof grokModelInventoryItemSchema
>;
export type GrokModelInventory = z.infer<typeof grokModelInventorySchema>;
export type ServiceLogLevel = z.infer<typeof serviceLogLevelSchema>;
export type ServiceLogRecord = z.infer<typeof serviceLogRecordSchema>;
export type ServiceLogReadResult = z.infer<typeof serviceLogReadResultSchema>;
export type WorkerLogReadQuery = z.infer<typeof workerLogReadQuerySchema>;
export type WorkerLogStreamBatch = z.infer<typeof workerLogStreamBatchSchema>;
export type WorkerLogStreamServerMessage = z.infer<
  typeof workerLogStreamServerMessageSchema
>;
