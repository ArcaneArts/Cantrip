import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const ATTACHMENT_MAX_BYTES = 25 * 1_024 * 1_024;
export const ATTACHMENT_MAX_CHUNK_BYTES = 256 * 1_024;
export const ATTACHMENT_MAX_CHUNKS =
  Math.ceil(ATTACHMENT_MAX_BYTES / ATTACHMENT_MAX_CHUNK_BYTES) + 1;
export const ATTACHMENT_METADATA_BYTES_LIMIT = 32 * 1_024;

export const chatAttachmentKindSchema = z.enum([
  "audio",
  "file",
  "image",
  "text",
]);
export const chatAttachmentSourceSchema = z.enum(["file", "paste"]);

export const chatAttachmentSummarySchema = z.object({
  id: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative().max(ATTACHMENT_MAX_BYTES),
  kind: chatAttachmentKindSchema,
  source: chatAttachmentSourceSchema,
  status: z.enum(["ready", "failed"]),
  previewText: z.string().max(8_000).nullable(),
  createdAt: z.iso.datetime(),
});

export const chatAttachmentListSchema = z
  .array(chatAttachmentSummarySchema)
  .max(20);

export const attachmentMetadataProtectedContentSchema = z
  .object({
    version: z.literal(1),
    fileName: chatAttachmentSummarySchema.shape.fileName,
    mimeType: chatAttachmentSummarySchema.shape.mimeType,
    kind: chatAttachmentKindSchema,
    source: chatAttachmentSourceSchema,
    previewText: chatAttachmentSummarySchema.shape.previewText,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    error: z.string().min(1).max(1_000).nullable(),
  })
  .strict();

const maximumMetadataCiphertextCharacters = Math.ceil(
  ((ATTACHMENT_METADATA_BYTES_LIMIT + 16) * 4) / 3,
);

export const attachmentProtectedMetadataSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema.extend({
      ciphertext: encryptionBytesSchema
        .min(22)
        .max(maximumMetadataCiphertextCharacters),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.envelope.version !== value.formatVersion ||
      value.envelope.keyRevision !== value.keyRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Protected attachment metadata envelope must agree.",
        path: ["envelope"],
      });
    }
  });

export const chatAttachmentOpaqueSummarySchema = z
  .object({
    id: chatAttachmentSummarySchema.shape.id,
    chatId: chatAttachmentSummarySchema.shape.chatId,
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    status: chatAttachmentSummarySchema.shape.status,
    protectedMetadata: attachmentProtectedMetadataSchema,
    createdAt: chatAttachmentSummarySchema.shape.createdAt,
  })
  .strict();

export const chatAttachmentOpaqueListSchema = z
  .array(chatAttachmentOpaqueSummarySchema)
  .max(20);

export const attachmentStreamDirectionSchema = z.enum([
  "upload",
  "download",
  "relay",
]);

const maximumChunkCiphertextCharacters = Math.ceil(
  ((ATTACHMENT_MAX_CHUNK_BYTES + 16) * 4) / 3,
);

export const attachmentChunkOpaqueSchema = z
  .object({
    sequence: z.number().int().nonnegative().safe(),
    plaintextBytes: z
      .number()
      .int()
      .nonnegative()
      .max(ATTACHMENT_MAX_CHUNK_BYTES),
    eof: z.boolean(),
    envelope: encryptedPayloadEnvelopeSchema.extend({
      ciphertext: encryptionBytesSchema
        .min(22)
        .max(maximumChunkCiphertextCharacters),
    }),
  })
  .strict();

export const attachmentUploadOpaqueSchema = z
  .object({
    attachmentId: z.string().uuid(),
    operationId: z.string().uuid(),
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    protectedMetadata: attachmentProtectedMetadataSchema,
    chunks: z
      .array(attachmentChunkOpaqueSchema)
      .min(1)
      .max(ATTACHMENT_MAX_CHUNKS),
  })
  .strict()
  .superRefine((value, context) => {
    let bytes = 0;
    for (const [index, chunk] of value.chunks.entries()) {
      if (chunk.sequence !== index) {
        context.addIssue({
          code: "custom",
          message: "Attachment upload chunks must be contiguous.",
          path: ["chunks", index, "sequence"],
        });
      }
      if (chunk.eof !== (index === value.chunks.length - 1)) {
        context.addIssue({
          code: "custom",
          message: "Only the final attachment upload chunk may end the stream.",
          path: ["chunks", index, "eof"],
        });
      }
      bytes += chunk.plaintextBytes;
    }
    if (bytes !== value.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "Attachment upload chunk sizes must match the declared size.",
        path: ["chunks"],
      });
    }
  });

export const attachmentDownloadOpaqueSchema = z
  .object({
    attachmentId: chatAttachmentSummarySchema.shape.id,
    operationId: z.string().uuid(),
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    protectedMetadata: attachmentProtectedMetadataSchema,
    chunks: z
      .array(attachmentChunkOpaqueSchema)
      .min(1)
      .max(ATTACHMENT_MAX_CHUNKS),
  })
  .strict()
  .superRefine((value, context) => {
    let bytes = 0;
    for (const [index, chunk] of value.chunks.entries()) {
      if (
        chunk.sequence !== index ||
        chunk.eof !== (index === value.chunks.length - 1)
      ) {
        context.addIssue({
          code: "custom",
          message: "Attachment download chunks are not a canonical stream.",
          path: ["chunks", index],
        });
      }
      bytes += chunk.plaintextBytes;
    }
    if (bytes !== value.sizeBytes) {
      context.addIssue({
        code: "custom",
        message:
          "Attachment download chunk sizes must match the declared size.",
        path: ["chunks"],
      });
    }
  });

export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentSource = z.infer<typeof chatAttachmentSourceSchema>;
export type ChatAttachmentSummary = z.infer<typeof chatAttachmentSummarySchema>;
export type AttachmentMetadataProtectedContent = z.infer<
  typeof attachmentMetadataProtectedContentSchema
>;
export type AttachmentProtectedMetadata = z.infer<
  typeof attachmentProtectedMetadataSchema
>;
export type ChatAttachmentOpaqueSummary = z.infer<
  typeof chatAttachmentOpaqueSummarySchema
>;
export type AttachmentStreamDirection = z.infer<
  typeof attachmentStreamDirectionSchema
>;
export type AttachmentChunkOpaque = z.infer<typeof attachmentChunkOpaqueSchema>;
export type AttachmentUploadOpaque = z.infer<
  typeof attachmentUploadOpaqueSchema
>;
export type AttachmentDownloadOpaque = z.infer<
  typeof attachmentDownloadOpaqueSchema
>;
