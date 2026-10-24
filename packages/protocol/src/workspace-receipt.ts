import { z } from "zod";
import { workspaceOwnershipSchema } from "./workspace-ownership.js";

export const workspaceReceiptSchema = z
  .object({
    layout: workspaceOwnershipSchema,
    operationId: z.string().min(1),
    appliedRevision: z.int().nonnegative(),
    replayed: z.boolean(),
    focusWindowId: z.string().min(1).nullable(),
    emptyWindowIds: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (r) => r.appliedRevision <= r.layout.revision,
    "Receipt is newer than its layout",
  );
export type WorkspaceReceipt = z.infer<typeof workspaceReceiptSchema>;
