import { z } from "zod";
import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
} from "./endpoint-content.js";
import {
  modelOperationAdapterSchema,
  modelOperationOptionsSchema,
  modelOperationCapabilitiesSchema,
} from "./model-operations.js";
import { workerRuntimeProviderSchema } from "./worker-runtime-support.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

// Leave room for encryption, route metadata and the worker's 8 MiB control frame.
export const MODEL_OPERATION_CONTENT_BYTES_LIMIT = 4 * 1024 * 1024;
export const MODEL_OPERATION_WIRE_BYTES_LIMIT = 7 * 1024 * 1024;
const contentFits = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <=
  MODEL_OPERATION_CONTENT_BYTES_LIMIT;
// Express the ciphertext bound structurally so the Rust contract exporter
// preserves it as well as the JavaScript validator.
const protectedContent = z
  .object({
    ...endpointContentOpaqueSchema.shape,
    domain: z.literal("model-operation-content"),
    envelope: encryptedPayloadEnvelopeSchema.extend({
      ciphertext: encryptedPayloadEnvelopeSchema.shape.ciphertext.max(
        4 * Math.ceil((MODEL_OPERATION_CONTENT_BYTES_LIMIT + 16) / 3),
      ),
    }),
  })
  .strict();
const identity = z.string().min(1).max(500);
const mediaUrl = z
  .string()
  .min(1)
  .max(MODEL_OPERATION_CONTENT_BYTES_LIMIT)
  .refine((value) => {
    try {
      return ["https:", "http:", "data:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL or inline data URL.");

export const modelInputPartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().min(1).max(MODEL_OPERATION_CONTENT_BYTES_LIMIT),
    })
    .strict(),
  z.object({ type: z.literal("image"), url: mediaUrl }).strict(),
  z.object({ type: z.literal("audio"), url: mediaUrl }).strict(),
  z.object({ type: z.literal("video"), url: mediaUrl }).strict(),
]);
export const embeddingSpaceIdentitySchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    modelId: identity,
    routeId: identity,
    providerId: identity,
    requestedModel: identity,
    actualModel: identity.nullable(),
    modelRevision: z.string().max(1000).nullable(),
    revisionVerified: z.boolean(),
    revisionSource: z.enum(["provider-catalog", "configured", "unknown"]),
    dimensions: z.number().int().positive().max(65536),
    normalization: z.string().max(80),
    inputType: z.string().max(160).nullable(),
    configuredSpace: z.string().max(1000).nullable(),
  })
  .strict();
export const embeddingInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: identity,
            content: z.array(modelInputPartSchema).min(1).max(128),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    options: modelOperationOptionsSchema.optional(),
    expectedSpace: embeddingSpaceIdentitySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length,
    "Embedding item IDs must be unique.",
  )
  .refine(contentFits, "Embedding input exceeds 4 MiB. Submit smaller jobs.");
export const embeddingResultSchema = z
  .object({
    space: embeddingSpaceIdentitySchema,
    items: z
      .array(
        z
          .object({
            id: identity,
            index: z.number().int().nonnegative(),
            representation: z.literal("dense"),
            values: z.array(z.number().finite()).min(1).max(65536),
            sourceEncoding: z.enum(["float", "base64"]),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        totalTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    batches: z.number().int().positive(),
  })
  .strict();
export const modelOperationFailureSchema = z
  .object({
    code: z.enum([
      "configuration-required",
      "invalid-request",
      "unsupported-input",
      "provider-error",
      "invalid-response",
      "embedding-space-mismatch",
      "cancelled",
    ]),
    message: z.string().min(1).max(2000),
    httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  })
  .strict();
export const embeddingOutcomeSchema = z
  .discriminatedUnion("status", [
    z
      .object({ status: z.literal("succeeded"), value: embeddingResultSchema })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        error: modelOperationFailureSchema,
      })
      .strict(),
  ])
  .refine(contentFits, "Embedding output exceeds 4 MiB. Submit smaller jobs.");
export const modelOperationScopeSchema = z
  .object({
    workerId: z.string().min(1).max(255),
    modelId: z.string().min(1).max(255).nullable(),
    routeId: z.string().min(1).max(255).nullable().default(null),
  })
  .strict();
export const protectedEmbeddingRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    scope: modelOperationScopeSchema,
    protectedRequest: protectedContent,
  })
  .strict();
export const protectedEmbeddingResponseSchema = z
  .object({
    operationId: z.string().uuid(),
    scope: modelOperationScopeSchema,
    protectedResponse: protectedContent,
  })
  .strict();
export const modelOperationCancelSchema = protectedEmbeddingRequestSchema.omit({
  protectedRequest: true,
});
export const modelOperationCancelResultSchema = z
  .object({ operationId: z.string().uuid(), cancelled: z.boolean() })
  .strict();
export const modelOperationRouteSchema = z
  .object({
    modelId: identity,
    routeId: identity,
    modelName: identity,
    adapter: modelOperationAdapterSchema.nullable(),
    options: modelOperationOptionsSchema,
    capabilities: modelOperationCapabilitiesSchema.default({}),
    observedRevision: z.string().max(1000).nullable().default(null),
    provider: workerRuntimeProviderSchema,
  })
  .strict();
export const modelEmbeddingCommandSchema = protectedEmbeddingRequestSchema
  .extend({
    type: z.literal("model.embedding"),
    serverId: z.string().min(1).max(2000),
    route: modelOperationRouteSchema,
  })
  .strict();
export const modelOperationCancelCommandSchema = modelOperationCancelSchema
  .extend({
    type: z.literal("model.operation.cancel"),
    serverId: z.string().min(1).max(2000),
  })
  .strict();
export function modelOperationContentContext(input: {
  serverId: string;
  operationId: string;
  scope: z.infer<typeof modelOperationScopeSchema>;
  direction: "request" | "response";
}) {
  return endpointContentContextSchema.parse({
    domain: "model-operation-content",
    serverId: input.serverId,
    workerId: input.scope.workerId,
    scopeId: JSON.stringify([
      input.scope.workerId,
      input.scope.modelId,
      input.scope.routeId,
    ]),
    operationId: input.operationId,
    operation: "embedding",
    direction: input.direction,
    sequence: 0,
  });
}
export type EmbeddingInput = z.infer<typeof embeddingInputSchema>;
export type EmbeddingResult = z.infer<typeof embeddingResultSchema>;
export type EmbeddingSpaceIdentity = z.infer<
  typeof embeddingSpaceIdentitySchema
>;
export type ModelOperationRoute = z.infer<typeof modelOperationRouteSchema>;
