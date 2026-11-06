import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(4_096)
  .regex(
    /^[^\uD800-\uDFFF]*$/u,
    "Admission identifiers must be valid Unicode.",
  );

/** Actual Core correlation; this is not execution authority or replay proof. */
export const inferenceNativeExecutionSchema = z
  .object({ threadId: identity, turnId: identity, scopeId: identity })
  .strict();

export type InferenceNativeExecution = z.infer<
  typeof inferenceNativeExecutionSchema
>;
