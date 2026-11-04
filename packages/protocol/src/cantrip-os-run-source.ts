import { z } from "zod";
import {
  cantripOsInstanceSummarySchema,
  cantripOsSourceBindingSummarySchema,
  cantripOsWorkspaceSummarySchema,
} from "./cantrip-os.js";
import { projectWorktreeSummarySchema } from "./worktrees.js";

/** Logical Run targets have a display label, never a Worker filesystem path. */
export const cantripOsRunSourceSchema = z
  .object({
    binding: cantripOsSourceBindingSummarySchema,
    instance: cantripOsInstanceSummarySchema,
    workspace: cantripOsWorkspaceSummarySchema,
    target: projectWorktreeSummarySchema.pick({
      id: true,
      workerId: true,
      isPrimary: true,
      isDefault: true,
      name: true,
      branch: true,
      lifecycleState: true,
      displayPath: true,
    }),
    available: z.boolean(),
  })
  .strict();
export type CantripOsRunSource = z.infer<typeof cantripOsRunSourceSchema>;
