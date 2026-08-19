import { z } from "zod";

export const encryptionEnvelopeVersionSchema = z.literal(1);
export const encryptionKeyRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);

export const encryptionComponentScopeSchema = z.enum([
  "account-master-key",
  "workspace-display-name",
  "chat-content",
  "task-content",
  "attachment-content",
  "interaction-content",
  "private-surface-metadata",
  "policy-content",
  "provider-credential",
  "mcp-secret",
  "workflow-content",
  "private-analytics",
]);

export const encryptionComponentScopes = encryptionComponentScopeSchema.options;

const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function hasCanonicalTrailingBits(value: string): boolean {
  const remainder = value.length % 4;
  if (remainder === 0) return true;
  const lastValue = base64UrlAlphabet.indexOf(value.at(-1) ?? "");
  if (lastValue < 0) return false;
  return remainder === 2
    ? (lastValue & 0b1111) === 0
    : remainder === 3
      ? (lastValue & 0b11) === 0
      : false;
}

const canonicalBase64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/u)
  .refine(hasCanonicalTrailingBits, {
    message: "Value is not canonical unpadded base64url.",
  });

function fixedBase64UrlSchema(bytes: number) {
  return canonicalBase64UrlSchema.length(Math.ceil((bytes * 4) / 3));
}

export const encryptionBytesSchema = canonicalBase64UrlSchema.max(22_369_622);
export const encryptionKeyBytesSchema = fixedBase64UrlSchema(32);
export const encryptionNonceSchema = fixedBase64UrlSchema(12);
export const encryptionP256PublicKeyBytesSchema = fixedBase64UrlSchema(65);
export const encryptionWrappedKeyCiphertextSchema = fixedBase64UrlSchema(48);

export const encryptionAssociatedDataSchema = z
  .object({
    ownerId: z.string().min(1).max(255),
    component: encryptionComponentScopeSchema,
    table: z.string().min(1).max(120),
    rowId: z.string().min(1).max(500),
    field: z.string().min(1).max(120),
    formatVersion: encryptionEnvelopeVersionSchema,
    keyRevision: encryptionKeyRevisionSchema,
  })
  .strict();

export const encryptedPayloadEnvelopeSchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    algorithm: z.literal("AES-256-GCM"),
    keyRevision: encryptionKeyRevisionSchema,
    nonce: encryptionNonceSchema,
    ciphertext: encryptionBytesSchema.min(22),
  })
  .strict();

export const passwordKdfParametersSchema = z
  .object({
    algorithm: z.literal("Argon2id"),
    version: z.literal(19),
    context: z.literal("cantrip:e2ee:password-kek:v1"),
    memoryKiB: z.number().int().min(8_192).max(262_144),
    iterations: z.number().int().min(1).max(10),
    parallelism: z.number().int().min(1).max(4),
    outputBytes: z.literal(32),
    salt: encryptionKeyBytesSchema,
  })
  .strict();

export const passwordWrappedMasterKeySchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    purpose: z.literal("password-wrapped-account-master-key"),
    masterKeyRevision: encryptionKeyRevisionSchema,
    kdf: passwordKdfParametersSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.envelope.keyRevision !== value.masterKeyRevision) {
      context.addIssue({
        code: "custom",
        message: "Master-key and envelope revisions must match.",
        path: ["envelope", "keyRevision"],
      });
    }
    if (value.envelope.ciphertext.length !== 64) {
      context.addIssue({
        code: "custom",
        message: "Wrapped Account Master Key must contain exactly 48 bytes.",
        path: ["envelope", "ciphertext"],
      });
    }
  });

export const encryptionPublicKeySchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    algorithm: z.literal("P-256"),
    format: z.literal("raw"),
    value: encryptionP256PublicKeyBytesSchema,
  })
  .strict();

export const hpkeCipherSuiteSchema = z
  .object({
    mode: z.literal("base"),
    kem: z.literal("DHKEM(P-256,HKDF-SHA256)"),
    kdf: z.literal("HKDF-SHA256"),
    aead: z.literal("AES-256-GCM"),
  })
  .strict();

export const hpkeWrappedKeyEnvelopeSchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    algorithm: z.literal("HPKE-RFC9180"),
    suite: hpkeCipherSuiteSchema,
    encapsulatedKey: encryptionP256PublicKeyBytesSchema,
    ciphertext: encryptionWrappedKeyCiphertextSchema,
  })
  .strict();

export const clientMasterKeyWrapperSchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    purpose: z.literal("client-account-master-key"),
    clientId: z.string().min(1).max(255),
    masterKeyRevision: encryptionKeyRevisionSchema,
    envelope: hpkeWrappedKeyEnvelopeSchema,
  })
  .strict();

export const workerComponentKeyGrantSchema = z
  .object({
    version: encryptionEnvelopeVersionSchema,
    purpose: z.literal("worker-component-key"),
    workerId: z.string().min(1).max(255),
    component: encryptionComponentScopeSchema.exclude(["account-master-key"]),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: hpkeWrappedKeyEnvelopeSchema,
  })
  .strict();

export type EncryptionAssociatedData = z.infer<
  typeof encryptionAssociatedDataSchema
>;
export type EncryptionComponentScope = z.infer<
  typeof encryptionComponentScopeSchema
>;
export type EncryptedPayloadEnvelope = z.infer<
  typeof encryptedPayloadEnvelopeSchema
>;
export type PasswordKdfParameters = z.infer<typeof passwordKdfParametersSchema>;
export type PasswordWrappedMasterKey = z.infer<
  typeof passwordWrappedMasterKeySchema
>;
export type EncryptionPublicKey = z.infer<typeof encryptionPublicKeySchema>;
export type HpkeCipherSuite = z.infer<typeof hpkeCipherSuiteSchema>;
export type HpkeWrappedKeyEnvelope = z.infer<
  typeof hpkeWrappedKeyEnvelopeSchema
>;
export type ClientMasterKeyWrapper = z.infer<
  typeof clientMasterKeyWrapperSchema
>;
export type WorkerComponentKeyGrant = z.infer<
  typeof workerComponentKeyGrantSchema
>;
