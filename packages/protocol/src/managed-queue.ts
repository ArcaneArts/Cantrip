import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { queuedPromptOpaqueContentSchema } from "./communication-content.js";
import { encryptedQueuedPromptSchema } from "./chat-runtime.js";
import { chatAttachmentOpaqueListSchema } from "./attachment-content.js";
import {
  nativeCommandAdmissionSchema,
  nativeCommandReceiptSchema,
  nativeCommandSessionSchema,
} from "./native-commands.js";
const id = z.string().min(1).max(255);
const revision = z.number().int().nonnegative();
export const managedQueueClaimSchema = z
  .object({
    id,
    chatId: id,
    promptId: id,
    promptRevision: revision,
    awaitingGoal: z.boolean().default(false),
    goalEpoch: id.nullable().default(null),
    goalOperationId: id.nullable().default(null),
    goalOperationGeneration: id.nullable().default(null),
    requestOperationId: id.nullable().default(null),
    status: z.enum([
      "claimed",
      "accepted",
      "dispatched",
      "consumed",
      "deferred",
      "rejected",
      "uncertain",
    ]),
    operationId: id.nullable(),
    operationGeneration: id.nullable(),
    nativeTurnId: id.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const managedQueueReadSchema = z
  .object({ workerId: id, session: nativeCommandSessionSchema })
  .strict();
export const managedQueuePendingImportSchema = z
  .object({
    importId: id,
    nativeItemId: id,
    status: z.enum(["pending", "conflict", "uncertain"]),
    prompt: encryptedQueuedPromptSchema,
  })
  .strict();
export type ManagedQueuePendingImport = z.infer<
  typeof managedQueuePendingImportSchema
>;
export const managedQueueSnapshotSchema = z
  .object({
    revision,
    paused: z.boolean(),
    items: z.array(encryptedQueuedPromptSchema),
    claims: z.array(managedQueueClaimSchema).default([]),
    pendingImports: z.array(managedQueuePendingImportSchema).default([]),
  })
  .strict();
export const managedQueueMutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add"),
      prompt: queuedPromptOpaqueContentSchema,
      attachments: chatAttachmentOpaqueListSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update"),
      id,
      expectedItemRevision: revision,
      prompt: queuedPromptOpaqueContentSchema,
      attachments: chatAttachmentOpaqueListSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("delete"), id, expectedItemRevision: revision })
    .strict(),
  z.object({ kind: z.literal("reorder"), ids: z.array(id).max(1000) }).strict(),
  z.object({ kind: z.literal("start"), id: id.optional() }).strict(),
]);
export const managedQueueMutateSchema = z
  .object({
    admission: nativeCommandAdmissionSchema,
    expectedRevision: revision,
    mutation: managedQueueMutationSchema,
  })
  .strict();
export const managedQueueMutationResultSchema = managedQueueSnapshotSchema
  .extend({
    receipt: nativeCommandReceiptSchema,
    acceptedItem: encryptedQueuedPromptSchema.optional(),
    claim: managedQueueClaimSchema.optional(),
  })
  .strict();
export const managedQueueStartReceiptSchema = managedQueueReadSchema
  .extend({ claimId: id })
  .strict();
export const managedQueueStartReceiptResultSchema = z
  .object({
    claim: managedQueueClaimSchema,
    receipt: nativeCommandReceiptSchema,
    protectedResult: encryptedPayloadEnvelopeSchema,
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ManagedQueueClaim = z.infer<typeof managedQueueClaimSchema>;
export type ManagedQueueSnapshot = z.infer<typeof managedQueueSnapshotSchema>;
export type ManagedQueueRead = z.infer<typeof managedQueueReadSchema>;
export type ManagedQueueMutation = z.infer<typeof managedQueueMutationSchema>;
export type ManagedQueueMutate = z.infer<typeof managedQueueMutateSchema>;
export type ManagedQueueMutationResult = z.infer<
  typeof managedQueueMutationResultSchema
>;
export type ManagedQueueStartReceipt = z.infer<
  typeof managedQueueStartReceiptSchema
>;
export type ManagedQueueStartReceiptResult = z.infer<
  typeof managedQueueStartReceiptResultSchema
>;

export const encryptedQueuedPromptQueueSchema = z.union([
  z.array(encryptedQueuedPromptSchema),
  managedQueueSnapshotSchema.pick({
    revision: true,
    items: true,
    pendingImports: true,
    claims: true,
  }),
]);
export type EncryptedQueuedPromptQueue = z.infer<
  typeof encryptedQueuedPromptQueueSchema
>;
export const managedQueueImportSchema = managedQueueReadSchema
  .extend({
    runnerGeneration: id,
    items: z
      .array(
        z
          .object({
            nativeItemId: id,
            sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
            protectedSource: encryptedPayloadEnvelopeSchema,
            prompt: queuedPromptOpaqueContentSchema,
            attachments: chatAttachmentOpaqueListSchema,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const managedQueueImportRecordSchema = z
  .object({
    importId: id,
    nativeItemId: id,
    sourceDigest: z.string(),
    protectedSource: encryptedPayloadEnvelopeSchema,
    nativeDeleteOperationId: id,
    promptId: id,
    status: z.enum(["pending", "imported", "conflict", "uncertain"]),
  })
  .strict();
export const managedQueueImportResultSchema = managedQueueSnapshotSchema
  .extend({ imports: z.array(managedQueueImportRecordSchema) })
  .strict();
export const managedQueueImportAckSchema = managedQueueReadSchema
  .extend({
    runnerGeneration: id,
    importId: id,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    receipt: z.object({ deleted: z.boolean(), conflict: z.boolean() }).strict(),
  })
  .strict();
export type ManagedQueueImport = z.infer<typeof managedQueueImportSchema>;
export type ManagedQueueImportAck = z.infer<typeof managedQueueImportAckSchema>;
export type ManagedQueueImportResult = z.infer<
  typeof managedQueueImportResultSchema
>;

export const managedQueueLookupSchema = z
  .object({ admission: nativeCommandAdmissionSchema })
  .strict();
export const managedQueueLookupResultSchema = z.union([
  z.object({ found: z.literal(false) }).strict(),
  managedQueueMutationResultSchema.extend({ found: z.literal(true) }).strict(),
]);
export type ManagedQueueLookup = z.infer<typeof managedQueueLookupSchema>;
export type ManagedQueueLookupResult = z.infer<
  typeof managedQueueLookupResultSchema
>;
