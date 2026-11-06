import { z } from "zod";

/** Server-derived current Task control scope. No prompt or model capacity. */
export const taskPauseScopeSchema = z
  .object({
    revision: z.number().int().positive().max(2_147_483_647),
    workerId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    modelRouteId: z.string().min(1).nullable(),
    providerAccountId: z.string().min(1).nullable(),
    cycleId: z.string().min(1).nullable(),
  })
  .strict();
export type TaskPauseScope = z.infer<typeof taskPauseScopeSchema>;
export const taskPauseIntentSchema = z
  .object({ paused: z.boolean(), scope: taskPauseScopeSchema })
  .strict();
export type TaskPauseIntent = z.infer<typeof taskPauseIntentSchema>;
