import { z } from "zod";
import { chatMessageOpaqueSummarySchema } from "./communication-content.js";
import { chatAttachmentOpaqueSummarySchema } from "./attachment-content.js";
import { taskMessageOpaqueSummarySchema } from "./tasks.js";
import { reasoningEffortSchema } from "./providers.js";
import {
  executionPlacementSchema,
  executionTargetSchema,
} from "./execution-targets.js";
import { chatMessageRoleSchema } from "./agent-activity.js";
import {
  chatMessageContentSchema,
  chatTurnModeSchema,
} from "./chat-messages.js";

export const chatRelocationStateSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const chatRelocationErrorCodeSchema = z.enum([
  "target-not-found",
  "target-mismatch",
  "worker-offline",
  "capability-missing",
  "replica-not-ready",
  "worktree-dirty",
  "revision-diverged",
  "attachment-unavailable",
  "runtime-incompatible",
  "stale-attempt",
  "policy-denied",
  "worker-error",
]);

export const chatRelocationErrorSchema = z.object({
  code: chatRelocationErrorCodeSchema,
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const chatRelocationJobErrorSchema = chatRelocationErrorSchema.omit({
  message: true,
});

export const chatRelocationProgressStageSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "recovering",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

export const chatRelocationProgressSchema = z.object({
  stage: chatRelocationProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatRelocationContextMessageSchema = z.object({
  sequence: z.number().int().positive(),
  role: chatMessageRoleSchema,
  mode: chatTurnModeSchema,
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  content: chatMessageContentSchema,
  createdAt: z.string().datetime(),
});

export const taskRelocationContextMessageSchema =
  taskMessageOpaqueSummarySchema;

export const chatRelocationAttachmentAvailabilitySchema = z.object({
  attachment: chatAttachmentOpaqueSummarySchema,
  sourceWorkerId: z.string().min(1).max(200),
  availableWorkerIds: z.array(z.string().min(1).max(200)).max(1_000),
});

export const chatRelocationContextPayloadSchema = z.union([
  z.object({
    version: z.literal(1),
    kind: z.literal("visible").default("visible"),
    messages: z.array(chatRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("task-encrypted"),
    messages: z.array(taskRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("chat-encrypted"),
    messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
]);

export const chatRelocationSnapshotSummarySchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().min(1),
  sourcePlacement: executionPlacementSchema,
  throughSequence: z.number().int().nonnegative(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  messageCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  modelId: z.string().min(1).nullable(),
  modelRouteId: z.string().min(1).nullable(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  requiredRevision: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40,64}$/u),
  createdAt: z.string().datetime(),
});

export const chatRelocationHydrationBeginResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("upload") }),
    z.object({
      status: z.literal("hydrated"),
      threadId: z.string().min(1),
    }),
  ],
);

export const chatRelocationHydrationResultSchema = z.object({
  snapshotId: z.string().uuid(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  threadId: z.string().min(1),
  reused: z.boolean(),
});

export const chatRelocationJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  chatId: z.string().min(1),
  state: chatRelocationStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  sourcePlacement: executionPlacementSchema,
  sourcePlacementRevision: z.number().int().positive(),
  targetPlacement: executionPlacementSchema,
  contextSnapshotId: z.string().uuid(),
  targetRuntimeThreadId: z.string().min(1).nullable(),
  targetModelRouteId: z.string().min(1).nullable(),
  targetProviderAccountId: z.string().min(1).nullable().default(null),
  attempt: z.number().int().nonnegative(),
  progress: chatRelocationProgressSchema,
  error: chatRelocationJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancellationUnsafeAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatRelocationJobListSchema = z
  .array(chatRelocationJobSummarySchema)
  .max(1_000);

export const chatRelocationCreateSchema = z.object({
  target: executionTargetSchema,
  approved: z.literal(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const chatRelocationJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const chatRelocationJobCancelSchema = z.object({
  stateRevision: z.number().int().positive(),
});

export type ChatRelocationState = z.infer<typeof chatRelocationStateSchema>;
export type ChatRelocationErrorCode = z.infer<
  typeof chatRelocationErrorCodeSchema
>;
export type ChatRelocationError = z.infer<typeof chatRelocationErrorSchema>;
export type ChatRelocationJobError = z.infer<
  typeof chatRelocationJobErrorSchema
>;
export type ChatRelocationProgress = z.infer<
  typeof chatRelocationProgressSchema
>;
export type ChatRelocationContextMessage = z.infer<
  typeof chatRelocationContextMessageSchema
>;
export type ChatRelocationAttachmentAvailability = z.infer<
  typeof chatRelocationAttachmentAvailabilitySchema
>;
export type ChatRelocationContextPayload = z.infer<
  typeof chatRelocationContextPayloadSchema
>;
export type ChatRelocationSnapshotSummary = z.infer<
  typeof chatRelocationSnapshotSummarySchema
>;
export type ChatRelocationHydrationBeginResult = z.infer<
  typeof chatRelocationHydrationBeginResultSchema
>;
export type ChatRelocationHydrationResult = z.infer<
  typeof chatRelocationHydrationResultSchema
>;
export type ChatRelocationJobSummary = z.infer<
  typeof chatRelocationJobSummarySchema
>;
export type ChatRelocationCreate = z.infer<typeof chatRelocationCreateSchema>;
export type ChatRelocationJobRetry = z.infer<
  typeof chatRelocationJobRetrySchema
>;
export type ChatRelocationJobCancel = z.infer<
  typeof chatRelocationJobCancelSchema
>;
