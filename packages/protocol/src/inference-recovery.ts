import { z } from "zod";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";

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
    taskInput: taskInferenceInputReceiptSchema.nullable().optional(),
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
  })
  .strict();

export type NativeInferenceRecovery = z.infer<
  typeof nativeInferenceRecoverySchema
>;
export type NativeInferenceRecoveryResult = z.infer<
  typeof nativeInferenceRecoveryResultSchema
>;
