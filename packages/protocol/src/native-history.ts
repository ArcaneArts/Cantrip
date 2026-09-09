import { z } from "zod";
import { chatMessageOpaqueContentSchema } from "./communication-content.js";
import { chatAttachmentOpaqueSummarySchema } from "./attachment-content.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

const id = z.string().min(1).max(255);

/** Observation ownership only. No active-turn or computer-use grant is implied. */
export const nativeHistoryBindingOpenSchema = z
  .object({
    workerId: id,
    chatId: id,
    threadId: id,
    provenance: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("current") }).strict(),
      z
        .object({
          kind: z.literal("command"),
          operationId: id,
          operationGeneration: id,
        })
        .strict(),
      z.object({ kind: z.literal("binding"), bindingId: id }).strict(),
    ]),
  })
  .strict();

export const nativeHistoryBindingSchema = z
  .object({
    id: id,
    chatId: id,
    workerId: id,
    threadId: id,
    projectId: id,
    worktreeId: id,
    modelRouteId: id.nullable(),
    providerAccountId: id.nullable(),
    createdFromOperationId: id.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type NativeHistoryBindingOpen = z.infer<
  typeof nativeHistoryBindingOpenSchema
>;
export type NativeHistoryBinding = z.infer<typeof nativeHistoryBindingSchema>;

const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Complete worker-protected native item evidence, separate from bounded UI
 * previews. Its own revision remains explicit if a legacy writer omits it. */
export const nativeHistoryItemEvidenceSchema = z
  .object({
    version: z.literal(1),
    bindingId: id,
    workerId: id,
    revision: sequence,
    content: encryptedPayloadEnvelopeSchema,
  })
  .strict();
export type NativeHistoryItemEvidence = z.infer<
  typeof nativeHistoryItemEvidenceSchema
>;

const archiveCursorSchema = z
  .object({ snapshotId: digest, key: digest })
  .strict();
export const nativeHistoryArchiveReadSchema = z
  .object({
    workerId: id,
    chatId: id,
    bindingId: id,
    limit: z.number().int().min(1).max(128).default(64),
    cursor: archiveCursorSchema.nullable().default(null),
    // Pin related archive resources to the same committed stream heads.
    snapshotId: digest.optional(),
  })
  .strict();
export const nativeHistoryItemIdentitySchema = z
  .object({
    threadId: id,
    turnId: id,
    itemId: id,
    component: id,
    identityKind: z.enum(["canonical", "legacy"]),
  })
  .strict();
export type NativeHistoryItemIdentity = z.infer<
  typeof nativeHistoryItemIdentitySchema
>;

export const nativeHistoryArchivePageSchema = z
  .object({
    binding: nativeHistoryBindingSchema,
    snapshotId: digest,
    items: z
      .array(
        z
          .object({
            key: digest,
            identity: nativeHistoryItemIdentitySchema,
            messageId: z.string().uuid(),
            attachments: z.array(chatAttachmentOpaqueSummarySchema),
            revision: sequence,
            state: z.enum(["started", "completed", "unknown"]),
            order: z
              .object({ turn: ordinal, item: ordinal, component: ordinal })
              .strict(),
            evidence: nativeHistoryItemEvidenceSchema.nullable(),
          })
          .strict()
          .superRefine((item, context) => {
            if (item.evidence && item.evidence.revision > item.revision)
              context.addIssue({
                code: "custom",
                path: ["evidence", "revision"],
                message:
                  "Archived evidence cannot be newer than the committed item.",
              });
          }),
      )
      .max(128),
    nextCursor: archiveCursorSchema.nullable(),
  })
  .strict();
export type NativeHistoryArchiveRead = z.infer<
  typeof nativeHistoryArchiveReadSchema
>;
export type NativeHistoryArchivePage = z.infer<
  typeof nativeHistoryArchivePageSchema
>;

export const nativeHistoryResolveSchema = z
  .object({
    workerId: id,
    chatId: id,
    bindingId: id,
    items: z
      .array(
        z
          .object({
            identity: nativeHistoryItemIdentitySchema,
            association: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("observed-input"),
                  clientUserMessageId: id,
                })
                .strict(),
              // Recover an already reserved historical identity without asking
              // a new worker to reconstruct a retired command's provenance.
              z.object({ kind: z.literal("existing") }).strict(),
              // Recover an already published root output using server-owned
              // command/turn evidence. Missing outputs do not create new rows.
              z.object({ kind: z.literal("observed-output") }).strict(),
              // Both bound writers resolve before encrypting a canonical root
              // output. Adopt an existing proven alias, or reserve a fresh ID.
              z.object({ kind: z.literal("output") }).strict(),
              z.object({ kind: z.literal("native") }).strict(),
              z
                .object({
                  kind: z.literal("queue-goal"),
                  operationId: id,
                  operationGeneration: id,
                  claimId: id,
                  promptRevision: z.number().int().nonnegative(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("queue-input"),
                  operationId: id,
                  operationGeneration: id,
                  claimId: id,
                  promptRevision: z.number().int().nonnegative(),
                  clientUserMessageId: id,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("command-input"),
                  operationId: id,
                  operationGeneration: id,
                  clientUserMessageId: id,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("command-output"),
                  operationId: id,
                  operationGeneration: id,
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

export const nativeHistoryItemMappingSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    identity: nativeHistoryItemIdentitySchema,
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
    // An admitted GUI input keeps its original protected body/attachments. Native
    // replay may contain a transformed prompt, which must not replace that body.
    preservedInput: chatMessageOpaqueContentSchema.nullable(),
    // Existing opaque descriptors for exact media recovery; not a new revision basis.
    attachments: z.array(chatAttachmentOpaqueSummarySchema).optional(),
  })
  .strict();

export const nativeHistoryBindingOpenResultSchema = z
  .object({ binding: nativeHistoryBindingSchema })
  .strict();
export const nativeHistoryResolveResultSchema = z
  .object({ items: z.array(nativeHistoryItemMappingSchema).max(512) })
  .strict();

export const nativeHistoryTurnSchema = z
  .object({
    threadId: id,
    turnId: id,
    // Assigned by the durable worker projector, never reset with a runtime.
    revision: sequence,
    ordinal,
    status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
    startedAtMs: z.number().nullable(),
    completedAtMs: z.number().nullable(),
    // Worker-protected timing/usage/warnings/lineage evidence. The server only
    // stores opaque content, not unconstrained plaintext transcript fields.
    metadata: encryptedPayloadEnvelopeSchema,
  })
  .strict();

const turnArchiveCursorSchema = z
  .object({ snapshotId: digest, bindingId: id, turnId: id })
  .strict();
export const nativeHistoryTurnArchiveReadSchema = nativeHistoryArchiveReadSchema
  .omit({ cursor: true })
  .extend({ cursor: turnArchiveCursorSchema.nullable().default(null) });
export const nativeHistoryTurnArchivePageSchema = z
  .object({
    binding: nativeHistoryBindingSchema,
    snapshotId: digest,
    // Revisions are local to the originating binding. Preserve each candidate;
    // never choose a different worker's aggregate by comparing revision numbers.
    turns: z
      .array(
        z
          .object({
            bindingId: id,
            workerId: id,
            turn: nativeHistoryTurnSchema,
          })
          .strict(),
      )
      .max(128),
    nextCursor: turnArchiveCursorSchema.nullable(),
  })
  .strict();
export type NativeHistoryTurnArchiveRead = z.infer<
  typeof nativeHistoryTurnArchiveReadSchema
>;
export type NativeHistoryTurnArchivePage = z.infer<
  typeof nativeHistoryTurnArchivePageSchema
>;

/** Only ciphertext and structural correlation cross the durable ingestion boundary. */
export const nativeHistoryPreparedBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            identity: nativeHistoryItemIdentitySchema,
            revision: sequence,
            // Exact canonical revision used to prepare this item. Omitted only
            // by legacy producers; a larger proposed counter is not a CAS basis.
            expectedRevision: ordinal.optional(),
            state: z.enum(["started", "completed", "unknown"]),
            order: z
              .object({ turn: ordinal, item: ordinal, component: ordinal })
              .strict(),
            message: chatMessageOpaqueContentSchema,
            attachments: z.array(chatAttachmentOpaqueSummarySchema),
            evidence: nativeHistoryItemEvidenceSchema.optional(),
          })
          .strict()
          .superRefine((item, context) => {
            if (item.evidence && item.evidence.revision !== item.revision)
              context.addIssue({
                code: "custom",
                path: ["evidence", "revision"],
                message:
                  "Native item evidence must match the prepared item revision.",
              });
          }),
      )
      .max(512),
    turns: z.array(nativeHistoryTurnSchema).max(512),
    snapshot: z
      .object({ readBarrierSequence: ordinal, complete: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

export const nativeHistoryIngestSchema = z
  .object({
    workerId: id,
    chatId: id,
    bindingId: id,
    streamId: z.string().uuid(),
    sequence,
    recordId: z.string().uuid(),
    digest,
    previousDigest: digest.nullable(),
    batch: nativeHistoryPreparedBatchSchema,
  })
  .strict();

export const nativeHistoryCommitReceiptSchema = z
  .object({
    committed: z.literal(true),
    streamId: z.string().uuid(),
    sequence,
    recordId: z.string().uuid(),
    digest,
    commitId: z.string().uuid(),
  })
  .strict();

export type NativeHistoryPreparedBatch = z.infer<
  typeof nativeHistoryPreparedBatchSchema
>;
export type NativeHistoryIngest = z.infer<typeof nativeHistoryIngestSchema>;
export type NativeHistoryCommitReceipt = z.infer<
  typeof nativeHistoryCommitReceiptSchema
>;

/** An immutable server decision: this exact record can never become a commit.
 * It does not consume a stream sequence or authorize dropping source evidence. */
export const nativeHistoryBatchRejectionSchema = z
  .object({
    rejected: z.literal(true),
    rejectionId: z.string().uuid(),
    workerId: id,
    chatId: id,
    bindingId: id,
    streamId: z.string().uuid(),
    sequence,
    recordId: z.string().uuid(),
    digest,
    previousDigest: digest.nullable(),
    payloadDigest: digest,
    code: z.enum(["item-revision-conflict", "turn-revision-conflict"]),
  })
  .strict();
export type NativeHistoryBatchRejection = z.infer<
  typeof nativeHistoryBatchRejectionSchema
>;
export type NativeHistoryTurn = z.infer<typeof nativeHistoryTurnSchema>;
export type NativeHistoryResolve = z.infer<typeof nativeHistoryResolveSchema>;
export type NativeHistoryItemMapping = z.infer<
  typeof nativeHistoryItemMappingSchema
>;

// Archive pagination bounds response size; it imposes no execution time limit.
const batchArchiveCursorSchema = z
  .object({
    snapshotId: digest,
    streamId: z.string().uuid(),
    sequence,
  })
  .strict();
export const nativeHistoryBatchArchiveReadSchema =
  nativeHistoryArchiveReadSchema.omit({ cursor: true, limit: true }).extend({
    cursor: batchArchiveCursorSchema.nullable().default(null),
    limit: z.number().int().min(1).max(16).default(4),
  });
export const nativeHistoryBatchArchivePageSchema = z
  .object({
    binding: nativeHistoryBindingSchema,
    snapshotId: digest,
    // An accepted candidate is not necessarily the selected canonical revision.
    batches: z
      .array(
        z
          .object({
            bindingId: id,
            workerId: id,
            receipt: nativeHistoryCommitReceiptSchema,
            payloadDigest: digest,
            previousDigest: digest.nullable(),
            // Older receipts may have no retained source. Never invent one from the UI.
            batch: nativeHistoryPreparedBatchSchema.nullable(),
          })
          .strict(),
      )
      .max(16),
    nextCursor: batchArchiveCursorSchema.nullable(),
  })
  .strict();
export type NativeHistoryBatchArchiveRead = z.infer<
  typeof nativeHistoryBatchArchiveReadSchema
>;
export type NativeHistoryBatchArchivePage = z.infer<
  typeof nativeHistoryBatchArchivePageSchema
>;
