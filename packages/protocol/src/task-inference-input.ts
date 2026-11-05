import { z } from "zod";
import { taskDispatchFenceSchema } from "./task-scheduling.js";

const identity = z.string().min(1).max(200);

/** Canonical Task input authority, not permission to acquire provider capacity.
 * No prompt content is copied out of the existing encrypted Task round. */
export const taskInferenceInputReceiptSchema = z
  .object({
    operationId: z.uuid(),
    // Omitted for existing round receipts, preserving their journal identity.
    kind: z.literal("goal").optional(),
    chatId: identity,
    clientMessageId: identity,
    workerId: identity,
    worktreeId: identity,
    executionLaneId: identity,
    executionLaneActivatedAt: z.iso.datetime(),
    providerId: identity,
    modelRouteId: identity,
    providerAccountId: identity.nullable(),
    dispatch: taskDispatchFenceSchema,
  })
  .strict();

export const taskInferenceInputDispatchSchema = z
  .object({
    serverId: identity,
    workerId: identity,
    workerGeneration: z.uuid(),
    phase: z.enum(["accepted", "dispatch"]).default("dispatch"),
    receipt: taskInferenceInputReceiptSchema,
  })
  .strict();

export const taskInferenceInputDispatchResultSchema = z
  .object({ receipt: taskInferenceInputReceiptSchema })
  .strict();

export type TaskInferenceInputReceipt = z.infer<
  typeof taskInferenceInputReceiptSchema
>;
export type TaskInferenceInputDispatch = z.infer<
  typeof taskInferenceInputDispatchSchema
>;
