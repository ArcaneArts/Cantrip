import { z } from "zod";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";
import { inferenceNativeExecutionSchema } from "./inference-native-execution.js";
import { nativeSuspensionActorSchema } from "./native-suspensions.js";
import { taskFailureKindSchema } from "./task-retry.js";
import { taskMessageOpaqueContentSchema } from "./tasks.js";

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

/** Actual autonomous native execution, separate from its completed parent input.
 * This records correlation and publication identity, never capacity or replay. */
export const taskGoalCycleSuspensionSourceSchema = z
  .object({
    kind: z.literal("goal-cycle"),
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: id,
    workerGeneration: z.uuid(),
    runtimeGeneration: z.uuid(),
    threadId: id,
    turnId: id,
    cycle: taskGoalCycleIdentitySchema,
    parent: taskInferenceInputReceiptSchema,
    publication: z
      .object({ id: z.uuid(), idempotencyKey: z.string().min(1).max(200) })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.parent.kind !== "goal" ||
      value.parent.dispatch.cycleId !== value.cycle.cycleId ||
      value.operationId !==
        `native-inference:${value.threadId}:${value.turnId}:${value.cycle.scopeId}:${value.cycle.gateAttemptId}`
    )
      context.addIssue({
        code: "custom",
        path: ["parent"],
        message:
          "Goal cycle suspension must retain its actual native execution and canonical parent.",
      });
  });
export type TaskGoalCycleSuspensionSource = z.infer<
  typeof taskGoalCycleSuspensionSourceSchema
>;

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
    suspension: z
      .object({
        source: taskGoalCycleSuspensionSourceSchema,
        /** Fresh execution ownership, separate from the immutable parent input. */
        restoration: z
          .object({
            controlId: z.uuid(),
            receipt: taskInferenceInputReceiptSchema,
            accepted: z.boolean(),
            dispatched: z.boolean(),
            claimWorkerGeneration: z.uuid().optional(),
            nativeExecution: inferenceNativeExecutionSchema.optional(),
            nativeOwner: z
              .object({
                workerGeneration: z.uuid(),
                runtimeGeneration: z.uuid(),
              })
              .strict()
              .optional(),
            checkpointActor: nativeSuspensionActorSchema,
            checkpointExecution: inferenceNativeExecutionSchema,
          })
          .strict()
          .optional(),
        terminal: z
          .object({
            ok: z.boolean(),
            failureKind: taskFailureKindSchema.nullable(),
            outcomeDigest: z.string().optional(),
            historyOnly: z.boolean().optional(),
            observedAt: z.iso.datetime(),
            projectedAt: z.iso.datetime().nullable(),
            threadId: z.string().nullable(),
            turnId: z.string().nullable(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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
    /** Present only for the actual fresh keeper Source, not a recovered alias. */
    freshRuntimeGeneration: z.uuid().optional(),
    nativeRuntimeGeneration: z.uuid().optional(),
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
  .object({
    accepted: z.literal(true),
    suspensionSource: taskGoalCycleSuspensionSourceSchema.optional(),
  })
  .strict();

/** Opt-in material for a worker observing a Goal without its original turn. */
export const taskGoalCycleDispatchPublicationResultSchema =
  taskGoalCycleDispatchResultSchema.extend({
    publicationPrompt: taskMessageOpaqueContentSchema.optional(),
  });

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
