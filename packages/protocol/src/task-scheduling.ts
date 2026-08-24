import { z } from "zod";

import { modelConfigurationSchema } from "./model-configuration.js";

export const TASK_PRIORITY_MIN = -1_000_000;
export const TASK_PRIORITY_MAX = 1_000_000;
export const TASK_WORKER_CONCURRENCY_MAX = 64;

export const taskPrioritySchema = z
  .number()
  .int()
  .min(TASK_PRIORITY_MIN)
  .max(TASK_PRIORITY_MAX);

export const taskWorkerContinuityFamilySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u, {
    message:
      "Continuity family must use lowercase letters, numbers, and simple separators.",
  });

export const taskWorkerModelConfigurationSchema =
  modelConfigurationSchema.refine(
    (configuration) => configuration.modelId !== null,
    {
      message: "A Task Worker root model must be selected.",
      path: ["modelId"],
    },
  );

const taskWorkerMutableFields = {
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  modelConfiguration: taskWorkerModelConfigurationSchema,
  maxConcurrency: z.number().int().min(1).max(TASK_WORKER_CONCURRENCY_MAX),
  allowsPlanGoal: z.boolean(),
  continuityFamilyOverride: taskWorkerContinuityFamilySchema.nullable(),
} as const;

export const taskWorkerCreateSchema = z
  .object({
    name: taskWorkerMutableFields.name,
    enabled: taskWorkerMutableFields.enabled.default(true),
    modelConfiguration: taskWorkerMutableFields.modelConfiguration,
    maxConcurrency: taskWorkerMutableFields.maxConcurrency.default(1),
    allowsPlanGoal: taskWorkerMutableFields.allowsPlanGoal.default(false),
    continuityFamilyOverride:
      taskWorkerMutableFields.continuityFamilyOverride.default(null),
  })
  .strict();

export const taskWorkerUpdateSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    name: taskWorkerMutableFields.name.optional(),
    enabled: taskWorkerMutableFields.enabled.optional(),
    modelConfiguration: taskWorkerMutableFields.modelConfiguration.optional(),
    maxConcurrency: taskWorkerMutableFields.maxConcurrency.optional(),
    allowsPlanGoal: taskWorkerMutableFields.allowsPlanGoal.optional(),
    continuityFamilyOverride:
      taskWorkerMutableFields.continuityFamilyOverride.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.enabled !== undefined ||
      input.modelConfiguration !== undefined ||
      input.maxConcurrency !== undefined ||
      input.allowsPlanGoal !== undefined ||
      input.continuityFamilyOverride !== undefined,
    { message: "A Task Worker update must change at least one field." },
  );

export const taskWorkerDeleteSchema = z
  .object({ rowVersion: z.number().int().positive() })
  .strict();

export const taskWorkerOrderUpdateSchema = z
  .object({
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Task Worker ordering IDs must be unique.",
      }),
  })
  .strict();

export const taskWorkerSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: taskWorkerMutableFields.name,
    enabled: z.boolean(),
    modelConfiguration: taskWorkerModelConfigurationSchema,
    maxConcurrency: taskWorkerMutableFields.maxConcurrency,
    allowsPlanGoal: z.boolean(),
    continuityFamily: taskWorkerContinuityFamilySchema,
    continuityFamilyOverride: taskWorkerContinuityFamilySchema.nullable(),
    position: z.number().int().nonnegative(),
    activeTaskCount: z.number().int().nonnegative(),
    rowVersion: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const taskWorkerListSchema = z.array(taskWorkerSummarySchema).max(256);

export const taskDispatchOperationKindSchema = z.enum([
  "direct",
  "initial-plan",
  "continue-plan",
  "finalize",
  "goal-continuation",
]);

export const taskDispatchCycleStateSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const taskDispatchEligibilityCodeSchema = z.enum([
  "assignment-mismatch",
  "capacity-unavailable",
  "continuity-mismatch",
  "encryption-grant-unavailable",
  "model-unavailable",
  "plan-goal-unsupported",
  "placement-unavailable",
  "project-paused",
  "provider-route-unavailable",
  "reconciliation-required",
  "task-worker-disabled",
  "worker-offline",
]);

export const taskDispatchFenceSchema = z
  .object({
    cycleId: z.string().uuid(),
    operationId: z.string().min(1).max(200),
    leaseOwner: z.string().min(1).max(200),
    fencingToken: z.number().int().positive(),
  })
  .strict();

export const taskDispatchWorkerLeaseSchema = taskDispatchFenceSchema
  .extend({
    leaseExpiresAt: z.iso.datetime(),
  })
  .strict();

export const taskDispatchCycleSummarySchema = z
  .object({
    id: z.string().uuid(),
    chatId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
    operationKind: taskDispatchOperationKindSchema,
    state: taskDispatchCycleStateSchema,
    fifoCreatedAt: z.iso.datetime(),
    requestedTaskWorkerId: z.string().uuid().nullable(),
    selectedTaskWorkerId: z.string().uuid().nullable(),
    taskWorkerRevision: z.number().int().positive().nullable(),
    continuityFamily: taskWorkerContinuityFamilySchema.nullable(),
    modelConfiguration: taskWorkerModelConfigurationSchema.nullable(),
    modelRouteId: z.string().min(1).max(200).nullable(),
    providerAccountId: z.string().min(1).max(200).nullable(),
    physicalWorkerId: z.string().min(1).max(200).nullable(),
    worktreeId: z.string().min(1).max(200).nullable(),
    codexThreadId: z.string().min(1).max(500).nullable(),
    turnId: z.string().min(1).max(500).nullable(),
    leaseOwner: z.string().min(1).max(200).nullable(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    lastHeartbeatAt: z.iso.datetime().nullable(),
    fencingToken: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    eligibilityCode: taskDispatchEligibilityCodeSchema.nullable(),
    queuedAt: z.iso.datetime(),
    claimedAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const taskDispatchCycleListSchema = z
  .array(taskDispatchCycleSummarySchema)
  .max(10_000);

export const projectTaskPauseStateSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    paused: z.boolean(),
    pausedAt: z.iso.datetime().nullable(),
    rowVersion: z.number().int().positive(),
  })
  .strict();

export const projectTaskPauseUpdateSchema = z
  .object({
    paused: z.boolean(),
    rowVersion: z.number().int().positive(),
  })
  .strict();

export type TaskWorkerCreate = z.infer<typeof taskWorkerCreateSchema>;
export type TaskWorkerUpdate = z.infer<typeof taskWorkerUpdateSchema>;
export type TaskWorkerOrderUpdate = z.infer<typeof taskWorkerOrderUpdateSchema>;
export type TaskWorkerSummary = z.infer<typeof taskWorkerSummarySchema>;
export type TaskDispatchOperationKind = z.infer<
  typeof taskDispatchOperationKindSchema
>;
export type TaskDispatchCycleState = z.infer<
  typeof taskDispatchCycleStateSchema
>;
export type TaskDispatchEligibilityCode = z.infer<
  typeof taskDispatchEligibilityCodeSchema
>;
export type TaskDispatchFence = z.infer<typeof taskDispatchFenceSchema>;
export type TaskDispatchWorkerLease = z.infer<
  typeof taskDispatchWorkerLeaseSchema
>;
export type TaskDispatchCycleSummary = z.infer<
  typeof taskDispatchCycleSummarySchema
>;
export type ProjectTaskPauseState = z.infer<typeof projectTaskPauseStateSchema>;
export type ProjectTaskPauseUpdate = z.infer<
  typeof projectTaskPauseUpdateSchema
>;
