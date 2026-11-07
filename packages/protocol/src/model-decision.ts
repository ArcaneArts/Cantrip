import { z } from "zod";
import { boundedJsonValueSchema } from "./bounded-json.js";
import { modelOperationOptionsSchema } from "./model-operations.js";
import {
  MODEL_OPERATION_CONTENT_BYTES_LIMIT,
  modelInputPartSchema,
  modelOperationFailureSchema,
  modelOperationRouteSchema,
  protectedEmbeddingRequestSchema,
  protectedEmbeddingResponseSchema,
} from "./model-embedding.js";

const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const instructions = z.string().min(1).max(100000);
const option = z.object({ id: name, description: instructions }).strict();
const distinct = (values: { id: string }[]) =>
  new Set(values.map((v) => v.id)).size === values.length;
const fits = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <=
  MODEL_OPERATION_CONTENT_BYTES_LIMIT;
export const decisionQuestionSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: name,
      type: z.literal("predicate"),
      instructions,
      criteria: z
        .object({ true: instructions, false: instructions })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      id: name,
      type: z.literal("choice"),
      instructions,
      choices: z
        .array(option)
        .min(2)
        .max(100)
        .refine(distinct, "Choice IDs must be unique."),
    })
    .strict(),
  z
    .object({
      id: name,
      type: z.literal("score"),
      instructions,
      levels: z
        .array(option)
        .min(2)
        .max(100)
        .refine(distinct, "Level IDs must be unique."),
    })
    .strict(),
]);
export const decisionInputSchema = z
  .object({
    state: boundedJsonValueSchema,
    media: z
      .array(
        z.discriminatedUnion("type", [
          modelInputPartSchema.options[1],
          modelInputPartSchema.options[2],
          modelInputPartSchema.options[3],
        ]),
      )
      .max(128)
      .optional(),
    questions: z
      .array(decisionQuestionSchema)
      .min(1)
      .max(400)
      .refine(distinct, "Question IDs must be unique."),
    options: modelOperationOptionsSchema.optional(),
  })
  .strict()
  .refine(fits, "Decision input exceeds 4 MiB.");
const probability = z.number().finite().min(0).max(1);
const common = { id: name, nativeAnswer: boundedJsonValueSchema };
const distribution = z
  .array(z.object({ id: name, probability }).strict())
  .min(2)
  .max(100)
  .nullable();
export const decisionAnswerSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("predicate"), probability }).strict(),
  z
    .object({
      ...common,
      type: z.literal("choice"),
      choice: name,
      probabilities: distribution,
      confidence: probability.nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("score"),
      score: z.number().finite(),
      probabilities: distribution,
      confidence: probability.nullable(),
      levels: z.array(option).min(2).max(100),
      semantics: z.literal("probability-weighted-zero-based-index"),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("refusal"),
      reason: z.string().max(100000).nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("error"),
      error: boundedJsonValueSchema,
    })
    .strict(),
]);
const count = z.number().int().nonnegative().nullable();
export const decisionResultSchema = z
  .object({
    modelId: z.string().min(1),
    routeId: z.string().min(1),
    providerId: z.string().min(1),
    requestedModel: z.string().min(1),
    actualModel: z.string().min(1).nullable(),
    actualProvider: z.string().min(1).nullable(),
    adapter: z.enum(["openai-decisions", "system-one", "openrouter-decisions"]),
    status: z.enum(["complete", "partial"]),
    answers: z.array(decisionAnswerSchema).min(1).max(400),
    usage: z
      .object({
        inputTokens: count,
        outputTokens: count,
        totalTokens: count,
        cost: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export const decisionOutcomeSchema = z
  .discriminatedUnion("status", [
    z
      .object({ status: z.literal("succeeded"), value: decisionResultSchema })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        error: modelOperationFailureSchema,
      })
      .strict(),
  ])
  .refine(fits, "Decision output exceeds 4 MiB.");
export const protectedDecisionRequestSchema = protectedEmbeddingRequestSchema;
export const protectedDecisionResponseSchema = protectedEmbeddingResponseSchema;
export const modelDecisionCommandSchema = protectedDecisionRequestSchema
  .extend({
    type: z.literal("model.decision"),
    serverId: z.string().min(1).max(2000),
    route: modelOperationRouteSchema,
  })
  .strict();
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;
