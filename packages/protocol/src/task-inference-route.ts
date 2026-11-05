import { z } from "zod";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";
import { nativeRuntimeHandoffInventorySchema } from "./native-runtime-handoff.js";

const id = z.string().min(1).max(200);
export const taskInferenceRouteChangeRequestSchema = z
  .object({
    operationId: z.uuid(),
    inputOperationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    targetModelRouteId: id,
    targetProviderAccountId: id.nullable(),
  })
  .strict();
export const taskInferenceRouteChangeSchema =
  taskInferenceRouteChangeRequestSchema
    .extend({
      source: taskInferenceInputReceiptSchema,
      phase: z.enum(["draining", "completed", "cancelled"]),
      queuedFencingToken: z.number().int().nonnegative(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
    })
    .strict();
export const taskInferenceRouteViewSchema = z
  .object({
    chatId: id,
    revision: z.number().int().positive(),
    source: taskInferenceInputReceiptSchema.nullable(),
    latest: taskInferenceRouteChangeSchema.nullable(),
    providers: nativeRuntimeHandoffInventorySchema.shape.providers,
  })
  .strict();
export const taskInferenceRouteSettlementSchema = z
  .object({
    operationId: z.uuid(),
    source: taskInferenceInputReceiptSchema,
    ownerId: id,
    serverId: id,
    workerId: id,
    workerGeneration: z.uuid(),
    settled: z.boolean(),
  })
  .strict();
export type TaskInferenceRouteChange = z.infer<
  typeof taskInferenceRouteChangeSchema
>;
export type TaskInferenceRouteChangeRequest = z.infer<
  typeof taskInferenceRouteChangeRequestSchema
>;
export type TaskInferenceRouteView = z.infer<
  typeof taskInferenceRouteViewSchema
>;
