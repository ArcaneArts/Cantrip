import { z } from "zod";
import {
  explorerOperationRequestContentSchema,
  chatFileReferencesRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
} from "@cantrip/protocol/surface-stream";
import { explorerRequestMutates } from "../commands/explorer-request.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-paths.js";

const segment = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const osAttachmentRequestSchema = z
  .object({
    type: z.literal("chat.attachment.materialize"),
    chatId: segment,
    attachmentId: segment,
    fileName: z.string().min(1).max(180),
    sizeBytes: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
  })
  .strict();
export const osFileRequestSchema = z.union([
  explorerOperationRequestContentSchema,
  chatFileReferencesRequestContentSchema,
  osAttachmentRequestSchema,
]);
export type OsFileRequest = z.infer<typeof osFileRequestSchema>;
export const osAttachmentReceiptSchema = z
  .object({
    path: z.string().startsWith("/"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export const osFileOutcomeSchema = z.union([
  surfaceOperationOutcomeContentSchema,
  z
    .object({
      ok: z.literal(true),
      result: z
        .object({
          type: z.literal("chat.attachment.materialized"),
          value: osAttachmentReceiptSchema,
        })
        .strict(),
    })
    .strict(),
]);
export type OsFileOutcome = z.infer<typeof osFileOutcomeSchema>;
export function osFileRequestMutates(request: OsFileRequest): boolean {
  if (request.type === "chat.attachment.materialize") return true;
  return request.type === "chat.files.references"
    ? false
    : explorerRequestMutates(request);
}
