import { z } from "zod";
import { workerChatTurnOutcomeNotificationSchema } from "./worker-events.js";

// A protected response can contain 16 MiB plaintext, base64 expansion and metadata.
export const TASK_GOAL_OUTCOME_MAX_BYTES = 32 * 1_024 * 1_024;

/** Delivery of captured physical facts, never permission to execute input. */
export const taskGoalOutcomeDeliverySchema = z
  .object({
    version: z.literal(1),
    // Existing version-one files contain captured Goal outcomes.
    inputKind: z.enum(["round", "goal"]).default("goal"),
    deliveryId: z.uuid(),
    serverId: z.string().min(1),
    ownerId: z.string().min(1),
    workerId: z.string().min(1),
    notification: workerChatTurnOutcomeNotificationSchema,
  })
  .strict();

const outcomeReceiptIdentity = {
  deliveryId: z.uuid(),
  taskInferenceInputOperationId: z.uuid(),
};
export const taskGoalOutcomeCommitSchema = z.discriminatedUnion("committed", [
  z.object({ ...outcomeReceiptIdentity, committed: z.literal(true) }).strict(),
  z
    .object({
      ...outcomeReceiptIdentity,
      committed: z.literal(false),
      retiredReason: z
        .enum([
          "canonical-input-deleted",
          "canonical-input-replaced",
          "canonical-input-deferred",
        ])
        .optional(),
    })
    .strict(),
]);

export type TaskGoalOutcomeDelivery = z.infer<
  typeof taskGoalOutcomeDeliverySchema
>;
