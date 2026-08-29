import { z } from "zod";
import {
  attachmentChunkOpaqueSchema,
  attachmentProtectedMetadataSchema,
  chatAttachmentSummarySchema,
} from "./attachment-content.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  executionPlacementSchema,
  executionTargetSchema,
} from "./execution-targets.js";
import { planModeSchema } from "./chat-runtime.js";
import { agentThreadSyncSchema } from "./agent-thread-sync.js";

export const externalChatSourceKindSchema = z.enum(["chatgpt-codex"]);

export const externalChatSourceAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "incompatible",
]);

export const externalChatThreadStatusSchema = z.enum([
  "not-loaded",
  "idle",
  "system-error",
]);

export const chatImportStateSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const externalChatImportReferenceSchema = z.object({
  jobId: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
});

export const externalChatThreadMatchSchema = z.object({
  kind: z.enum(["worktree-path", "replica-path", "git-origin"]),
  projectReplicaId: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200).nullable(),
});

export const externalChatThreadMetadataSchema = z.object({
  sourceThreadId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  preview: z.string().max(2_000),
  cwd: z.string().min(1).max(8_192),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean(),
  source: z.enum(["cli", "vscode"]),
  status: externalChatThreadStatusSchema,
  modelProvider: z.string().min(1).max(200),
  cliVersion: z.string().max(100).nullable(),
  git: z
    .object({
      branch: z.string().max(1_000).nullable(),
      sha: z.string().max(200).nullable(),
      originUrl: z.string().max(4_000).nullable(),
    })
    .nullable(),
  match: externalChatThreadMatchSchema,
  existingImport: externalChatImportReferenceSchema.nullable().default(null),
});

export const externalChatSourceSchema = z.object({
  kind: externalChatSourceKindSchema,
  sourceId: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "win32"]),
  homeLabel: z.string().min(1).max(500),
  availability: externalChatSourceAvailabilitySchema,
  message: z.string().min(1).max(2_000).nullable(),
  runtimeVersion: z.string().max(100).nullable(),
  threads: z.array(externalChatThreadMetadataSchema).max(5_000),
  truncated: z.boolean(),
});

export const externalChatDiscoveryWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "unsupported",
  "timed-out",
  "error",
]);

export const externalChatDiscoveryWorkerSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  status: externalChatDiscoveryWorkerStatusSchema,
  sources: z.array(externalChatSourceSchema).max(8),
  error: z
    .object({
      code: z.enum([
        "worker-offline",
        "capability-missing",
        "worker-timeout",
        "worker-error",
      ]),
      message: z.string().min(1).max(2_000),
    })
    .nullable(),
});

export const projectExternalChatDiscoverySchema = z.object({
  projectId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean(),
  workers: z.array(externalChatDiscoveryWorkerSchema).max(64),
});

export const externalChatDiscoveryTargetSchema = z.object({
  projectReplicaId: z.string().min(1).max(200),
  path: z.string().min(1).max(8_192),
  repositoryFingerprint: z.string().min(1).max(500).nullable(),
  worktrees: z
    .array(
      z.object({
        worktreeId: z.string().min(1).max(200),
        path: z.string().min(1).max(8_192),
        isPrimary: z.boolean(),
      }),
    )
    .max(512),
});

export const externalChatDiscoveryWorkerResultSchema = z.object({
  sources: z.array(externalChatSourceSchema).max(8),
  truncated: z.boolean(),
});

export const externalChatTranscriptMetadataSchema =
  externalChatThreadMetadataSchema.omit({
    archived: true,
    existingImport: true,
    title: true,
  });

export const externalChatAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    sourceAttachmentId: z.string().regex(/^[0-9a-f]{64}$/u),
    itemId: z.string().min(1).max(500),
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    status: z.enum(["available", "missing", "unsafe", "unsupported"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
  })
  .superRefine((attachment, context) => {
    if (attachment.status === "available" && attachment.sizeBytes === 0) {
      context.addIssue({
        code: "custom",
        message: "Available external attachments cannot be empty.",
        path: ["sizeBytes"],
      });
    }
  });

export const externalChatTranscriptSchema = z
  .object({
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    metadata: externalChatTranscriptMetadataSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
    sync: agentThreadSyncSchema,
    attachments: z.array(externalChatAttachmentSchema).max(20).default([]),
  })
  .superRefine((transcript, context) => {
    if (transcript.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Imported title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const descriptors = new Map(
      transcript.attachments.map((attachment) => [attachment.id, attachment]),
    );
    if (descriptors.size !== transcript.attachments.length) {
      context.addIssue({
        code: "custom",
        message: "External attachment ids must be unique.",
        path: ["attachments"],
      });
    }
    const references = new Map<string, string>();
    for (const [turnIndex, turn] of transcript.sync.turns.entries()) {
      for (const [itemIndex, item] of turn.items.entries()) {
        if (item.type !== "userMessage") continue;
        for (const attachmentId of item.externalAttachmentIds) {
          if (references.has(attachmentId)) {
            context.addIssue({
              code: "custom",
              message: "An external attachment may be referenced only once.",
              path: [
                "sync",
                "turns",
                turnIndex,
                "items",
                itemIndex,
                "externalAttachmentIds",
              ],
            });
          }
          references.set(attachmentId, item.id);
        }
      }
    }
    for (const [
      attachmentIndex,
      attachment,
    ] of transcript.attachments.entries()) {
      if (references.get(attachment.id) !== attachment.itemId) {
        context.addIssue({
          code: "custom",
          message:
            "Every external attachment must reference its originating user message.",
          path: ["attachments", attachmentIndex, "itemId"],
        });
      }
    }
    for (const attachmentId of references.keys()) {
      if (!descriptors.has(attachmentId)) {
        context.addIssue({
          code: "custom",
          message: "External attachment references require a descriptor.",
          path: ["sync"],
        });
      }
    }
  });

export const externalChatReadWorkerResultSchema = z.object({
  transcript: externalChatTranscriptSchema,
});

export const externalChatAttachmentReadResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("available"),
      chunk: attachmentChunkOpaqueSchema,
      sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    }),
    z.object({
      status: z.literal("unavailable"),
      reasonCode: z.enum(["missing", "changed", "invalid"]),
    }),
  ],
);

export const chatImportErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "source-not-found",
    "source-changed",
    "project-mismatch",
    "runtime-incompatible",
    "target-not-found",
    "stale-attempt",
    "worker-error",
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export const chatImportJobErrorSchema = chatImportErrorSchema.omit({
  message: true,
});

export const chatImportProgressStageSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "blocked",
  "failed",
  "succeeded",
]);

export const chatImportProgressSchema = z.object({
  stage: chatImportProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatImportJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  targetPlacement: executionPlacementSchema,
  managedThreadId: z.string().min(1).max(500).nullable(),
  targetModelRouteId: z.string().min(1).max(200).nullable(),
  targetProviderAccountId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  attempt: z.number().int().nonnegative(),
  progress: chatImportProgressSchema,
  error: chatImportJobErrorSchema.nullable(),
  sourceMetadata: externalChatTranscriptMetadataSchema.nullable(),
  attachmentCount: z.number().int().nonnegative(),
  attachmentWarningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatImportJobListSchema = z
  .array(chatImportJobSummarySchema)
  .max(1_000);

export const chatImportSelectionSchema = z.object({
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  idempotencyKey: z.string().min(1).max(200),
  target: executionTargetSchema.optional(),
  modelId: z.string().min(1).max(200).nullable().default(null),
  modelRouteId: z.string().min(1).max(200).nullable().default(null),
  providerAccountId: z.string().min(1).max(200).nullable().default(null),
  permissionProfileId: z.string().min(1).max(200).nullable().default(null),
  planMode: planModeSchema.default("default"),
});

export const chatImportCreateSchema = z.object({
  imports: z.array(chatImportSelectionSchema).min(1).max(50),
});

export const chatImportJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export type ExternalChatSourceKind = z.infer<
  typeof externalChatSourceKindSchema
>;
export type ExternalChatSourceAvailability = z.infer<
  typeof externalChatSourceAvailabilitySchema
>;
export type ExternalChatThreadStatus = z.infer<
  typeof externalChatThreadStatusSchema
>;
export type ExternalChatImportReference = z.infer<
  typeof externalChatImportReferenceSchema
>;
export type ExternalChatThreadMatch = z.infer<
  typeof externalChatThreadMatchSchema
>;
export type ExternalChatThreadMetadata = z.infer<
  typeof externalChatThreadMetadataSchema
>;
export type ExternalChatSource = z.infer<typeof externalChatSourceSchema>;
export type ExternalChatDiscoveryWorker = z.infer<
  typeof externalChatDiscoveryWorkerSchema
>;
export type ProjectExternalChatDiscovery = z.infer<
  typeof projectExternalChatDiscoverySchema
>;
export type ExternalChatDiscoveryTarget = z.infer<
  typeof externalChatDiscoveryTargetSchema
>;
export type ExternalChatDiscoveryWorkerResult = z.infer<
  typeof externalChatDiscoveryWorkerResultSchema
>;
export type ExternalChatTranscriptMetadata = z.infer<
  typeof externalChatTranscriptMetadataSchema
>;
export type ExternalChatTranscript = z.infer<
  typeof externalChatTranscriptSchema
>;
export type ExternalChatAttachment = z.infer<
  typeof externalChatAttachmentSchema
>;
export type ExternalChatAttachmentReadResult = z.infer<
  typeof externalChatAttachmentReadResultSchema
>;
export type ExternalChatReadWorkerResult = z.infer<
  typeof externalChatReadWorkerResultSchema
>;
export type ChatImportState = z.infer<typeof chatImportStateSchema>;
export type ChatImportError = z.infer<typeof chatImportErrorSchema>;
export type ChatImportJobError = z.infer<typeof chatImportJobErrorSchema>;
export type ChatImportProgress = z.infer<typeof chatImportProgressSchema>;
export type ChatImportJobSummary = z.infer<typeof chatImportJobSummarySchema>;
export type ChatImportSelection = z.infer<typeof chatImportSelectionSchema>;
export type ChatImportCreate = z.infer<typeof chatImportCreateSchema>;
