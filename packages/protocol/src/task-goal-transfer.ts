import { z } from "zod";
import { inferenceJournalRecordSchema } from "./inference-recovery.js";
import { protectedNativeSettingsSnapshotSchema } from "./native-settings-state.js";
import type { TaskGoalCycleIdentity } from "./task-goal-cycle.js";
import type { InferenceJournalRecord } from "./inference-recovery.js";

/** Metadata for one actual private Task Goal scope. This is observation, not
 * permission to replay a Goal setter or execute the captured turn. */
export const taskGoalCycleSourceRecordSchema =
  inferenceJournalRecordSchema.superRefine((record, ctx) => {
    const recovery = record.identity.recovery;
    const cycle = recovery?.taskGoalCycle;
    const thread = recovery?.threadId;
    const turn = recovery?.turnId;
    if (
      !recovery ||
      !cycle ||
      !thread ||
      !turn ||
      !record.identity.chatId ||
      recovery.messageId ||
      recovery.commandId ||
      recovery.commandGeneration ||
      recovery.taskInput ||
      recovery.autonomousGoal ||
      record.identity.operationId !==
        `native-inference:${thread}:${turn}:${cycle.scopeId}:${cycle.gateAttemptId}` ||
      (record.nativeExecution &&
        (record.nativeExecution.threadId !== thread ||
          record.nativeExecution.turnId !== turn ||
          record.nativeExecution.scopeId !== cycle.scopeId))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid private Task Goal source",
      });
  });

export const taskGoalCycleCaptureSchema = z
  .object({
    record: taskGoalCycleSourceRecordSchema,
    snapshot: protectedNativeSettingsSnapshotSchema,
  })
  .strict()
  .superRefine(({ record, snapshot }, ctx) => {
    if (
      !["waiting", "granted"].includes(record.state) ||
      record.outcome !== null ||
      record.identity.chatId !== snapshot.context.chatId ||
      record.identity.recovery?.threadId !== snapshot.context.threadId
    )
      ctx.addIssue({
        code: "custom",
        message:
          "The native snapshot does not capture a pending Task Goal source",
      });
  });

export type TaskGoalCycleCapture = z.infer<typeof taskGoalCycleCaptureSchema>;

/** The Goal setter has already applied, but this canonical first input has
 * not been forwarded. Its receipt remains distinct from a private Goal cycle. */
export const taskGoalInputSourceRecordSchema =
  inferenceJournalRecordSchema.superRefine((record, ctx) => {
    const recovery = record.identity.recovery;
    const input = recovery?.taskInput;
    if (
      !input ||
      input.kind !== "goal" ||
      !recovery?.threadId ||
      recovery.turnId ||
      recovery.commandId ||
      recovery.commandGeneration ||
      recovery.taskGoalCycle ||
      recovery.autonomousGoal ||
      record.nativeExecution ||
      record.identity.operationId !== input.operationId ||
      record.identity.chatId !== input.chatId ||
      record.identity.providerId !== input.providerId ||
      recovery.messageId !== input.clientMessageId
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid unused Task Goal input source",
      });
  });
export const taskGoalInputTransferContextSchema = z
  .object({
    goalEpoch: z.string().min(1).max(4_096),
    runnerGeneration: z.string().min(1).max(4_096),
    orderEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceQueueRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type TaskGoalInputTransferContext = z.infer<
  typeof taskGoalInputTransferContextSchema
>;
export const taskGoalInputCaptureSchema = z
  .object({
    record: taskGoalInputSourceRecordSchema,
    snapshot: protectedNativeSettingsSnapshotSchema,
    taskGoalInput: taskGoalInputTransferContextSchema,
  })
  .strict()
  .superRefine(({ record, snapshot }, ctx) => {
    if (
      !["waiting", "granted"].includes(record.state) ||
      record.outcome !== null ||
      record.identity.chatId !== snapshot.context.chatId ||
      record.identity.recovery?.threadId !== snapshot.context.threadId
    )
      ctx.addIssue({
        code: "custom",
        message: "The snapshot does not capture an unused Task Goal input",
      });
  });
export const taskGoalHandoffCaptureSchema = z.union([
  taskGoalCycleCaptureSchema,
  taskGoalInputCaptureSchema,
]);
export type TaskGoalHandoffCapture = z.infer<
  typeof taskGoalHandoffCaptureSchema
>;

/** The common root/Goal identity does not turn an input receipt into a native
 * scope. Scope/attempt identities remain exclusive to the private cycle arm. */
export function taskGoalHandoffCycle(source: {
  taskGoal?: InferenceJournalRecord;
  taskGoalInput?: TaskGoalInputTransferContext;
}):
  | Pick<
      TaskGoalCycleIdentity,
      | "cycleId"
      | "goalEpoch"
      | "runnerGeneration"
      | "modelRouteId"
      | "providerAccountId"
      | "orderEpoch"
    >
  | undefined {
  const recovery = source.taskGoal?.identity.recovery;
  if (recovery?.taskGoalCycle) return recovery.taskGoalCycle;
  const receipt = recovery?.taskInput;
  return receipt?.kind === "goal" && source.taskGoalInput
    ? {
        goalEpoch: source.taskGoalInput.goalEpoch,
        runnerGeneration: source.taskGoalInput.runnerGeneration,
        orderEpoch: source.taskGoalInput.orderEpoch,
        cycleId: receipt.dispatch.cycleId,
        modelRouteId: receipt.modelRouteId,
        providerAccountId: receipt.providerAccountId,
      }
    : undefined;
}
