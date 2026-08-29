import { z } from "zod";

import { encryptionKeyBytesSchema } from "./encryption.js";
import {
  protectedProviderCredentialSchema,
  protectedSecretEnvelopeSchema,
  providerCredentialProtectedContentSchema,
  providerCredentialPublicMetadataSchema,
} from "./protected-secrets.js";

export const modelProviderKindSchema = z.enum([
  "chatgpt",
  "grok",
  "ollama",
  "openai-compatible",
]);

export const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/v1";

/**
 * Z.ai Coding Plan is stored as an OpenAI-compatible transport, so its
 * provider family is inferred from the normalized Responses API root.
 */
export function isZaiCodingPlanBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeResponsesBaseUrl(value));
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.z.ai" &&
      url.pathname.replace(/\/+$/u, "") === "/api/v1"
    );
  } catch {
    return false;
  }
}

export const providerWeeklyUsageSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().nullable(),
});

export const codexAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  authMode: z.enum(["chatgpt", "grok", "apiKey", "other"]).nullable(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  weeklyUsage: providerWeeklyUsageSchema.nullable(),
  loginPending: z.boolean().default(false),
  loginError: z.string().max(2_000).nullable().default(null),
});

export const codexDeviceLoginSchema = z.object({
  loginId: z.string().min(1),
  verificationUrl: z.url(),
  userCode: z.string().min(1),
});

export const providerAuthLifecycleStateSchema = z.enum([
  "pending",
  "authenticated",
  "signed-out",
  "expired",
  "cancelled",
  "failed",
]);

export const providerAuthFailureCodeSchema = z.enum([
  "authorization-cancelled",
  "authorization-denied",
  "authorization-expired",
  "authorization-failed",
  "credential-capture-failed",
  "status-unavailable",
]);

/**
 * Deliberately small provider-auth state that is safe to relay live. Device
 * codes, provider-issued login identifiers, OAuth tokens, credential
 * envelopes, and upstream error text do not belong in this shape.
 */
export const providerAuthSafeStatusSchema = z
  .object({
    state: providerAuthLifecycleStateSchema,
    authMode: codexAuthStatusSchema.shape.authMode,
    email: z.string().max(1_024).nullable(),
    planType: z.string().max(1_024).nullable(),
    weeklyUsage: providerWeeklyUsageSchema.nullable(),
    failureCode: providerAuthFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((status, context) => {
    const authenticated = status.state === "authenticated";
    const failed = ["cancelled", "expired", "failed"].includes(status.state);
    if (authenticated !== (status.authMode !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only authenticated provider state may include an auth mode.",
        path: ["authMode"],
      });
    }
    if (failed !== (status.failureCode !== null)) {
      context.addIssue({
        code: "custom",
        message: "Provider auth failures require one safe failure code.",
        path: ["failureCode"],
      });
    }
    if (
      (status.state === "cancelled" &&
        status.failureCode !== "authorization-cancelled") ||
      (status.state === "expired" &&
        status.failureCode !== "authorization-expired") ||
      (status.state === "failed" &&
        ["authorization-cancelled", "authorization-expired"].includes(
          status.failureCode ?? "",
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider auth lifecycle and failure code do not match.",
        path: ["failureCode"],
      });
    }
    if (
      !authenticated &&
      (status.email || status.planType || status.weeklyUsage)
    ) {
      context.addIssue({
        code: "custom",
        message: "Signed-out provider state may not include account details.",
      });
    }
  });

export const providerAuthStatusObservationSchema = z
  .object({
    type: z.literal("provider.auth.status.observed"),
    observationId: z.string().uuid(),
    providerId: z.string().min(1).max(512),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    status: providerAuthSafeStatusSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.status.state === "authenticated" &&
      observation.status.authMode !== observation.providerKind
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider auth mode must match the provider kind.",
        path: ["status", "authMode"],
      });
    }
  });

export const providerAuthLiveStatusSchema = z
  .object({
    providerId: z.string().min(1).max(512),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    workerId: z.string().min(1).max(512),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    status: providerAuthSafeStatusSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (
      status.status.state === "authenticated" &&
      status.status.authMode !== status.providerKind
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider auth mode must match the provider kind.",
        path: ["status", "authMode"],
      });
    }
  });

export const providerAccessTokenLeaseRequestSchema = z.object({
  credentialRevision: z.number().int().nonnegative().nullable().default(null),
  forceRefresh: z.boolean().default(false),
  minimumValiditySeconds: z.number().int().min(30).max(600).default(120),
});

/** Worker-only in-memory view opened from an authorized durable envelope. */
export const providerAccessTokenLeaseSchema = z.object({
  accessToken: z.string().min(1).max(1_000_000),
  credentialRevision: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  email: z.string().max(1_024).nullable().default(null),
  issuedAt: z.string().datetime({ offset: true }),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  planType: z.string().max(1_024).nullable(),
  providerAccountId: z.string().min(1).max(512),
  providerId: z.string().min(1).max(512),
  providerIdentity: z.discriminatedUnion("kind", [
    z.object({
      accountId: z.string().min(1).max(512),
      kind: z.literal("chatgpt"),
      userId: z.string().min(1).max(512).nullable(),
    }),
    z.object({
      kind: z.literal("grok"),
      userId: z.string().min(1).max(512),
    }),
  ]),
  providerKind: z.enum(["chatgpt", "grok"]),
});

/** @deprecated Use providerCredentialProtectedContentSchema. */
export const providerLegacyCredentialSchema =
  providerCredentialProtectedContentSchema;

export const providerLegacyCredentialCaptureResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("missing") }),
    z.object({ status: z.literal("malformed") }),
    z.object({
      credential: protectedProviderCredentialSchema,
      metadata: providerCredentialPublicMetadataSchema,
      portableAuth: z.boolean().default(false),
      status: z.literal("available"),
    }),
  ],
);

export const providerLegacyCredentialPurgeResultSchema = z.object({
  purged: z.boolean(),
  serverCredentialRevision: z.number().int().positive(),
  subjectBlindIndex: encryptionKeyBytesSchema,
});

/**
 * Codex model-provider URLs are API roots. Codex adds the Responses endpoint
 * itself, so accepting a pasted chat/completions or responses URL would create
 * invalid paths such as `/chat/completions/responses`.
 */
export function normalizeResponsesBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|chat|responses)\/?$/i, "")
    .replace(/\/+$/, "");
  if (url.hostname.toLowerCase() === "openrouter.ai" && url.pathname === "/") {
    url.pathname = "/api/v1";
  }
  return url.toString().replace(/\/$/, "");
}
/**
 * Reasoning efforts are model-advertised wire values. Codex and compatible
 * providers may add efforts without a coordinated Cantrip release, so this
 * intentionally remains open instead of being a closed enum.
 */
export const reasoningEffortSchema = z.string().trim().min(1).max(80);

export const modelReasoningEffortOptionSchema = z.object({
  effort: reasoningEffortSchema,
  description: z.string().trim().max(500).nullable().default(null),
});

export const providerModelMetadataSourceSchema = z.enum([
  "ollama",
  "openrouter",
  "codex",
  "grok",
  "zai",
  "compatible-api",
  "manual",
]);

export const providerModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  nativeModelId: z.string().trim().min(1).max(500),
  canonicalModelId: z.string().trim().min(1).max(500).nullable(),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  outputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportsTools: z.boolean().nullable(),
  supportsParallelTools: z.boolean().nullable(),
  supportsStructuredOutput: z.boolean().nullable(),
  supportsVision: z.boolean().nullable(),
  supportsReasoning: z.boolean().nullable(),
  supportedReasoningEfforts: z.array(modelReasoningEffortOptionSchema).max(32),
  defaultReasoningEffort: reasoningEffortSchema.nullable(),
  reasoningMandatory: z.boolean().nullable(),
  family: z.string().max(500).nullable(),
  parameterSize: z.string().max(100).nullable(),
  quantization: z.string().max(100).nullable(),
  digest: z.string().max(500).nullable(),
  metadataSource: providerModelMetadataSourceSchema,
  matchConfidence: z.number().min(0).max(1).nullable(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const providerModelAvailabilityStateSchema = z.enum([
  "available",
  "unavailable",
  "stale",
]);

export const providerModelAvailabilitySchema = z.object({
  id: z.string().min(1),
  providerModelId: z.string().min(1),
  scopeKey: z.string().min(1).max(500),
  workerId: z.string().min(1).nullable(),
  providerAccountId: z.string().min(1).nullable(),
  state: providerModelAvailabilityStateSchema,
  lastSeenAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const providerCatalogSyncStatusSchema = z.enum([
  "idle",
  "refreshing",
  "current",
  "stale",
  "failed",
]);

export const providerCatalogSyncStateSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  scopeKey: z.string().min(1).max(500),
  workerId: z.string().min(1).nullable(),
  providerAccountId: z.string().min(1).nullable(),
  status: providerCatalogSyncStatusSchema,
  error: z.string().max(20_000).nullable(),
  etag: z.string().max(1_000).nullable(),
  refreshStartedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const providerModelCatalogResultSchema = z.object({
  providerId: z.string().min(1),
  models: z.array(providerModelCatalogEntrySchema),
  availability: z.array(providerModelAvailabilitySchema),
  syncStates: z.array(providerCatalogSyncStateSchema),
  servedStale: z.boolean(),
});

export const providerConnectionTestStageSchema = z.enum([
  "worker-placement",
  "codex-startup",
  "key-authentication",
  "endpoint-compatibility",
  "model-availability",
  "provider-response",
  "completed",
]);

export const providerConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  stage: providerConnectionTestStageSchema,
  message: z.string().trim().min(1).max(20_000),
  workerId: z.string().min(1).nullable(),
  modelName: z.string().min(1).nullable(),
  durationMs: z.number().int().nonnegative(),
});

export const workerProviderConnectionTestResultSchema = z.object({
  accepted: z.literal(true),
  durationMs: z.number().int().nonnegative(),
});

export const modelProviderAccountWorkerSchema = z.object({
  workerId: z.string().min(1),
  authState: z.enum(["unknown", "signed-out", "signed-in", "failed"]),
  weeklyUsageUsedPercent: z.number().min(0).max(100).nullable(),
  weeklyUsageResetsAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
});

export const providerCredentialStateSchema = z.enum([
  "signed-out",
  "migration-needed",
  "signed-in",
  "reauth-required",
  "conflict",
]);

export const PROVIDER_REAUTH_REQUIRED_ERROR_CODE = "provider-reauth-required";
export const PROVIDER_REAUTH_REQUIRED_MESSAGE =
  "ChatGPT authentication expired. Sign in again to reconnect this provider account.";

export const modelProviderAccountSummarySchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().trim().min(1).max(160),
  planType: z.string().max(160).nullable(),
  position: z.number().int().nonnegative(),
  enabled: z.boolean(),
  credentialState: providerCredentialStateSchema.default("signed-out"),
  weeklyUsageUsedPercent: z.number().min(0).max(100).nullable().default(null),
  weeklyUsageResetsAt: z.string().datetime().nullable().default(null),
  authLastSyncedAt: z.string().datetime().nullable().default(null),
  workerBindings: z.array(modelProviderAccountWorkerSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelProviderAccountListSchema = z.array(
  modelProviderAccountSummarySchema,
);

export const modelProviderAccountCreateSchema = z.object({
  label: z.string().trim().min(1).max(160).default("Provider account"),
});

export const modelProviderAccountUpdateSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
});

export const encryptedModelProviderAccountCreateSchema = z
  .object({
    id: z.string().uuid(),
    protectedLabel: protectedSecretEnvelopeSchema,
  })
  .strict();

export const encryptedModelProviderAccountUpdateSchema = z
  .object({
    protectedLabel: protectedSecretEnvelopeSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one provider account update.",
  });

export const modelProviderAccountWireSummarySchema =
  modelProviderAccountSummarySchema
    .omit({ label: true })
    .extend({ protectedLabel: protectedSecretEnvelopeSchema })
    .strict();

export const modelProviderAccountWireListSchema = z.array(
  modelProviderAccountWireSummarySchema,
);

export const tokenUsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const detailedTokenUsageTotalsSchema = tokenUsageTotalsSchema.extend({
  cachedInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0),
  reasoningOutputTokens: z.number().int().nonnegative().default(0),
});

export const agentTimeSummarySchema = z.object({
  activeAgentCount: z.number().int().nonnegative(),
  agentTimeMs: z.number().int().nonnegative(),
  wallTimeMs: z.number().int().nonnegative(),
  averageConcurrency: z.number().finite().nonnegative(),
});

const emptyAgentTimeSummary = {
  activeAgentCount: 0,
  agentTimeMs: 0,
  wallTimeMs: 0,
  averageConcurrency: 0,
} as const;

export const modelProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  apiKey: z.string().trim().min(1).max(10_000).nullable().optional(),
  weeklyUsageReservePercent: z.number().int().min(0).max(100).optional(),
});

export const modelProviderUpdateSchema = modelProviderCreateSchema;

export const encryptedModelProviderCreateSchema = modelProviderCreateSchema
  .omit({ apiKey: true })
  .extend({
    id: z.string().uuid(),
    initialAccount: encryptedModelProviderAccountCreateSchema.nullable(),
    protectedApiKey: protectedSecretEnvelopeSchema.nullable().default(null),
  })
  .strict()
  .superRefine((provider, context) => {
    const requiresAccount =
      provider.kind === "chatgpt" || provider.kind === "grok";
    if (requiresAccount !== (provider.initialAccount !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "Account-backed providers require one protected initial account.",
        path: ["initialAccount"],
      });
    }
  });

export const encryptedModelProviderUpdateSchema = modelProviderCreateSchema
  .omit({ apiKey: true })
  .extend({
    protectedApiKey: protectedSecretEnvelopeSchema.nullable().optional(),
  })
  .strict();

export const modelProviderSummarySchema = modelProviderCreateSchema
  .omit({ apiKey: true })
  .extend({
    id: z.string().min(1),
    hasApiKey: z.boolean(),
    weeklyUsageReservePercent: z.number().int().min(0).max(100).default(3),
    accounts: modelProviderAccountListSchema.default([]),
    tokenUsage: tokenUsageTotalsSchema.default({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    agentTime: agentTimeSummarySchema.default(emptyAgentTimeSummary),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  });

export const modelProviderListSchema = z.array(modelProviderSummarySchema);

export const modelProviderWireSummarySchema = modelProviderSummarySchema
  .omit({ accounts: true })
  .extend({ accounts: modelProviderAccountWireListSchema.default([]) })
  .strict();

export const modelProviderWireListSchema = z.array(
  modelProviderWireSummarySchema,
);

export const modelRouteInputSchema = z.object({
  id: z.string().min(1).optional(),
  providerId: z.string().min(1),
  modelName: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
});

export const modelRouteSummarySchema = modelRouteInputSchema.extend({
  id: z.string().min(1),
  providerName: z.string().min(1),
  providerModelId: z.string().min(1).nullable().default(null),
  position: z.number().int().nonnegative(),
  discoveryManaged: z.boolean().default(false),
});

export const modelProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  routes: z
    .array(modelRouteInputSchema)
    .min(1)
    .max(32)
    .refine((routes) => routes.some((route) => route.enabled), {
      message: "At least one provider route must be enabled.",
    }),
});

export const modelProfileUpdateSchema = modelProfileCreateSchema;

export const modelProfileSummarySchema = modelProfileCreateSchema.extend({
  id: z.string().min(1),
  canonicalModelId: z.string().min(1).nullable().default(null),
  defaultReasoningEffort: reasoningEffortSchema.nullable().default(null),
  discoveryManaged: z.boolean().default(false),
  routingPolicy: z.literal("priority"),
  routes: z.array(modelRouteSummarySchema).min(1),
  tokenUsage: tokenUsageTotalsSchema.default({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }),
  agentTime: agentTimeSummarySchema.default(emptyAgentTimeSummary),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelProfileListSchema = z.array(modelProfileSummarySchema);

export type ModelProviderKind = z.infer<typeof modelProviderKindSchema>;

export type ProviderWeeklyUsage = z.infer<typeof providerWeeklyUsageSchema>;

export type CodexAuthStatus = z.infer<typeof codexAuthStatusSchema>;

export type CodexDeviceLogin = z.infer<typeof codexDeviceLoginSchema>;

export type ProviderAuthFailureCode = z.infer<
  typeof providerAuthFailureCodeSchema
>;

export type ProviderAuthLifecycleState = z.infer<
  typeof providerAuthLifecycleStateSchema
>;

export type ProviderAuthLiveStatus = z.infer<
  typeof providerAuthLiveStatusSchema
>;

export type ProviderAuthSafeStatus = z.infer<
  typeof providerAuthSafeStatusSchema
>;

export type ProviderAuthStatusObservation = z.infer<
  typeof providerAuthStatusObservationSchema
>;

export type ProviderAccessTokenLeaseRequest = z.infer<
  typeof providerAccessTokenLeaseRequestSchema
>;

export type ProviderAccessTokenLease = z.infer<
  typeof providerAccessTokenLeaseSchema
>;

export type ProviderLegacyCredential = z.infer<
  typeof providerLegacyCredentialSchema
>;

export type ProviderLegacyCredentialCaptureResult = z.infer<
  typeof providerLegacyCredentialCaptureResultSchema
>;

export type ProviderLegacyCredentialPurgeResult = z.infer<
  typeof providerLegacyCredentialPurgeResultSchema
>;

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export type ModelReasoningEffortOption = z.infer<
  typeof modelReasoningEffortOptionSchema
>;

export type ProviderModelMetadataSource = z.infer<
  typeof providerModelMetadataSourceSchema
>;

export type ProviderModelCatalogEntry = z.infer<
  typeof providerModelCatalogEntrySchema
>;

export type ProviderModelAvailability = z.infer<
  typeof providerModelAvailabilitySchema
>;

export type ProviderModelAvailabilityState = z.infer<
  typeof providerModelAvailabilityStateSchema
>;

export type ProviderCatalogSyncState = z.infer<
  typeof providerCatalogSyncStateSchema
>;

export type ProviderCatalogSyncStatus = z.infer<
  typeof providerCatalogSyncStatusSchema
>;

export type ProviderModelCatalogResult = z.infer<
  typeof providerModelCatalogResultSchema
>;

export type ProviderConnectionTestStage = z.infer<
  typeof providerConnectionTestStageSchema
>;

export type ProviderConnectionTestResult = z.infer<
  typeof providerConnectionTestResultSchema
>;

export type WorkerProviderConnectionTestResult = z.infer<
  typeof workerProviderConnectionTestResultSchema
>;

export type ModelProviderAccountWorker = z.infer<
  typeof modelProviderAccountWorkerSchema
>;

export type ModelProviderAccountSummary = z.infer<
  typeof modelProviderAccountSummarySchema
>;

export type ModelProviderAccountCreate = z.infer<
  typeof modelProviderAccountCreateSchema
>;

export type ModelProviderAccountUpdate = z.infer<
  typeof modelProviderAccountUpdateSchema
>;

export type EncryptedModelProviderAccountCreate = z.infer<
  typeof encryptedModelProviderAccountCreateSchema
>;

export type EncryptedModelProviderAccountUpdate = z.infer<
  typeof encryptedModelProviderAccountUpdateSchema
>;

export type ModelProviderAccountWireSummary = z.infer<
  typeof modelProviderAccountWireSummarySchema
>;

export type TokenUsageTotals = z.infer<typeof tokenUsageTotalsSchema>;

export type DetailedTokenUsageTotals = z.infer<
  typeof detailedTokenUsageTotalsSchema
>;

export type AgentTimeSummary = z.infer<typeof agentTimeSummarySchema>;

export type ModelProviderCreate = z.infer<typeof modelProviderCreateSchema>;

export type ModelProviderUpdate = z.infer<typeof modelProviderUpdateSchema>;

export type EncryptedModelProviderCreate = z.infer<
  typeof encryptedModelProviderCreateSchema
>;

export type EncryptedModelProviderUpdate = z.infer<
  typeof encryptedModelProviderUpdateSchema
>;

export type ModelProviderSummary = z.infer<typeof modelProviderSummarySchema>;

export type ModelProviderWireSummary = z.infer<
  typeof modelProviderWireSummarySchema
>;

export type ModelRouteInput = z.infer<typeof modelRouteInputSchema>;

export type ModelRouteSummary = z.infer<typeof modelRouteSummarySchema>;

export type ModelProfileCreate = z.infer<typeof modelProfileCreateSchema>;

export type ModelProfileUpdate = z.infer<typeof modelProfileUpdateSchema>;

export type ModelProfileSummary = z.infer<typeof modelProfileSummarySchema>;
