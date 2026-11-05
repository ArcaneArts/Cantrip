import { z } from "zod";
import { workerChatTurnOutcomeNotificationSchema } from "./worker-events.js";

// A protected response can contain 16 MiB plaintext, base64 expansion and metadata.
export const TASK_GOAL_OUTCOME_MAX_BYTES = 32 * 1_024 * 1_024;

/** Delivery of captured physical facts, never permission to execute input. */
export const taskGoalOutcomeDeliverySchema = z
  .object({
    version: z.literal(1),
    deliveryId: z.uuid(),
    serverId: z.string().min(1),
    ownerId: z.string().min(1),
    workerId: z.string().min(1),
    notification: workerChatTurnOutcomeNotificationSchema,
  })
  .strict();

export const taskGoalOutcomeCommitSchema = z
  .object({
    deliveryId: z.uuid(),
    taskInferenceInputOperationId: z.uuid(),
    committed: z.boolean(),
  })
  .strict();

export type TaskGoalOutcomeDelivery = z.infer<
  typeof taskGoalOutcomeDeliverySchema
>;
