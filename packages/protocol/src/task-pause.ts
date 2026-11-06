import { z } from "zod";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";
import {
  nativeSuspensionActiveTurnSchema,
  nativeSuspensionActorSchema,
  nativeSuspensionEvidenceSchema,
  nativeSuspensionTaskRoundSchema,
} from "./native-suspensions.js";

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
    taskRound: nativeSuspensionTaskRoundSchema.optional(),
    // Omitted by older senders; never reset an already known FIFO episode.
    orderEpoch: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
export type TaskPauseScope = z.infer<typeof taskPauseScopeSchema>;
export const taskPauseIntentSchema = z
  .object({ paused: z.boolean(), scope: taskPauseScopeSchema })
  .strict();
export type TaskPauseIntent = z.infer<typeof taskPauseIntentSchema>;

/** Private worker acknowledgement. The server publishes only the suspension
 * projection after committing this evidence against the canonical Task owner. */
export const taskPauseRuntimeStateSchema = z
  .object({
    paused: z.boolean(),
    active: nativeSuspensionActiveTurnSchema.nullable(),
    execution: z
      .object({
        actor: nativeSuspensionActorSchema,
        checkpoint: nativeSuspensionEvidenceSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TaskPauseRuntimeState = z.infer<typeof taskPauseRuntimeStateSchema>;

/** Saved source correlation only. A resumed execution separately acquires a
 * fresh canonical input receipt and native/runtime admission. */
export const taskTurnResumptionSchema = z
  .object({
    controlId: z.uuid(),
    checkpoint: nativeSuspensionEvidenceSchema,
    source: taskInferenceInputReceiptSchema,
  })
  .strict();
export type TaskTurnResumption = z.infer<typeof taskTurnResumptionSchema>;

/** A cancellation control grants no inference or input replay. The worker must
 * acknowledge the named native turn through its current transport. */
export const taskTurnStopSchema = z
  .object({
    controlId: z.uuid(),
    source: taskInferenceInputReceiptSchema,
    active: nativeSuspensionActiveTurnSchema,
    checkpoint: nativeSuspensionEvidenceSchema.nullable(),
    scope: taskPauseScopeSchema,
  })
  .strict();
export type TaskTurnStop = z.infer<typeof taskTurnStopSchema>;
export const taskTurnStopResultSchema = z
  .object({
    controlId: z.uuid(),
    interrupted: z.literal(true),
    active: nativeSuspensionActiveTurnSchema,
    actor: nativeSuspensionActorSchema,
    outcome: z.enum(["stopped", "completed", "failed"]),
  })
  .strict();
