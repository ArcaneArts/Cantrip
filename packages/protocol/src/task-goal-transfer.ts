import { z } from "zod";
import { inferenceJournalRecordSchema } from "./inference-recovery.js";
import { protectedNativeSettingsSnapshotSchema } from "./native-settings-state.js";

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
