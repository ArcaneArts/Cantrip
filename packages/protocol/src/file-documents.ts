import { z } from "zod";
import { fileDocumentPrivateStateOpaqueSchema } from "./surface-private-state.js";

// Paths stay inside authenticated ciphertext. Mode, cursor and placement are
// view state and must never be written into the shared document catalog.
export const fileDocumentCreateSchema = z
  .object({
    id: z.string().uuid(),
    worktreeId: z.string().min(1),
    cantripOsBindingId: z.uuid().optional(),
    cantripOsRuntimeGeneration: z.uuid().optional(),
    stateProtection: fileDocumentPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) =>
      Boolean(input.cantripOsBindingId) ===
      Boolean(input.cantripOsRuntimeGeneration),
    {
      message:
        "OS file placement requires both binding and runtime generation.",
    },
  );

export const fileDocumentWireSummarySchema = fileDocumentCreateSchema
  .safeExtend({
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
