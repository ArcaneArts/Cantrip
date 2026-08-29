import { z } from "zod";

import {
  directBrokerAdvertisementSchema,
  unavailableDirectBroker,
} from "./direct-data-plane.js";
import {
  unavailableWorkerEncryptionStatus,
  workerEncryptionStatusSchema,
} from "./encryption.js";
import {
  codeCapabilitiesSchema,
  codexRuntimeReportSchema,
  defaultRemoteSurfaceCapabilities,
  remoteSurfaceCapabilitiesSchema,
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
} from "./runtime-capabilities.js";
import {
  codeGraphWorkerStatusSchema,
  managedFolderCapabilitiesSchema,
  managedWebRuntimeCapabilitiesSchema,
  projectReplicaCapabilitiesSchema,
  standaloneChatCapabilitiesSchema,
  unavailableCodeGraphWorkerStatus,
  unavailableManagedFolderCapabilities,
  unavailableManagedWebRuntimeCapabilities,
  unavailableProjectReplicaCapabilities,
  unavailableStandaloneChatCapabilities,
} from "./worker-capabilities.js";

export const workerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  codexVersion: z.string().nullable(),
  codexRuntime: codexRuntimeReportSchema.default(unprobedCodexRuntimeReport),
  remoteSurfaces: remoteSurfaceCapabilitiesSchema.default(
    defaultRemoteSurfaceCapabilities,
  ),
  directBroker: directBrokerAdvertisementSchema.default(
    unavailableDirectBroker,
  ),
  code: codeCapabilitiesSchema.optional(),
  projectReplicas: projectReplicaCapabilitiesSchema.default(
    unavailableProjectReplicaCapabilities,
  ),
  managedFolders: managedFolderCapabilitiesSchema.default(
    unavailableManagedFolderCapabilities,
  ),
  standaloneChat: standaloneChatCapabilitiesSchema.default(
    unavailableStandaloneChatCapabilities,
  ),
  chatRelocation: z.boolean().default(false),
  externalCodexHistory: z.boolean().default(false),
  codegraph: codeGraphWorkerStatusSchema.default(
    unavailableCodeGraphWorkerStatus,
  ),
  webRuntimes: managedWebRuntimeCapabilitiesSchema.default(
    unavailableManagedWebRuntimeCapabilities,
  ),
  encryption: workerEncryptionStatusSchema.default(
    unavailableWorkerEncryptionStatus,
  ),
  startedAt: z.string().datetime(),
});

export const workerSummarySchema = workerHeartbeatSchema.extend({
  code: codeCapabilitiesSchema.default(unavailableCodeCapabilities),
  online: z.boolean(),
  lastSeenAt: z.string().datetime(),
});

export const workerListSchema = z.array(workerSummarySchema);

export const workerManagementSourceSchema = z.object({
  projectReplicaId: z.string().min(1).nullable().default(null),
  projectId: z.string().uuid(),
  nameWithOwner: z.string().min(1),
  displayPath: z.string().min(1),
});

export const workerManagementSummarySchema = workerSummarySchema.extend({
  runtimeName: z.string().min(1),
  internal: z.boolean(),
  editable: z.boolean(),
  removable: z.boolean(),
  credentialCount: z.number().int().nonnegative(),
  activeCredentialCount: z.number().int().nonnegative(),
  sources: z.array(workerManagementSourceSchema),
});

export const workerManagementListSchema = z.array(
  workerManagementSummarySchema,
);

export const workerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const workerRestartAcknowledgementSchema = z.object({
  restarting: z.literal(true),
});

export const workerRestartResultSchema = z.object({
  workerId: z.string().min(1),
  status: z.literal("restarting"),
});

export const workerCredentialScopeSchema = z.enum([
  "worker:connect",
  "worker:heartbeat",
  "worker:automations",
  "worker:agent-tools",
]);

export const workerCredentialScopes = workerCredentialScopeSchema.options;

export const workerCredentialSecretSchema = z
  .string()
  .regex(/^ctwk_[A-Za-z0-9_-]{43}$/u);
const workerEnrollmentCodeSchema = z
  .string()
  .regex(/^ctwl_[A-Za-z0-9_-]{32}$/u);

export const workerEnrollmentCodeCreateSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable().default(null),
  expiresInSeconds: z.number().int().min(60).max(1_800).default(600),
  candidateWorkerIds: z.array(z.string().min(1).max(255)).max(64).default([]),
});

export const workerEnrollmentCodeResultSchema = z.object({
  id: z.string().uuid(),
  code: workerEnrollmentCodeSchema,
  label: z.string().min(1).max(120).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  workerId: z.string().min(1).max(255).nullable().default(null),
});

export const workerEnrollmentCodeStatusSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(120).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(["pending", "paired", "expired"]),
});

export const workerCredentialSummarySchema = z.object({
  id: z.string().uuid(),
  workerId: z.string().min(1).max(255),
  label: z.string().min(1).max(120).nullable(),
  scopes: z.array(workerCredentialScopeSchema),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  revokedReason: z.string().min(1).max(500).nullable(),
  active: z.boolean(),
});

export const workerCredentialListSchema = z.array(
  workerCredentialSummarySchema,
);

export const workerEnrollmentExchangeSchema = z.object({
  code: workerEnrollmentCodeSchema,
  heartbeat: workerHeartbeatSchema,
  replacement: z
    .object({
      workerId: z.string().min(1).max(255),
      credential: workerCredentialSecretSchema,
    })
    .nullable()
    .default(null),
});

export const workerEnrollmentResultSchema = z.object({
  credential: workerCredentialSecretSchema,
  credentialSummary: workerCredentialSummarySchema,
  worker: workerSummarySchema,
});

export const workerCredentialRotateSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable().default(null),
});

export const workerCredentialRotateResultSchema = z.object({
  credential: workerCredentialSecretSchema,
  credentialSummary: workerCredentialSummarySchema,
  delivered: z.boolean().default(false),
});

export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

export type WorkerSummary = z.infer<typeof workerSummarySchema>;

export type WorkerManagementSource = z.infer<
  typeof workerManagementSourceSchema
>;

export type WorkerManagementSummary = z.infer<
  typeof workerManagementSummarySchema
>;

export type WorkerUpdate = z.infer<typeof workerUpdateSchema>;

export type WorkerRestartResult = z.infer<typeof workerRestartResultSchema>;

export type WorkerCredentialScope = z.infer<typeof workerCredentialScopeSchema>;

export type WorkerEnrollmentCodeCreate = z.infer<
  typeof workerEnrollmentCodeCreateSchema
>;

export type WorkerEnrollmentCodeResult = z.infer<
  typeof workerEnrollmentCodeResultSchema
>;

export type WorkerEnrollmentCodeStatus = z.infer<
  typeof workerEnrollmentCodeStatusSchema
>;

export type WorkerCredentialSummary = z.infer<
  typeof workerCredentialSummarySchema
>;

export type WorkerEnrollmentExchange = z.infer<
  typeof workerEnrollmentExchangeSchema
>;

export type WorkerEnrollmentResult = z.infer<
  typeof workerEnrollmentResultSchema
>;

export type WorkerCredentialRotate = z.infer<
  typeof workerCredentialRotateSchema
>;

export type WorkerCredentialRotateResult = z.infer<
  typeof workerCredentialRotateResultSchema
>;
