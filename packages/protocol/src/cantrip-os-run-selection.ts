import { z } from "zod";

/** Client selections contain identities only. The Server resolves owned paths,
 * accounts and transports, or loads an existing runtime's immutable capture. */
export const cantripOsRunSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("binding"),
      bindingId: z.uuid(),
      bindingGeneration: z.uuid(),
      attachmentGeneration: z.uuid(),
      runtimeGeneration: z.uuid(),
    })
    .strict(),
  z.object({ kind: z.literal("runtime"), runtimeId: z.uuid() }).strict(),
]);
export type CantripOsRunSelection = z.infer<typeof cantripOsRunSelectionSchema>;
