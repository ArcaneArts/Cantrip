import { z } from "zod";

export const LOG_TAIL_PAGE_BYTES = 256 * 1024;
export const logTailCursorSchema = z
  .object({
    offset: z.number().int().nonnegative().safe(),
    identity: z.string().regex(/^[a-f0-9]{64}$/u),
    anchor: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const explorerLogTailSchema = z
  .object({
    path: z.string().min(1).max(8_192),
    content: z.string().max(LOG_TAIL_PAGE_BYTES),
    startOffset: z.number().int().nonnegative().safe(),
    size: z.number().int().nonnegative().safe(),
    reset: z.boolean(),
    cursor: logTailCursorSchema,
  })
  .strict();
export type LogTailCursor = z.infer<typeof logTailCursorSchema>;
export type ExplorerLogTail = z.infer<typeof explorerLogTailSchema>;
