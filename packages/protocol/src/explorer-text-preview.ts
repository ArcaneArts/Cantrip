import { z } from "zod";

export const TEXT_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024;
export const TEXT_PREVIEW_PAGE_BYTES = 256 * 1024;
export const TEXT_PREVIEW_PAGE_LINES = 10_000;

export const explorerTextPreviewPageSchema = z
  .object({
    path: z.string().min(1).max(8_192),
    content: z.string().max(TEXT_PREVIEW_PAGE_BYTES),
    size: z.number().int().min(0).max(TEXT_PREVIEW_BYTES_LIMIT),
    offset: z.number().int().min(0).max(TEXT_PREVIEW_BYTES_LIMIT),
    nextOffset: z.number().int().min(0).max(TEXT_PREVIEW_BYTES_LIMIT),
    eof: z.boolean(),
    version: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type ExplorerTextPreviewPage = z.infer<
  typeof explorerTextPreviewPageSchema
>;
