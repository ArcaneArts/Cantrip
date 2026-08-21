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
  "surface-private-state",
  "policy-content",
  "provider-credential",
  "mcp-secret",
  "repository-content",
  "workflow-content",
  "private-analytics",
]);

export const encryptionComponentScopes = encryptionComponentScopeSchema.options;

export const workerEncryptionComponentScopeSchema =
  encryptionComponentScopeSchema.exclude([
    "account-master-key",
    "workspace-display-name",
  ]);

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
    component: workerEncryptionComponentScopeSchema,
    keyRevision: encryptionKeyRevisionSchema,
    envelope: hpkeWrappedKeyEnvelopeSchema,
  })
  .strict();

export const encryptionPayloadMigrationStatusSchema = z.enum([
  "pending",
  "in-progress",
  "complete",
]);

export const encryptionPrincipalKindSchema = z.enum(["client", "worker"]);
export const encryptionPrincipalStateSchema = z.enum([
  "pending",
  "approved",
  "revoked",
]);
export const encryptionGrantStateSchema = z.enum(["active", "revoked"]);

const encryptionTimestampSchema = z.string().datetime({ offset: true });
const encryptionPrincipalIdSchema = z.string().uuid();

function samePasswordKdf(
  left: PasswordKdfParameters,
  right: PasswordKdfParameters,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePasswordWrapperPair(
  value: {
    activeMasterKeyRevision: number;
    passwordKdf: PasswordKdfParameters | null;
    passwordWrappedMasterKey: PasswordWrappedMasterKey | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    (value.passwordKdf === null) !==
    (value.passwordWrappedMasterKey === null)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Password KDF parameters and wrapper must both be present or absent.",
      path: ["passwordWrappedMasterKey"],
    });
    return;
  }
  if (!value.passwordKdf || !value.passwordWrappedMasterKey) return;
  if (!samePasswordKdf(value.passwordKdf, value.passwordWrappedMasterKey.kdf)) {
    context.addIssue({
      code: "custom",
      message: "Password KDF parameters must match the wrapped key envelope.",
      path: ["passwordKdf"],
    });
  }
  if (
    value.passwordWrappedMasterKey.masterKeyRevision !==
    value.activeMasterKeyRevision
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Password wrapper must target the active Account Master Key revision.",
      path: ["passwordWrappedMasterKey", "masterKeyRevision"],
    });
  }
}

export const accountEncryptionProfileSchema = z
  .object({
    ownerId: z.string().min(1).max(255),
    formatVersion: encryptionEnvelopeVersionSchema,
    activeMasterKeyRevision: encryptionKeyRevisionSchema,
    passwordKdf: passwordKdfParametersSchema.nullable(),
    passwordWrappedMasterKey: passwordWrappedMasterKeySchema.nullable(),
    initializationStatus: z.literal("initialized"),
    payloadMigrationStatus: encryptionPayloadMigrationStatusSchema,
    revision: encryptionKeyRevisionSchema,
    createdAt: encryptionTimestampSchema,
    updatedAt: encryptionTimestampSchema,
  })
  .strict()
  .superRefine(validatePasswordWrapperPair);

export const encryptionPrincipalSchema = z
  .object({
    id: encryptionPrincipalIdSchema,
    ownerId: z.string().min(1).max(255),
    kind: encryptionPrincipalKindSchema,
    workerId: z.string().min(1).max(255).nullable(),
    label: z.string().trim().min(1).max(120).nullable(),
    publicKey: encryptionPublicKeySchema,
    state: encryptionPrincipalStateSchema,
    revision: encryptionKeyRevisionSchema,
    approvedAt: encryptionTimestampSchema.nullable(),
    revokedAt: encryptionTimestampSchema.nullable(),
    revokedReason: z.string().min(1).max(500).nullable(),
    createdAt: encryptionTimestampSchema,
    updatedAt: encryptionTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "worker") !== (value.workerId !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only worker principals may bind a worker identity.",
        path: ["workerId"],
      });
    }
    if (value.state === "pending" && (value.approvedAt || value.revokedAt)) {
      context.addIssue({
        code: "custom",
        message:
          "Pending principals cannot have approval or revocation timestamps.",
        path: ["state"],
      });
    }
    if (value.state === "approved" && (!value.approvedAt || value.revokedAt)) {
      context.addIssue({
        code: "custom",
        message: "Approved principals require an approval timestamp only.",
        path: ["state"],
      });
    }
    if (value.state === "revoked" && !value.revokedAt) {
      context.addIssue({
        code: "custom",
        message: "Revoked principals require a revocation timestamp.",
        path: ["state"],
      });
    }
  });

export const encryptionKeyGrantSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: z.string().min(1).max(255),
    principalId: encryptionPrincipalIdSchema,
    component: encryptionComponentScopeSchema,
    keyRevision: encryptionKeyRevisionSchema,
    wrappedKey: z.union([
      clientMasterKeyWrapperSchema,
      workerComponentKeyGrantSchema,
    ]),
    state: encryptionGrantStateSchema,
    revision: encryptionKeyRevisionSchema,
    revokedAt: encryptionTimestampSchema.nullable(),
    revokedReason: z.string().min(1).max(500).nullable(),
    createdAt: encryptionTimestampSchema,
    updatedAt: encryptionTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const wrapped = value.wrappedKey;
    if (wrapped.purpose === "client-account-master-key") {
      if (
        value.component !== "account-master-key" ||
        wrapped.clientId !== value.principalId ||
        wrapped.masterKeyRevision !== value.keyRevision
      ) {
        context.addIssue({
          code: "custom",
          message: "Client grant metadata does not match its wrapped key.",
          path: ["wrappedKey"],
        });
      }
    } else if (
      value.component !== wrapped.component ||
      value.keyRevision !== wrapped.keyRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker grant metadata does not match its wrapped key.",
        path: ["wrappedKey"],
      });
    }
    if ((value.state === "revoked") !== (value.revokedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Grant state and revocation timestamp must agree.",
        path: ["state"],
      });
    }
  });

export const workerEncryptionStatusSchema = z
  .object({
    supported: z.boolean(),
    state: z.enum(["unavailable", "pending-approval", "ready", "error"]),
    principalId: encryptionPrincipalIdSchema.nullable(),
    grants: z
      .array(
        z
          .object({
            component: workerEncryptionComponentScopeSchema,
            keyRevision: encryptionKeyRevisionSchema,
          })
          .strict(),
      )
      .max(workerEncryptionComponentScopeSchema.options.length),
    lastSyncedAt: encryptionTimestampSchema.nullable(),
    error: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.supported && value.state !== "unavailable") {
      context.addIssue({
        code: "custom",
        message: "Unsupported worker encryption must be unavailable.",
        path: ["state"],
      });
    }
    if (value.state === "ready" && value.principalId === null) {
      context.addIssue({
        code: "custom",
        message: "Ready worker encryption requires a principal.",
        path: ["principalId"],
      });
    }
  });

export const workerEncryptionRefreshRequestSchema = z
  .object({
    component: workerEncryptionComponentScopeSchema,
    keyRevision: encryptionKeyRevisionSchema,
  })
  .strict();

export const workerEncryptionRefreshResultSchema = z
  .object({
    component: workerEncryptionComponentScopeSchema,
    keyRevision: encryptionKeyRevisionSchema,
    status: workerEncryptionStatusSchema,
  })
  .strict();

export const unavailableWorkerEncryptionStatus =
  workerEncryptionStatusSchema.parse({
    supported: false,
    state: "unavailable",
    principalId: null,
    grants: [],
    lastSyncedAt: null,
    error: null,
  });

export const accountEncryptionProfileStateSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({ status: z.literal("uninitialized"), profile: z.null() })
      .strict(),
    z
      .object({
        status: z.literal("initialized"),
        profile: accountEncryptionProfileSchema,
      })
      .strict(),
  ],
);

const accountEncryptionProfileInitializeProfileSchema = z
  .object({
    formatVersion: encryptionEnvelopeVersionSchema,
    activeMasterKeyRevision: encryptionKeyRevisionSchema,
    passwordKdf: passwordKdfParametersSchema.nullable(),
    passwordWrappedMasterKey: passwordWrappedMasterKeySchema.nullable(),
    payloadMigrationStatus:
      encryptionPayloadMigrationStatusSchema.default("pending"),
  })
  .strict()
  .superRefine(validatePasswordWrapperPair);

export const accountEncryptionProfileInitializeSchema = z
  .object({
    profile: accountEncryptionProfileInitializeProfileSchema,
    initialClient: z
      .object({
        id: encryptionPrincipalIdSchema,
        label: z.string().trim().min(1).max(120).nullable().default(null),
        publicKey: encryptionPublicKeySchema,
        wrappedMasterKey: clientMasterKeyWrapperSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.initialClient.wrappedMasterKey.clientId !==
        value.initialClient.id ||
      value.initialClient.wrappedMasterKey.masterKeyRevision !==
        value.profile.activeMasterKeyRevision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Initial client wrapper does not match the profile or principal.",
        path: ["initialClient", "wrappedMasterKey"],
      });
    }
  });

export const accountEncryptionProfileInitializeResultSchema =
  z.discriminatedUnion("created", [
    z
      .object({
        created: z.literal(true),
        profile: accountEncryptionProfileSchema,
        principal: encryptionPrincipalSchema,
        grant: encryptionKeyGrantSchema,
      })
      .strict(),
    z
      .object({
        created: z.literal(false),
        profile: accountEncryptionProfileSchema,
      })
      .strict(),
  ]);

export const encryptionProfileMigrationUpdateSchema = z
  .object({
    expectedRevision: encryptionKeyRevisionSchema,
    payloadMigrationStatus: encryptionPayloadMigrationStatusSchema,
  })
  .strict();

export const accountPasswordEncryptionChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1_024),
    newPassword: z.string().min(12).max(1_024),
    expectedProfileRevision: encryptionKeyRevisionSchema,
    passwordKdf: passwordKdfParametersSchema,
    passwordWrappedMasterKey: passwordWrappedMasterKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !samePasswordKdf(value.passwordKdf, value.passwordWrappedMasterKey.kdf)
    ) {
      context.addIssue({
        code: "custom",
        message: "Password KDF parameters must match the wrapped key envelope.",
        path: ["passwordKdf"],
      });
    }
  });

export const encryptionPrincipalCreateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: encryptionPrincipalIdSchema,
      kind: z.literal("client"),
      label: z.string().trim().min(1).max(120).nullable().default(null),
      publicKey: encryptionPublicKeySchema,
    })
    .strict(),
  z
    .object({
      id: encryptionPrincipalIdSchema,
      kind: z.literal("worker"),
      workerId: z.string().min(1).max(255),
      label: z.string().trim().min(1).max(120).nullable().default(null),
      publicKey: encryptionPublicKeySchema,
    })
    .strict(),
]);

export const encryptionPrincipalApprovalSchema = z
  .object({ expectedRevision: encryptionKeyRevisionSchema })
  .strict();

export const encryptionRevocationSchema = z
  .object({
    expectedRevision: encryptionKeyRevisionSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const encryptionKeyGrantCreateSchema = z
  .object({
    component: encryptionComponentScopeSchema,
    keyRevision: encryptionKeyRevisionSchema,
    wrappedKey: z.union([
      clientMasterKeyWrapperSchema,
      workerComponentKeyGrantSchema,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.wrappedKey.purpose === "client-account-master-key" &&
      (value.component !== "account-master-key" ||
        value.wrappedKey.masterKeyRevision !== value.keyRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "Client grant metadata does not match its wrapped key.",
        path: ["wrappedKey"],
      });
    }
    if (
      value.wrappedKey.purpose === "worker-component-key" &&
      (value.component !== value.wrappedKey.component ||
        value.keyRevision !== value.wrappedKey.keyRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker grant metadata does not match its wrapped key.",
        path: ["wrappedKey"],
      });
    }
  });

export const encryptionPrincipalListSchema = z.array(encryptionPrincipalSchema);
export const encryptionKeyGrantListSchema = z.array(encryptionKeyGrantSchema);

export const workerEncryptionBootstrapRequestSchema = z
  .object({
    principalId: encryptionPrincipalIdSchema,
    publicKey: encryptionPublicKeySchema,
  })
  .strict();

export const workerEncryptionBootstrapResultSchema = z
  .object({
    ownerId: z.string().min(1).max(255),
    principal: encryptionPrincipalSchema,
    grants: encryptionKeyGrantListSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.principal.ownerId !== value.ownerId ||
      value.principal.kind !== "worker"
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker bootstrap identity does not match its owner.",
        path: ["principal"],
      });
    }
    if (
      value.grants.some(
        (grant) =>
          grant.ownerId !== value.ownerId ||
          grant.principalId !== value.principal.id ||
          grant.state !== "active" ||
          grant.wrappedKey.purpose !== "worker-component-key",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker bootstrap contains an invalid grant.",
        path: ["grants"],
      });
    }
  });

export type EncryptionAssociatedData = z.infer<
  typeof encryptionAssociatedDataSchema
>;
export type EncryptionComponentScope = z.infer<
  typeof encryptionComponentScopeSchema
>;
export type WorkerEncryptionComponentScope = z.infer<
  typeof workerEncryptionComponentScopeSchema
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
export type WorkerEncryptionStatus = z.infer<
  typeof workerEncryptionStatusSchema
>;
export type WorkerEncryptionRefreshRequest = z.infer<
  typeof workerEncryptionRefreshRequestSchema
>;
export type WorkerEncryptionRefreshResult = z.infer<
  typeof workerEncryptionRefreshResultSchema
>;
export type EncryptionPayloadMigrationStatus = z.infer<
  typeof encryptionPayloadMigrationStatusSchema
>;
export type EncryptionPrincipalKind = z.infer<
  typeof encryptionPrincipalKindSchema
>;
export type EncryptionPrincipalState = z.infer<
  typeof encryptionPrincipalStateSchema
>;
export type EncryptionGrantState = z.infer<typeof encryptionGrantStateSchema>;
export type AccountEncryptionProfile = z.infer<
  typeof accountEncryptionProfileSchema
>;
export type AccountEncryptionProfileState = z.infer<
  typeof accountEncryptionProfileStateSchema
>;
export type AccountEncryptionProfileInitialize = z.infer<
  typeof accountEncryptionProfileInitializeSchema
>;
export type AccountEncryptionProfileInitializeResult = z.infer<
  typeof accountEncryptionProfileInitializeResultSchema
>;
export type EncryptionProfileMigrationUpdate = z.infer<
  typeof encryptionProfileMigrationUpdateSchema
>;
export type AccountPasswordEncryptionChange = z.infer<
  typeof accountPasswordEncryptionChangeSchema
>;
export type EncryptionPrincipal = z.infer<typeof encryptionPrincipalSchema>;
export type EncryptionPrincipalCreate = z.infer<
  typeof encryptionPrincipalCreateSchema
>;
export type EncryptionPrincipalApproval = z.infer<
  typeof encryptionPrincipalApprovalSchema
>;
export type EncryptionRevocation = z.infer<typeof encryptionRevocationSchema>;
export type EncryptionKeyGrant = z.infer<typeof encryptionKeyGrantSchema>;
export type EncryptionKeyGrantCreate = z.infer<
  typeof encryptionKeyGrantCreateSchema
>;
export type WorkerEncryptionBootstrapRequest = z.infer<
  typeof workerEncryptionBootstrapRequestSchema
>;
export type WorkerEncryptionBootstrapResult = z.infer<
  typeof workerEncryptionBootstrapResultSchema
>;
