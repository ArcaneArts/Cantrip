import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT = 16 * 1_024 * 1_024;

export const endpointContentDomainSchema = z.enum([
  "run-content",
  "customization-content",
  "tunnel-content",
]);

export const endpointContentDirectionSchema = z.enum([
  "request",
  "response",
  "event",
  "stored",
]);

/**
 * Authenticated endpoint context. The relay may route these values, but it
 * cannot alter them without making the protected payload fail to open.
 */
export const endpointContentContextSchema = z
  .object({
    domain: endpointContentDomainSchema,
    serverId: z.string().min(1).max(2_000),
    workerId: z.string().min(1).max(255).nullable(),
    scopeId: z.string().min(1).max(1_000),
    operationId: z.string().uuid(),
    operation: z.string().min(1).max(160),
    direction: endpointContentDirectionSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const endpointContentOpaqueSchema = z
  .object({
    formatVersion: z.literal(1),
    domain: endpointContentDomainSchema,
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .refine(
    ({ envelope }) =>
      envelope.ciphertext.length <=
      Math.ceil(((ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT + 16) * 4) / 3),
    "Protected endpoint content exceeds its byte limit.",
  );

export type EndpointContentDomain = z.infer<typeof endpointContentDomainSchema>;
export type EndpointContentDirection = z.infer<
  typeof endpointContentDirectionSchema
>;
export type EndpointContentContext = z.infer<
  typeof endpointContentContextSchema
>;
export type EndpointContentOpaque = z.infer<typeof endpointContentOpaqueSchema>;
