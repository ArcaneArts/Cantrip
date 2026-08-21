import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const PROTECTED_SECRET_BYTES_LIMIT = 2 * 1_024 * 1_024;

export const protectedSecretEnvelopeSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .refine(
    ({ envelope }) =>
      envelope.ciphertext.length <=
      Math.ceil(((PROTECTED_SECRET_BYTES_LIMIT + 16) * 4) / 3),
    "Encrypted secret exceeds its byte limit.",
  );

export const providerApiKeyProtectedContentSchema = z
  .object({
    version: z.literal(1),
    apiKey: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const providerAccountLabelProtectedContentSchema = z
  .object({
    version: z.literal(1),
    label: z.string().trim().min(1).max(160),
  })
  .strict();

const providerCredentialBaseSchema = z.object({
  accessToken: z.string().min(1).max(1_000_000),
  email: z.string().max(1_024).nullable(),
  expiresAt: z.number().int().positive().nullable(),
  planType: z.string().max(1_024).nullable(),
  refreshToken: z.string().min(1).max(1_000_000).nullable(),
  version: z.literal(1),
});

export const providerCredentialProtectedContentSchema = z.discriminatedUnion(
  "kind",
  [
    providerCredentialBaseSchema.extend({
      accountId: z.string().min(1).max(512),
      idToken: z.string().min(1).max(1_000_000).nullable(),
      kind: z.literal("chatgpt"),
      userId: z.string().min(1).max(512).nullable(),
    }),
    providerCredentialBaseSchema.extend({
      kind: z.literal("grok"),
      userId: z.string().min(1).max(512),
    }),
  ],
);

export const protectedProviderCredentialSchema = z
  .object({
    subjectBlindIndex: encryptionKeyBytesSchema,
    protectedCredential: protectedSecretEnvelopeSchema,
  })
  .strict();

export const providerCredentialPublicMetadataSchema = z
  .object({
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();

export const providerCredentialUploadSchema = z
  .object({
    credential: protectedProviderCredentialSchema,
    expectedRevision: z.number().int().nonnegative(),
    metadata: providerCredentialPublicMetadataSchema,
  })
  .strict();

export const providerCredentialWireRecordSchema = z
  .object({
    accountId: z.string().min(1).max(512),
    credential: protectedProviderCredentialSchema,
    credentialRevision: z.number().int().positive(),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
  })
  .strict();

export const mcpServerOpaqueRuntimeSchema = z
  .object({
    id: z.string().uuid(),
    enabled: z.boolean(),
    nameBlindIndex: encryptionKeyBytesSchema,
    protectedConfiguration: protectedSecretEnvelopeSchema,
  })
  .strict();

export type ProtectedSecretEnvelope = z.infer<
  typeof protectedSecretEnvelopeSchema
>;
export type ProviderApiKeyProtectedContent = z.infer<
  typeof providerApiKeyProtectedContentSchema
>;
export type ProviderAccountLabelProtectedContent = z.infer<
  typeof providerAccountLabelProtectedContentSchema
>;
export type ProviderCredentialProtectedContent = z.infer<
  typeof providerCredentialProtectedContentSchema
>;
export type ProtectedProviderCredential = z.infer<
  typeof protectedProviderCredentialSchema
>;
export type ProviderCredentialPublicMetadata = z.infer<
  typeof providerCredentialPublicMetadataSchema
>;
export type ProviderCredentialUpload = z.infer<
  typeof providerCredentialUploadSchema
>;
export type ProviderCredentialWireRecord = z.infer<
  typeof providerCredentialWireRecordSchema
>;
export type McpServerOpaqueRuntime = z.infer<
  typeof mcpServerOpaqueRuntimeSchema
>;
