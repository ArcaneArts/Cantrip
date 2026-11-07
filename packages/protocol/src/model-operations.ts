import { z } from "zod";

/** A model may implement more than one operation; a profile selects one. */
export const modelOperationSchema = z.enum([
  "language",
  "embedding",
  "decision",
]);
export type ModelOperation = z.infer<typeof modelOperationSchema>;

export const modelOperationAdapterSchema = z.enum([
  "responses",
  "chat-completions",
  "openai-embeddings",
  "ollama-embed",
  "openai-decisions",
  "system-one",
  "openrouter-decisions",
]);

const positive = z.number().int().positive();
const modalities = z.array(z.string().trim().min(1).max(80)).max(32);
const operationCapabilitySchema = z.object({
  status: z.enum(["supported", "unsupported", "unknown"]),
  adapter: modelOperationAdapterSchema.nullable().optional(),
  inputModalities: modalities.nullable().optional(),
  maxInputTokens: positive.nullable().optional(),
  maxBatchSize: positive.nullable().optional(),
  maxRequestBytes: positive.nullable().optional(),
  maxMediaItems: positive.nullable().optional(),
  source: z.string().trim().min(1).max(160),
  observedAt: z.string().datetime().nullable().optional(),
});

export const modelOperationCapabilitiesSchema = z.object({
  language: operationCapabilitySchema.optional(),
  embedding: operationCapabilitySchema
    .extend({
      dimensions: positive.nullable().optional(),
      supportedDimensions: z.array(positive).max(128).nullable().optional(),
      configurableDimensions: z.boolean().nullable().optional(),
      vectorRepresentation: z
        .enum(["dense", "sparse", "multi-vector"])
        .nullable()
        .optional(),
      normalization: z.string().trim().min(1).max(80).nullable().optional(),
      inputTypes: z
        .array(z.string().trim().min(1).max(160))
        .max(128)
        .nullable()
        .optional(),
      mediaEncodings: z
        .array(z.string().trim().min(1).max(160))
        .max(128)
        .nullable()
        .optional(),
      embeddingSpace: z.string().trim().min(1).max(1_000).nullable().optional(),
    })
    .optional(),
  decision: operationCapabilitySchema
    .extend({
      questionTypes: z
        .array(z.string().trim().min(1).max(80))
        .max(64)
        .nullable()
        .optional(),
      maxQuestions: positive.nullable().optional(),
      maxChoices: positive.nullable().optional(),
      maxScoreLevels: positive.nullable().optional(),
      mediaEncodings: z
        .array(z.string().trim().min(1).max(160))
        .max(128)
        .nullable()
        .optional(),
    })
    .optional(),
});
export type ModelOperationCapabilities = z.infer<
  typeof modelOperationCapabilitiesSchema
>;

/** Omitted operation is a legacy language profile, not a capability inference. */
export function modelProfileOperation(profile: {
  operation?: ModelOperation;
}): ModelOperation {
  return profile.operation ?? "language";
}
