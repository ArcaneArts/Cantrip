import { z } from "zod";
import {
  providerInferenceConfigurationSchema,
  providerInferenceRevisionSchema,
} from "./inference-admission.js";
import { endpointProviderKinds } from "./provider-definitions.js";
import { modelCatalogPageRequestSchema } from "./model-catalog-pages.js";
import {
  modelEmbeddingCommandSchema,
  modelOperationCancelCommandSchema,
} from "./model-embedding.js";
import { modelDecisionCommandSchema } from "./model-decision.js";
import { taskInferenceInputReceiptSchema } from "./task-inference-input.js";
import {
  directCapabilityPrepareCommandSchema,
  directCapabilityRenewCommandSchema,
  directCapabilityRevokeCommandSchema,
} from "./direct-data-plane.js";
import {
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
  workerLinkIdentityResolveCommandSchema,
  workerLinkPeerSessionInstallCommandSchema,
  workerLinkPeerSessionRenewCommandSchema,
  workerLinkPeerSessionRevokeCommandSchema,
  workerLinkPeerSignalCommandSchema,
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
} from "./worker-link.js";
import {
  encryptionKeyBytesSchema,
  workerEncryptionRefreshRequestSchema,
} from "./encryption.js";
import { managedWebRuntimeActionRequestSchema } from "./worker-capabilities.js";
import { workerCredentialSecretSchema } from "./workers.js";
import {
  workerRuntimeProviderSchema,
  providerRateLimitResetConsumeInputSchema,
  serviceLogLevelSchema,
  workerLogStreamSubscriptionIdSchema,
} from "./worker-runtime-support.js";
import {
  chatFileReferencesCommandSchema,
  standaloneChatScratchProvisionCommandSchema,
  standaloneChatScratchResolveCommandSchema,
  standaloneChatScratchArchiveCommandSchema,
  standaloneChatScratchRestoreCommandSchema,
  standaloneChatScratchDeleteCommandSchema,
  standaloneChatScratchReconcileCommandSchema,
  standaloneChatFileOperationCommandSchema,
} from "./worker-command-shared.js";
import {
  workspaceRepositoryDiscoveryCommandSchema,
  workspaceRepositoryImportValidateCommandSchema,
} from "./workspace-repository-discovery.js";

export const workerCoreCommandSchemas = [
  modelEmbeddingCommandSchema,
  modelDecisionCommandSchema,
  modelOperationCancelCommandSchema,
  z.object({ type: z.literal("inference.status") }).strict(),
  z
    .object({
      type: z.literal("inference.task-revoke"),
      operationId: z.uuid(),
      ownerId: z.string().min(1).max(200),
      source: taskInferenceInputReceiptSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("inference.revoke"),
      ownerId: z.string().min(1).max(200),
      target: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("chat"),
            chatId: z.string().min(1).max(200),
          })
          .strict(),
        z
          .object({
            kind: z.literal("project"),
            projectId: z.string().min(1).max(200),
            // Canonical chat IDs captured by resource deletion also cover helpers
            // whose command owns a chat but does not carry project routing.
            chatIds: z.array(z.string().min(1).max(200)).max(1_000),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("inference.configure"),
      configurations: z.array(providerInferenceConfigurationSchema).max(10_000),
      catalogRevision: providerInferenceRevisionSchema.optional(),
    })
    .strict(),
  directCapabilityPrepareCommandSchema,
  directCapabilityRevokeCommandSchema,
  directCapabilityRenewCommandSchema,
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
  workerLinkIdentityResolveCommandSchema,
  workerLinkPeerSessionInstallCommandSchema,
  workerLinkPeerSessionRenewCommandSchema,
  workerLinkPeerSessionRevokeCommandSchema,
  workerLinkPeerSignalCommandSchema,
  standaloneChatScratchProvisionCommandSchema,
  standaloneChatScratchResolveCommandSchema,
  standaloneChatScratchArchiveCommandSchema,
  standaloneChatScratchRestoreCommandSchema,
  standaloneChatScratchDeleteCommandSchema,
  standaloneChatScratchReconcileCommandSchema,
  standaloneChatFileOperationCommandSchema,
  chatFileReferencesCommandSchema,
  workspaceRepositoryDiscoveryCommandSchema,
  workspaceRepositoryImportValidateCommandSchema,
  z.object({ type: z.literal("worker.version") }),
  z.object({ type: z.literal("worker.restart") }),
  managedWebRuntimeActionRequestSchema.extend({
    type: z.literal("web-runtime.action"),
  }),
  workerEncryptionRefreshRequestSchema.extend({
    type: z.literal("worker.encryption.refresh"),
  }),
  z.object({
    type: z.literal("diagnostics.logs.read"),
    afterCursor: z.number().int().nonnegative().default(0),
    beforeCursor: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(200),
    minimumLevel: serviceLogLevelSchema.default("trace"),
  }),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.start"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      afterCursor: z.number().int().nonnegative(),
      minimumLevel: serviceLogLevelSchema,
      leaseMs: z.number().int().min(10_000).max(300_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.renew"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      leaseMs: z.number().int().min(10_000).max(300_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.stop"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
    })
    .strict(),
  z.object({
    type: z.literal("worker.credential.rotate"),
    credential: workerCredentialSecretSchema,
  }),
  z.object({
    type: z.literal("model.ollama.catalog"),
    catalogPage: modelCatalogPageRequestSchema.optional(),
    provider: workerRuntimeProviderSchema.extend({ kind: z.literal("ollama") }),
  }),
  z.object({
    type: z.literal("model.endpoint.catalog"),
    catalogPage: modelCatalogPageRequestSchema.optional(),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.enum([...endpointProviderKinds, "openai-compatible"]),
    }),
  }),
  z.object({
    type: z.literal("model.chatgpt.catalog"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("chatgpt"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("model.grok.catalog"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("grok"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("provider.quota.read"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.enum(["chatgpt", "grok"]),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("provider.rate-limit-reset.consume"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("chatgpt"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
    idempotencyKey:
      providerRateLimitResetConsumeInputSchema.shape.idempotencyKey,
    creditId: providerRateLimitResetConsumeInputSchema.shape.creditId,
  }),
  z.object({
    type: z.literal("codex.auth.status"),
    providerId: z.string().min(1),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("codex.auth.login.start"),
    providerId: z.string().min(1),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
    observationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("codex.auth.logout"),
    providerId: z.string().min(1),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("provider.auth.legacy.capture"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("provider.auth.legacy.purge"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
    expectedSubjectBlindIndex: encryptionKeyBytesSchema,
    serverCredentialRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("provider.auth.account.clear"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
  }),
] as const;
