import { z } from "zod";
import { fileDocumentPrivateStateOpaqueSchema } from "./surface-private-state.js";

// Paths stay inside authenticated ciphertext. Mode, cursor and placement are
// view state and must never be written into the shared document catalog.
export const fileDocumentCreateSchema = z
  .object({
    id: z.string().uuid(),
    worktreeId: z.string().min(1),
    stateProtection: fileDocumentPrivateStateOpaqueSchema,
  })
  .strict();

export const fileDocumentWireSummarySchema = fileDocumentCreateSchema
  .extend({
    projectId: z.string().min(1),
    workerId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export const fileDocumentWireListSchema = z.array(
  fileDocumentWireSummarySchema,
);
export type FileDocumentCreate = z.infer<typeof fileDocumentCreateSchema>;
export type FileDocumentWireSummary = z.infer<
  typeof fileDocumentWireSummarySchema
>;
