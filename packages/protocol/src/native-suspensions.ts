import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

const id = z.string().min(1).max(500);

/** The native RPC descriptor, without continuation contents or execution grants. */
export const nativeTurnSuspensionSchema = z
  .object({
    threadId: id,
    turnId: id,
    checkpointId: id,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Canonical Task round correlation, never another input or execution grant. */
export const nativeSuspensionTaskRoundSchema = z
  .object({
    operationId: z.uuid(),
    inputOperationId: z.uuid(),
    cycleId: z.uuid(),
  })
  .strict();
export type NativeSuspensionTaskRound = z.infer<
  typeof nativeSuspensionTaskRoundSchema
>;

/** Server-owned source identity. Worker-local paths and credentials stay on the worker. */
export const nativeSuspensionTargetSchema = z
  .object({
    workerId: id,
    contextKind: z.enum(["project", "standalone"]),
    projectId: id.nullable(),
    placementId: id,
    placementRevision: z.number().int().positive(),
    cantripOsBindingId: z.uuid().nullable(),
    executionLaneId: id.nullable(),
    modelRouteId: id.nullable(),
    providerAccountId: id.nullable(),
    threadId: id.nullable(),
    originalOperationId: id.nullable(),
    taskRound: nativeSuspensionTaskRoundSchema.optional(),
  })
  .strict();

/** Correlation with a current execution; this is not a reusable grant. */
export const nativeSuspensionActorSchema = z
  .object({
    workerGeneration: id,
    runtimeGeneration: id,
    operationId: id,
    operationGeneration: id,
  })
  .strict();

export const nativeSuspensionActiveTurnSchema = z
  .object({ threadId: id, turnId: id })
  .strict();

export const nativeSuspensionEvidenceSchema = z
  .object({
    suspension: nativeTurnSuspensionSchema,
    /** A persistent, worker-owned locator, never a caller-supplied filesystem path. */
    storageId: z.uuid(),
    runtimeVersion: z.string().min(1).max(200),
    /** Diagnostic only. Native restoration decides actual checkpoint compatibility. */
    runtimeFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

export const nativeSuspensionPhaseSchema = z.enum([
  "pausing",
  "paused",
  "resuming",
  "running",
  "stopping",
  "stopped",
  "completed",
  "failed",
  "error",
  "idle",
]);

export const nativeSuspensionErrorSchema = z
  .object({
    code: z.enum([
      "pause-failed",
      "restore-failed",
      "stop-failed",
      "worker-offline",
      "checkpoint-missing",
      "checkpoint-corrupt",
      "checkpoint-incompatible",
      "authority-changed",
      "storage-unavailable",
      "runtime-unavailable",
      "encryption-unavailable",
      "suspension-state-unreadable",
    ]),
    /** Native diagnostics can contain private data. Persist only their ciphertext. */
    protectedDetails: encryptedPayloadEnvelopeSchema.nullable(),
  })
  .strict();

export const nativeSuspensionRecordSchema = z
  .object({
    version: z.literal(1),
    controlId: z.uuid(),
    action: z.enum(["pause", "resume", "stop"]),
    phase: nativeSuspensionPhaseSchema,
    target: nativeSuspensionTargetSchema,
    active: nativeSuspensionActiveTurnSchema.nullable(),
    checkpoint: nativeSuspensionEvidenceSchema.nullable(),
    actor: nativeSuspensionActorSchema.nullable(),
    /** Current physical observer owner after cold adoption. Correlation only;
     * the original native input/provenance remains bound to target. */
    executionOwner: nativeSuspensionActorSchema.optional(),
    /** Set only by an explicit claim in this control epoch. */
    actorControlId: z.uuid().nullable(),
    error: nativeSuspensionErrorSchema.nullable(),
    requestedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    pausedAt: z.iso.datetime().nullable(),
    pausedMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    const task = value.target.taskRound;
    if (
      task &&
      (value.target.contextKind !== "project" ||
        !value.target.projectId ||
        !value.target.executionLaneId ||
        value.target.originalOperationId !== task.inputOperationId)
    )
      context.addIssue({
        code: "custom",
        path: ["target", "taskRound"],
        message:
          "A Task suspension must retain its canonical input and project lane.",
      });
    if (
      value.actorControlId !== null &&
      (value.actorControlId !== value.controlId || value.actor === null)
    )
      context.addIssue({
        code: "custom",
        path: ["actorControlId"],
        message: "An actor claim must belong to the current control.",
      });
    if (value.phase === "paused" && !value.checkpoint)
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "A durable paused turn requires its committed checkpoint.",
      });
    if (
      value.phase === "resuming" &&
      !value.checkpoint &&
      (value.action !== "resume" || !value.active)
    )
      context.addIssue({
        code: "custom",
        path: ["active"],
        message:
          "A live Resume requires its original active turn and resume intent.",
      });
    if (
      value.checkpoint &&
      value.target.threadId !== value.checkpoint.suspension.threadId
    )
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "A checkpoint must belong to its exact source thread.",
      });
    if (
      value.checkpoint &&
      (value.active?.threadId !== value.checkpoint.suspension.threadId ||
        value.active?.turnId !== value.checkpoint.suspension.turnId)
    )
      context.addIssue({
        code: "custom",
        path: ["active"],
        message: "A checkpoint must retain the original native turn identity.",
      });
    if (value.active && value.active.threadId !== value.target.threadId)
      context.addIssue({
        code: "custom",
        path: ["active"],
        message: "An active turn must belong to its exact source thread.",
      });
    if (
      ["stopped", "completed", "failed", "idle"].includes(value.phase) &&
      value.checkpoint
    )
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Terminal or idle turns cannot retain resumability.",
      });
    if (value.phase === "error" && !value.error)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "A recovery error requires an explicit error code.",
      });
  });

/** Public status omits machine-specific source, storage and runtime ownership. */
export const chatNativeSuspensionSchema = z
  .object({
    controlId: z.uuid().nullable(),
    action: z.enum(["pause", "resume", "stop"]).nullable(),
    phase: nativeSuspensionPhaseSchema,
    resumable: z.boolean(),
    active: nativeSuspensionActiveTurnSchema.nullable(),
    updatedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    pausedMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    error: nativeSuspensionErrorSchema.nullable(),
  })
  .strict();

export type NativeTurnSuspension = z.infer<typeof nativeTurnSuspensionSchema>;
export type NativeSuspensionTarget = z.infer<
  typeof nativeSuspensionTargetSchema
>;
export type NativeSuspensionActor = z.infer<typeof nativeSuspensionActorSchema>;
export type NativeSuspensionActiveTurn = z.infer<
  typeof nativeSuspensionActiveTurnSchema
>;
export type NativeSuspensionEvidence = z.infer<
  typeof nativeSuspensionEvidenceSchema
>;
export type NativeSuspensionError = z.infer<typeof nativeSuspensionErrorSchema>;
export type NativeSuspensionRecord = z.infer<
  typeof nativeSuspensionRecordSchema
>;
export type ChatNativeSuspension = z.infer<typeof chatNativeSuspensionSchema>;

export function isNativeSuspensionResumable(
  record: NativeSuspensionRecord,
): boolean {
  return (
    record.checkpoint !== null &&
    record.action !== "stop" &&
    (record.phase === "paused" ||
      (record.phase === "error" && record.action === "resume"))
  );
}

export function chatNativeSuspension(
  record: NativeSuspensionRecord,
): ChatNativeSuspension {
  return chatNativeSuspensionSchema.parse({
    controlId: record.controlId,
    action: record.action,
    phase: record.phase,
    resumable: isNativeSuspensionResumable(record),
    active: record.active,
    updatedAt: record.updatedAt,
    pausedAt: record.pausedAt,
    pausedMilliseconds: record.pausedMilliseconds,
    error: record.error,
  });
}

/** Invalid/unsupported metadata must not hide the chat or disclose raw bytes. */
export function storedChatNativeSuspension(
  value: unknown,
): ChatNativeSuspension {
  const result = nativeSuspensionRecordSchema.safeParse(value);
  if (result.success) return chatNativeSuspension(result.data);
  return {
    controlId: null,
    action: null,
    phase: "error",
    resumable: false,
    active: null,
    updatedAt: null,
    pausedAt: null,
    pausedMilliseconds: 0,
    error: { code: "suspension-state-unreadable", protectedDetails: null },
  };
}
