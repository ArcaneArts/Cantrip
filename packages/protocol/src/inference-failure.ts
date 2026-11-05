import { z } from "zod";

/** Worker execution evidence, never inferred from missing server/UI activity. */
const identity = {
  operationId: z.string().min(1).max(4_096),
  chatId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
};
export const inferenceFailureEvidenceSchema = z.discriminatedUnion(
  "disposition",
  [
    z
      .object({
        ...identity,
        disposition: z.literal("input-not-dispatched"),
        runtimeGeneration: z.uuid().nullable(),
        threadId: z.string().min(1).max(200).nullable(),
        turnId: z.string().min(1).max(200).nullable(),
        nativeScopeId: z.null(),
      })
      .strict(),
    z
      .object({
        ...identity,
        disposition: z.literal("model-failed-before-output"),
        runtimeGeneration: z.uuid(),
        threadId: z.string().min(1).max(200),
        turnId: z.string().min(1).max(200),
        nativeScopeId: z.uuid(),
      })
      .strict(),
  ],
);

export type InferenceFailureEvidence = z.infer<
  typeof inferenceFailureEvidenceSchema
>;
