import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

const id = z.string().min(1).max(255);
/** RPC acceptance and native settings application are independent facts. */
export const nativeSettingsApplicationSchema = z
  .object({
    nativeOperationId: id,
    submissionId: id.nullable(),
    status: z.enum(["pending", "applied", "rejected", "uncertain"]),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();
export type NativeSettingsApplication = z.infer<
  typeof nativeSettingsApplicationSchema
>;

/** The complete native snapshot/error is encrypted on the worker. */
export const nativeSettingsEvidenceSchema = z
  .object({
    workerId: id,
    operationId: id,
    operationGeneration: id,
    eventId: z.string().uuid(),
    threadId: id,
    runtimeGeneration: id,
    nativeOperationId: id,
    submissionId: id.nullable(),
    kind: z.enum([
      "queued",
      "applied",
      "rejected",
      "transport-lost",
      "correlation-conflict",
    ]),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    protectedResult: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.kind === "queued" || value.kind === "applied") &&
      !value.submissionId
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Native queue/application evidence requires a submission identity.",
      });
  });
export type NativeSettingsEvidence = z.infer<
  typeof nativeSettingsEvidenceSchema
>;
export const nativeSettingsEvidenceResultSchema = z
  .object({
    operationId: id,
    operationGeneration: id,
    eventId: z.string().uuid(),
    application: nativeSettingsApplicationSchema,
  })
  .strict();
export type NativeSettingsEvidenceResult = z.infer<
  typeof nativeSettingsEvidenceResultSchema
>;
