import { z } from "zod";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";
import { inferenceNativeExecutionSchema } from "./inference-native-execution.js";
export {
  inferenceNativeExecutionSchema,
  type InferenceNativeExecution,
} from "./inference-native-execution.js";
import {
  taskGoalCycleIdentitySchema,
  taskGoalCycleRecoverySchema,
} from "./task-goal-cycle.js";
import {
  nativeGoalRecoveryAdmissionSchema,
  nativeGoalRecoverySchema,
} from "./native-goal-recovery.js";

/** Admission metadata only: inputs remain in their existing encrypted queues. */
const identifier = z
  .string()
  .min(1)
  .max(4_096)
  // Under Unicode matching, valid surrogate pairs are a single code point.
  .regex(
    /^[^\uD800-\uDFFF]*$/u,
    "Admission identifiers must be valid Unicode.",
  );

export const inferenceRecoveryIdentitySchema = z
  .object({
    commandId: identifier.nullable().optional(),
    commandGeneration: identifier.nullable().optional(),
    messageId: identifier.nullable().optional(),
    threadId: identifier.nullable().optional(),
    turnId: identifier.nullable().optional(),
    // An actual managed pre-start Goal attempt. Private inference waits and
    // already-started/suspended turns must not acquire this replay identity.
    autonomousGoal: z
      .object({
        goalEpoch: identifier,
        orderEpoch: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict()
      .optional(),
    taskInput: taskInferenceInputReceiptSchema.nullable().optional(),
    taskGoalCycle: taskGoalCycleIdentitySchema.optional(),
  })
  .strict();

export const inferenceJournalIdentitySchema = z
  .object({
    operationId: identifier,
    providerId: identifier,
    runtimeGeneration: z.uuid(),
    recoveryKey: identifier.nullable(),
    recovery: inferenceRecoveryIdentitySchema.nullable(),
    chatId: identifier.nullable(),
    projectId: identifier.nullable(),
  })
  .strict();

export const inferenceJournalRecordSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    identity: inferenceJournalIdentitySchema,
    workerGeneration: z.uuid(),
    state: z.enum(["waiting", "granted", "released"]),
    order: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    everGranted: z.boolean(),
    nativeExecution: inferenceNativeExecutionSchema.optional(),
    outcome: z
      .enum([
        "completed",
        "failed",
        "interrupted",
        "runtime-exited",
        "never-started",
        "cancelled",
      ])
      .nullable(),
  })
  .strict();

export type InferenceRecoveryIdentity = z.infer<
  typeof inferenceRecoveryIdentitySchema
>;
export type InferenceJournalRecord = z.infer<
  typeof inferenceJournalRecordSchema
>;

/** A granted/resumed turn can have executed tools even while currently waiting. */
export function inferenceNeverStarted(record: InferenceJournalRecord): boolean {
  return (
    (!record.everGranted && record.state !== "granted") ||
    (record.state === "released" && record.outcome === "never-started")
  );
}

export const nativeInferenceRecoverySchema = z
  .object({
    serverId: identifier,
    workerId: identifier,
    workerGeneration: z.uuid(),
    record: inferenceJournalRecordSchema,
    /** Echo only after reading the actual keeper again for this admission.
     * An older logical alias must not revoke a newer reconstructed source. */
    expectedGoalAdmission: nativeGoalRecoveryAdmissionSchema.optional(),
  })
  .strict();

export const nativeInferenceRecoveryResultSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    disposition: z.enum(["requeued", "retired", "unresolved"]),
    chatId: identifier.nullable(),
    /** Canonical Task input authority was revoked before forwarding. A title
     * can have used the old reservation without consuming this Task input. */
    taskInputNotDispatched: z.boolean().optional(),
    /** Canonical pre-start Goal dispatch was revoked under its chat lock. */
    goalInputNotDispatched: z.boolean().optional(),
    /** Current canonical unused cycle, never a provider grant. Allows worker
     * preparation eligibility to follow this exact source and ordering epoch. */
    goalRecovery: nativeGoalRecoverySchema.optional(),
    /** A private Task cycle whose begin never reached model/tool execution. */
    taskGoalCycleNotDispatched: z.boolean().optional(),
    taskGoalRecovery: taskGoalCycleRecoverySchema.optional(),
    goalOwnershipChallenge: nativeGoalRecoveryAdmissionSchema.optional(),
  })
  .strict();

export type NativeInferenceRecovery = z.infer<
  typeof nativeInferenceRecoverySchema
>;
export type NativeInferenceRecoveryResult = z.infer<
  typeof nativeInferenceRecoveryResultSchema
>;
