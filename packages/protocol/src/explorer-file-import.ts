import { z } from "zod";
import {
  explorerDirectoryCreateSchema,
  explorerEntryNameSchema,
  explorerEntrySchema,
} from "./explorer.js";

export const EXPLORER_FILE_IMPORT_CHUNK_BYTES = 256 * 1_024;
export const explorerFileImportChunkSchema = z
  .object({
    type: z.literal("explorer.file.import"),
    path: explorerDirectoryCreateSchema.shape.path,
    name: explorerEntryNameSchema,
    size: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative().safe(),
    data: z
      .string()
      .max(4 * Math.ceil(EXPLORER_FILE_IMPORT_CHUNK_BYTES / 3))
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
    eof: z.boolean(),
  })
  .strict();
export const explorerFileImportCancelSchema = z
  .object({ type: z.literal("explorer.file.import.cancel") })
  .strict();
export const explorerFileImportResultSchema = z
  .object({
    type: z.literal("explorer.file.imported"),
    value: z
      .object({
        offset: z.number().int().nonnegative().safe(),
        entry: explorerEntrySchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type ExplorerFileImportChunk = z.infer<
  typeof explorerFileImportChunkSchema
>;
