import { z } from "zod";
import {
  BINARY_FILE_PAGE_BYTES,
  binaryFileVersionSchema,
} from "./explorer-binary.js";
export const BINARY_WRITE_CHUNK_BYTES = BINARY_FILE_PAGE_BYTES;
const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  digest = z.string().regex(/^[a-f0-9]{64}$/u),
  path = z.string().min(1).max(8192),
  uploadId = z.string().uuid();
export const binaryWriteVersionSchema = z.union([
  binaryFileVersionSchema,
  z.string().regex(/^binary-sha256:[a-f0-9]{64}$/u),
]);
export const binaryWriteBeginSchema = z
  .object({
    type: z.literal("explorer.binary.write.begin"),
    path,
    uploadId,
    version: binaryWriteVersionSchema.nullable(),
  })
  .strict();
export const binaryWriteChunkSchema = z
  .object({
    type: z.literal("explorer.binary.write.chunk"),
    path,
    uploadId,
    offset: size,
    final: z.boolean(),
    data: z
      .string()
      .max(Math.ceil(BINARY_WRITE_CHUNK_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
  })
  .strict();
export const binaryWriteCommitSchema = z
  .object({
    type: z.literal("explorer.binary.write.commit"),
    path,
    uploadId,
    size,
    sha256: digest,
  })
  .strict();
export const binaryWriteStatusSchema = z
  .object({ type: z.literal("explorer.binary.write.status"), path, uploadId })
  .strict();
export const binaryWriteAbortSchema = z
  .object({ type: z.literal("explorer.binary.write.abort"), path, uploadId })
  .strict();
export const binaryWriteReceiptSchema = z
  .object({
    path,
    uploadId,
    state: z.enum([
      "unknown",
      "uploading",
      "prepared",
      "committed",
      "conflict",
      "aborted",
    ]),
    offset: size,
    size: size.nullable(),
    sha256: digest.nullable(),
    version: binaryWriteVersionSchema.nullable(),
    error: z.string().max(8192).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state === "committed" &&
      (!value.sha256 || !value.version || value.size === null)
    )
      context.addIssue({
        code: "custom",
        message: "A committed binary write requires a complete receipt.",
      });
  });
export type BinaryWriteRequest =
  | z.infer<typeof binaryWriteBeginSchema>
  | z.infer<typeof binaryWriteChunkSchema>
  | z.infer<typeof binaryWriteCommitSchema>
  | z.infer<typeof binaryWriteStatusSchema>
  | z.infer<typeof binaryWriteAbortSchema>;
export type BinaryWriteReceipt = z.infer<typeof binaryWriteReceiptSchema>;
