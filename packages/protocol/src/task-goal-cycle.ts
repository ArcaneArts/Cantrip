import { z } from "zod";

const id = z.string().min(1).max(4_096);

/** A fresh private Core Goal begin. An explicit Task input, restored turn,
 * independent helper or child may never obtain this identity by inference. */
export const taskGoalCycleIdentitySchema = z
  .object({
    cycleId: id,
    goalEpoch: id,
    scopeId: id,
    gateAttemptId: id,
    runnerGeneration: id,
    modelRouteId: id,
    providerAccountId: id.nullable(),
    orderEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** One delivery marker on the existing Task dispatch cycle. The actual worker
 * journal keeps its ordinal and owns capacity; no prompt is copied here. */
export const taskGoalCycleRecoverySchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: id,
    runtimeGeneration: z.uuid(),
    workerGeneration: z.uuid(),
    workerId: id,
    providerId: id,
    threadId: id,
    turnId: id,
    cycle: taskGoalCycleIdentitySchema,
    /** Current route for this same-provider recovery episode. The original
     * physical Source/cycle above is immutable keeper evidence. */
    binding: z
      .object({
        modelRouteId: id,
        providerAccountId: id.nullable(),
        orderEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    /** Advisory producer receipt, written only after actual journal enqueue.
     * It never grants capacity or retires the original FIFO Source. */
    admission: z
      .object({
        workerGeneration: z.uuid(),
        runtimeGeneration: z.uuid(),
        operationId: id,
      })
      .strict()
      .nullable()
      .optional(),
    /** Bounded retirement evidence for the Source and last replacement turn. */
    settled: z
      .object({
        reason: z.enum(["dispatched", "ineligible", "transferred"]),
        turnId: id,
        operationId: id.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Checked after the real private scope acquires and binds its journal lease,
 * before Core receives allow. This authorizes the current Task binding only;
 * the server never grants a provider ticket. */
export const taskGoalCycleDispatchSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
    serverId: id,
    workerId: id,
    workerGeneration: z.uuid(),
    chatId: id,
    providerId: id,
    threadId: id,
    turnId: id,
    operationId: id,
    cycle: taskGoalCycleIdentitySchema,
  })
  .strict();

export const taskGoalCycleDispatchResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const taskGoalCycleRecoveryReceiptSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("scheduled"),
        admission: z
          .object({
            operationId: id,
            runtimeGeneration: z.uuid(),
          })
          .strict(),
        sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
        workerGeneration: z.uuid(),
      })
      .strict(),
    z
      .object({
        status: z.literal("ineligible"),
        sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
        workerGeneration: z.uuid(),
        threadId: id,
        modelRouteId: id,
        providerAccountId: id.nullable(),
        nativeEpoch: id,
        observedGoalEpoch: id.nullable(),
        observedGoalStatus: z
          .enum([
            "active",
            "paused",
            "blocked",
            "usageLimited",
            "budgetLimited",
            "complete",
          ])
          .nullable(),
      })
      .strict(),
  ],
);

export type TaskGoalCycleIdentity = z.infer<typeof taskGoalCycleIdentitySchema>;
export type TaskGoalCycleRecovery = z.infer<typeof taskGoalCycleRecoverySchema>;
export type TaskGoalCycleDispatch = z.infer<typeof taskGoalCycleDispatchSchema>;
export type TaskGoalCycleRecoveryReceipt = z.infer<
  typeof taskGoalCycleRecoveryReceiptSchema
>;

/** Current logical binding, without inventing a physical scope or changing the
 * immutable keeper Source. Accounts/models in one provider retain its episode. */
export function taskGoalCycleRecoveryBinding(value: TaskGoalCycleRecovery) {
  return {
    cycleId: value.cycle.cycleId,
    goalEpoch: value.cycle.goalEpoch,
    orderEpoch: value.binding?.orderEpoch ?? value.cycle.orderEpoch,
    modelRouteId: value.binding?.modelRouteId ?? value.cycle.modelRouteId,
    providerAccountId: value.binding
      ? value.binding.providerAccountId
      : value.cycle.providerAccountId,
  };
}
