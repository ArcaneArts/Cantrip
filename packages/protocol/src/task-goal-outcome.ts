import { z } from "zod";
import { workerChatTurnOutcomeNotificationSchema } from "./worker-events.js";
import { taskGoalCycleSuspensionSourceSchema } from "./task-goal-cycle.js";

// A protected response can contain 16 MiB plaintext, base64 expansion and metadata.
export const TASK_GOAL_OUTCOME_MAX_BYTES = 32 * 1_024 * 1_024;

/** Delivery of captured physical facts, never permission to execute input. */
export const taskGoalOutcomeDeliverySchema = z
  .object({
    version: z.literal(1),
    // Existing version-one files contain captured Goal outcomes.
    inputKind: z.enum(["round", "goal", "goal-cycle"]).default("goal"),
    deliveryId: z.uuid(),
    serverId: z.string().min(1),
    ownerId: z.string().min(1),
    workerId: z.string().min(1),
    notification: workerChatTurnOutcomeNotificationSchema,
    goalCycleSource: taskGoalCycleSuspensionSourceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.inputKind === "goal-cycle") !== Boolean(value.goalCycleSource) ||
      (value.goalCycleSource &&
        (value.notification.taskInferenceInputOperationId ||
          value.notification.chatId !== value.goalCycleSource.parent.chatId ||
          value.notification.clientMessageId !==
            value.goalCycleSource.parent.clientMessageId))
    )
      context.addIssue({
        code: "custom",
        path: ["goalCycleSource"],
        message:
          "An autonomous Goal result must retain its actual source without inventing input.",
      });
  });

const outcomeReceiptIdentity = {
  deliveryId: z.uuid(),
  taskInferenceInputOperationId: z.uuid().optional(),
  goalCycleSourceKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
};
export const taskGoalOutcomeCommitSchema = z
  .discriminatedUnion("committed", [
    z
      .object({ ...outcomeReceiptIdentity, committed: z.literal(true) })
      .strict(),
    z
      .object({
        ...outcomeReceiptIdentity,
        committed: z.literal(false),
        retiredReason: z
          .enum([
            "canonical-input-deleted",
            "canonical-input-replaced",
            "canonical-input-deferred",
            "goal-cycle-replaced",
            "goal-cycle-restored",
          ])
          .optional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      Boolean(value.taskInferenceInputOperationId) ===
      Boolean(value.goalCycleSourceKey)
    )
      context.addIssue({
        code: "custom",
        message: "A committed outcome must name exactly one physical source.",
      });
  });

export type TaskGoalOutcomeDelivery = z.infer<
  typeof taskGoalOutcomeDeliverySchema
>;
