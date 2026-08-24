import { z } from "zod";

import {
  decodeJsonMessage,
  encodeJsonMessage,
  type JsonMessageDecodeResult,
} from "./json-message.js";
import {
  codeSettingsProfileIdSchema,
  codeSettingsResolutionSchema,
} from "./code-settings.js";

export * from "./json-message.js";

export * from "./communication-content.js";
export * from "./model-configuration.js";
export * from "./attachment-content.js";
export * from "./explorer.js";
export * from "./surface-stream.js";
export * from "./repository-operation.js";
export * from "./endpoint-content.js";
export * from "./workflow-content.js";
export * from "./run-configurations.js";
export * from "./customization-content.js";
export * from "./tunnel-content.js";
export * from "./client-control-content.js";
export * from "./code-settings.js";
export * from "./resource-usage.js";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";
import {
  customizationContentScopeSchema,
  protectedCustomizationRequestSchema,
} from "./customization-content.js";
import {
  protectedTunnelContentRecordSchema,
  tunnelContentErrorCodeSchema,
  tunnelPublicDestinationEndpointSchema,
  tunnelPublicSourceEndpointSchema,
} from "./tunnel-content.js";

import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  encryptedInteractionResponseContentSchema,
  interactionProtectedClassificationSchema,
  interactionRequestOpaqueContentSchema,
  interactionResponseOpaqueContentSchema,
  queuedPromptOpaqueContentSchema,
} from "./communication-content.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import {
  attachmentChunkOpaqueSchema,
  attachmentProtectedMetadataSchema,
  chatAttachmentKindSchema,
  chatAttachmentListSchema,
  chatAttachmentOpaqueListSchema,
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSourceSchema,
  chatAttachmentSummarySchema,
} from "./attachment-content.js";
import {
  explorerDirectoryCommitsSchema,
  explorerDirectoryCommitEntrySchema,
  explorerDirectorySchema,
  explorerEntryDeleteSchema,
  explorerEntryMutationResultSchema,
  explorerEntryNameSchema,
  explorerEntryRenameSchema,
  explorerEntrySchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerLastCommitSchema,
  explorerMediaFileChunkSchema,
  explorerMediaFileSchema,
  explorerMediaKindSchema,
} from "./explorer.js";
import {
  surfaceStreamOpaqueSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import {
  repositoryOperationOpaqueSchema,
  repositoryOperationWireRequestSchema,
  repositoryRoutingHandleSchema,
} from "./repository-operation.js";
import {
  runConfigurationActionSchema,
  runConfigurationActionAddInputSchema,
  runConfigurationAuthoringDocumentSchema,
  runConfigurationAuthoringHelpSchema,
  runConfigurationAuthoringSnapshotSchema,
  protectedRunConfigurationAuthoringSnapshotSchema,
  protectedRunConfigurationInspectionSchema,
  protectedRunConfigurationWriteRequestSchema,
  runConfigurationDefinitionSchema,
  runConfigurationInspectionSchema,
  runConfigurationSelectionSchema,
  runConfigurationWriteRequestSchema,
  protectedRunEnvironmentSummarySchema,
  runInstanceResultSchema,
  runInstanceSchema,
  protectedWorkerRunLogSnapshotSchema,
  runLogResultSchema,
  runSetupStatusResultSchema,
  runStartResultSchema,
  workerRunSetupLookupSchema,
  protectedWorkerRunSetupLookupSchema,
  protectedWorkerRunSetupStatusSchema,
  worktreeSetupJobSummarySchema,
  workerRunIdentitySchema,
  workerRunSnapshotSchema,
} from "./run-configurations.js";

import {
  directBrokerAdvertisementSchema,
  directCapabilityPrepareCommandSchema,
  directCapabilityRenewCommandSchema,
  directCapabilityRevokeCommandSchema,
  unavailableDirectBroker,
} from "./direct-data-plane.js";

export * from "./direct-data-plane.js";

import { tunnelDataPlaneCloseCodeSchema } from "./tunnel-data-plane.js";

export * from "./tunnel-data-plane.js";

import { clientControlResultStatusSchema } from "./live.js";

export * from "./live.js";

export * from "./policies.js";

export * from "./tasks.js";

export * from "./encryption.js";
export * from "./protected-secrets.js";

export * from "./private-labels.js";
export * from "./surface-private-state.js";

import {
  effectivePolicyWireListSchema,
  policyCliListResultSchema,
  policyCliReadResultSchema,
  policyKeySchema,
} from "./policies.js";
import {
  taskGoalSyncContextSchema,
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskGoalWorkerResultSchema,
  taskMessageOpaqueContentSchema,
  taskMessageOpaqueSummarySchema,
  taskMessageRelayResultSchema,
  taskOpaqueContentSchema,
  taskOpaqueSummarySchema,
  taskOperationRelayGoalSchema,
  taskOperationRelayRequestSchema,
} from "./tasks.js";
import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyBytesSchema,
  unavailableWorkerEncryptionStatus,
  workerEncryptionRefreshRequestSchema,
  workerEncryptionStatusSchema,
} from "./encryption.js";
import {
  mcpServerOpaqueRuntimeSchema,
  providerCredentialProtectedContentSchema,
  providerCredentialPublicMetadataSchema,
  protectedProviderCredentialSchema,
  protectedSecretEnvelopeSchema,
} from "./protected-secrets.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  browserPrivateStateOpaqueSchema,
  explorerPrivateStateOpaqueSchema,
  remoteDesktopPrivateInventoryOpaqueSchema,
  remoteDesktopPrivateStateOpaqueSchema,
  terminalPrivateStateOpaqueSchema,
} from "./surface-private-state.js";

import { projectAutomationOpaqueContentSchema } from "./automations.js";
import {
  protectedWorkflowGateDecisionRequestSchema,
  protectedWorkflowNodeExecutionRequestSchema,
  protectedWorkflowTriggerPrepareRequestSchema,
  workflowJsonObjectSchema,
  workflowNodeExecutionResultSchema,
  workflowRepositoryDocumentSchema,
} from "./workflows.js";

export const protocolVersionSchema = z.literal(1);
export const cantripVersionSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    patch: z.number().int().nonnegative(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .superRefine((value, context) => {
    if (value.version === `${value.major}.${value.minor}.${value.patch}`)
      return;
    context.addIssue({
      code: "custom",
      message: "Version string does not match its numeric components.",
      path: ["version"],
    });
  });
export const databaseEngineSchema = z.enum(["pglite", "postgres"]);
export const deploymentModeSchema = z.enum(["local", "hosted"]);
export const bootstrapModeSchema = z.enum([
  "pnpm-dev",
  "tauri",
  "standalone",
  "hosted",
]);
export const authModeSchema = z.enum(["none", "password", "accounts"]);
export const authenticationStateSchema = z.enum([
  "authenticated",
  "authentication-required",
]);
export const userRoleSchema = z.enum(["owner", "admin", "member"]);

export const remoteSurfaceProtocolVersionSchema = z.literal(1);
export const remoteSurfaceKindSchema = z.enum(["browser", "desktop"]);
export const remoteSurfaceTransportSchema = z.enum(["websocket", "webrtc"]);
export const remoteSurfaceIceTransportPolicySchema = z.enum(["all", "relay"]);
export const remoteSurfaceStatusSchema = z.enum([
  "idle",
  "connecting",
  "active",
  "suspended",
  "offline",
  "error",
]);
export const remoteSurfaceChannelSchema = z.enum([
  "control",
  "frame",
  "cursor",
  "clipboard",
  "webrtc-signal",
]);

export const remoteSurfaceCapabilitiesSchema = z.object({
  browser: z.boolean().default(false),
  desktop: z.boolean().default(false),
  transports: z.array(remoteSurfaceTransportSchema).min(1),
  iceTransportPolicies: z
    .array(remoteSurfaceIceTransportPolicySchema)
    .min(1)
    .default(["relay"]),
  maxSessions: z.number().int().positive(),
});

export const codeTransportSchema = z.literal("web-proxy");
export const codeCapabilitiesSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).nullable(),
  upstreamRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  patchset: z.number().int().nonnegative(),
  transport: codeTransportSchema,
  maxSessions: z.number().int().positive(),
  reason: z.string().min(1).nullable(),
});

export const unavailableCodeCapabilities = codeCapabilitiesSchema.parse({
  available: false,
  version: null,
  upstreamRevision: null,
  patchset: 0,
  transport: "web-proxy",
  maxSessions: 1,
  reason: "This worker has not reported a Cantrip Code runtime.",
});

export const remoteSurfaceIceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().min(1).optional(),
  credential: z.string().min(1).optional(),
});

export const remoteSurfaceWebRtcConfigurationSchema = z.object({
  iceServers: z.array(remoteSurfaceIceServerSchema).max(16),
  iceTransportPolicy: remoteSurfaceIceTransportPolicySchema,
  negotiationTimeoutMs: z.number().int().min(1_000).max(30_000),
});

export const remoteSurfaceWebRtcSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(1_000_000) }),
  z.object({
    type: z.literal("answer"),
    sdp: z.string().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal("candidate"),
    candidate: z.string().min(1).max(16_384),
    sdpMid: z.string().max(1_024).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable(),
    usernameFragment: z.string().max(1_024).nullable(),
  }),
  z.object({ type: z.literal("end-of-candidates") }),
  z.object({
    type: z.literal("transport-state"),
    state: z.enum(["connected", "failed", "closed"]),
    message: z.string().max(2_048).nullable(),
  }),
]);

function defaultRemoteSurfaceCapabilities(): z.infer<
  typeof remoteSurfaceCapabilitiesSchema
> {
  return {
    browser: false,
    desktop: false,
    transports: ["websocket"],
    iceTransportPolicies: ["relay"],
    maxSessions: 4,
  };
}

export const userSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["anonymous", "account"]),
  displayName: z.string().min(1),
  email: z.email().nullable(),
  role: userRoleSchema.default("member"),
});

const authPasswordSchema = z.string().min(12).max(1_024);

export const accountRegistrationSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  password: authPasswordSchema,
});

export const accountLicenseWhitelistEntrySchema = z.object({
  id: z.string().min(1),
  email: z.email().max(320),
  registered: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const accountLicenseWhitelistCreateSchema = z.object({
  email: z.email().max(320),
});

export const accountAdminSummarySchema = z.object({
  userCount: z.number().int().nonnegative(),
  licenseWhitelist: z.object({
    enabled: z.boolean(),
    adminEmail: z.email().max(320).nullable(),
    entries: z.array(accountLicenseWhitelistEntrySchema).max(10_000),
  }),
});

export const authLoginSchema = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(1).max(1_024),
});

export const authReauthenticationSchema = z
  .object({ password: z.string().min(1).max(1_024) })
  .strict();

export const authReauthenticationResultSchema = z
  .object({ verified: z.literal(true) })
  .strict();

export const authSessionSchema = z.object({
  currentUser: userSummarySchema,
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
});

export const authSessionStateSchema = z.object({
  currentUser: userSummarySchema.nullable(),
  csrfToken: z.string().min(32).nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export const mobileSignInGrantCreateResultSchema = z.object({
  code: z.string().regex(/^ctms_[A-Za-z0-9_-]{32}$/u),
  expiresAt: z.iso.datetime(),
});

export const mobileSignInGrantExchangeSchema = z.object({
  code: z.string().regex(/^ctms_[A-Za-z0-9_-]{32}$/u),
});

export const mobileSignInQrPayloadSchema = z.object({
  type: z.literal("cantrip.mobile-sign-in"),
  version: z.literal(1),
  serverId: z.string().min(1),
  serverName: z.string().trim().min(1).max(120),
  serverUrl: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Server URL must use HTTP or HTTPS."),
  code: mobileSignInGrantExchangeSchema.shape.code,
  expiresAt: z.iso.datetime(),
});

export const authLogoutAllResultSchema = z.object({
  revokedSessions: z.number().int().nonnegative(),
});

export const accountSessionSummarySchema = z.object({
  id: z.string().min(1),
  authMethod: z.enum(["password", "account-password", "mobile-qr"]),
  label: z.string().max(200).nullable(),
  current: z.boolean(),
  connected: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const accountSessionListSchema = z
  .array(accountSessionSummarySchema)
  .max(1_000);

export const auditEventSchema = z
  .object({
    id: z.number().int().positive(),
    ownerId: z.string().min(1).nullable(),
    actor: z.object({
      userId: z.string().min(1).nullable(),
      sessionId: z.string().min(1).nullable(),
    }),
    action: z
      .string()
      .min(3)
      .max(160)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u),
    result: z.enum(["succeeded", "failed", "denied"]),
    resource: z.object({
      type: z.string().min(1).max(80),
      id: z.string().min(1).max(500).nullable(),
    }),
    requestId: z.string().min(1).max(200).nullable(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const auditEventListSchema = z.object({
  items: z.array(auditEventSchema).max(200),
  nextCursor: z.number().int().positive().nullable(),
});

export const auditEventQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const serverBootstrapSchema = z.object({
  protocolVersion: protocolVersionSchema,
  server: z.object({
    id: z.string().min(1),
    version: cantripVersionSchema,
    deploymentMode: deploymentModeSchema,
    bootstrapMode: bootstrapModeSchema,
  }),
  auth: z.object({
    mode: authModeSchema,
    state: authenticationStateSchema.default("authenticated"),
    currentUser: userSummarySchema.nullable(),
    registration: z
      .object({
        enabled: z.boolean(),
        bootstrapRequired: z.boolean().default(false),
        licenseRequired: z.boolean().default(false),
      })
      .default({
        enabled: false,
        bootstrapRequired: false,
        licenseRequired: false,
      }),
  }),
  routing: z.object({
    workerConnection: z.literal("server-only"),
    directWorkerConnections: z.literal(false),
  }),
  storage: z.object({
    conversations: z.literal("server"),
    files: z.literal("worker"),
  }),
  agent: z.object({
    model: z.string().min(1),
    modelProvider: z.string().min(1),
  }),
  capabilities: z.object({
    accounts: z.boolean(),
    passwordProtection: z.boolean(),
    linkCodes: z.boolean(),
    multipleWorkers: z.boolean(),
    projectReplicas: z.boolean().default(false),
    replicaProvisioning: z.boolean().default(false),
    browserFleetDiscovery: z.boolean().default(false),
    crossWorkerExecutionTargets: z.boolean().default(false),
    remoteDesktopFleet: z.boolean().default(false),
    workerSwitching: z.boolean(),
    gitSync: z.boolean(),
    worktrees: z.boolean(),
    remoteSurfaces: z.object({
      enabled: z.boolean(),
      transports: z.array(remoteSurfaceTransportSchema).min(1),
      relayOnly: z.boolean(),
    }),
    code: z.object({
      enabled: z.boolean(),
      transport: codeTransportSchema,
      isolatedOrigin: z.literal(true),
    }),
  }),
});

export const desktopUpdateActiveWorkSummarySchema = z.object({
  activeChats: z.number().int().nonnegative().max(4_294_967_295),
  queuedPrompts: z.number().int().nonnegative().max(4_294_967_295),
  terminalServices: z.number().int().nonnegative().max(4_294_967_295),
  backgroundJobs: z.number().int().nonnegative().max(4_294_967_295),
});

export const codexRuntimeMethodStateSchema = z.enum([
  "available",
  "unavailable",
  "unknown",
]);

export const codexRuntimeFeatureStageSchema = z.enum([
  "beta",
  "underDevelopment",
  "stable",
  "deprecated",
  "removed",
]);

export const codexRuntimeFeatureSchema = z.object({
  name: z.string().min(1),
  stage: codexRuntimeFeatureStageSchema,
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
});

export const NATIVE_SUBAGENT_PROTOCOL_VERSION = 1 as const;

export const nativeSubagentRuntimeCapabilitySchema = z
  .object({
    available: z.boolean(),
    protocolVersion: z.number().int().positive().nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export function nativeSubagentCapabilityCompatible(
  capability: z.infer<typeof nativeSubagentRuntimeCapabilitySchema>,
): boolean {
  return (
    capability.available &&
    capability.protocolVersion === NATIVE_SUBAGENT_PROTOCOL_VERSION
  );
}

export const unavailableNativeSubagentRuntimeCapability =
  nativeSubagentRuntimeCapabilitySchema.parse({
    available: false,
    protocolVersion: null,
    reason: "This worker has not reported native subagent support.",
  });

export const codexRuntimeReportSchema = z.object({
  adapter: z.literal("app-server"),
  compatibility: z.enum(["compatible", "partial", "incompatible", "missing"]),
  version: z
    .object({
      raw: z.string().min(1),
      semantic: z.string().regex(/^\d+\.\d+\.\d+$/u),
    })
    .nullable(),
  testedRange: z.string().min(1),
  initialize: z
    .object({
      userAgent: z.string().min(1),
      platformFamily: z.string().min(1),
      platformOs: z.string().min(1),
      experimentalApi: z.boolean(),
    })
    .nullable(),
  methods: z.record(z.string().min(1), codexRuntimeMethodStateSchema),
  features: z.array(codexRuntimeFeatureSchema),
  nativeSubagents: nativeSubagentRuntimeCapabilitySchema.default(
    unavailableNativeSubagentRuntimeCapability,
  ),
  degradedReasons: z.array(z.string().min(1)),
});

export const unprobedCodexRuntimeReport = codexRuntimeReportSchema.parse({
  adapter: "app-server",
  compatibility: "missing",
  version: null,
  testedRange: ">=0.149.0 <0.150.0",
  initialize: null,
  methods: {},
  features: [],
  degradedReasons: ["This worker has not reported runtime compatibility."],
});

export const projectReplicaCapabilitiesSchema = z.object({
  provision: z.boolean(),
  synchronize: z.boolean(),
  remove: z.boolean(),
  exactRevision: z.boolean(),
  directPlacement: z.boolean().default(false),
  managedLinkPlacement: z.boolean().default(false),
  attachExisting: z.boolean().default(false),
  recursiveParentCreation: z.boolean().default(false),
});

export const unavailableProjectReplicaCapabilities =
  projectReplicaCapabilitiesSchema.parse({
    provision: false,
    synchronize: false,
    remove: false,
    exactRevision: false,
    directPlacement: false,
    managedLinkPlacement: false,
    attachExisting: false,
    recursiveParentCreation: false,
  });

export const managedFolderCapabilitiesSchema = z.object({
  create: z.boolean(),
  attachExisting: z.boolean().default(false),
  convertToGithub: z.boolean().default(false),
  remove: z.boolean(),
});

export const unavailableManagedFolderCapabilities =
  managedFolderCapabilitiesSchema.parse({
    create: false,
    attachExisting: false,
    convertToGithub: false,
    remove: false,
  });

export const codeGraphRuntimeStateSchema = z.enum([
  "checking",
  "degraded",
  "installing",
  "ready",
  "unavailable",
]);

export const codeGraphProjectStateSchema = z.enum([
  "degraded",
  "indexing",
  "queued",
  "ready",
  "syncing",
  "unavailable",
]);

export const codeGraphProjectCountsSchema = z.object({
  ready: z.number().int().nonnegative().max(128),
  indexing: z.number().int().nonnegative().max(128),
  queued: z.number().int().nonnegative().max(128),
  degraded: z.number().int().nonnegative().max(128),
});

export const codeGraphWorkerStatusSchema = z.object({
  supported: z.boolean(),
  available: z.boolean(),
  runtimeState: codeGraphRuntimeStateSchema,
  installedVersion: z.string().trim().min(1).max(100).nullable(),
  latestVersion: z.string().trim().min(1).max(100).nullable(),
  previousVersion: z.string().trim().min(1).max(100).nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  telemetryDisabled: z.boolean(),
  healthy: z.boolean(),
  statusMessage: z.string().max(1_000).nullable(),
  projectCounts: codeGraphProjectCountsSchema,
  cliAvailable: z.boolean(),
  mcpInjectionAvailable: z.boolean(),
});

export const unavailableCodeGraphWorkerStatus =
  codeGraphWorkerStatusSchema.parse({
    supported: false,
    available: false,
    runtimeState: "unavailable",
    installedVersion: null,
    latestVersion: null,
    previousVersion: null,
    lastCheckedAt: null,
    telemetryDisabled: false,
    healthy: false,
    statusMessage: "This worker has not reported CodeGraph capabilities.",
    projectCounts: { ready: 0, indexing: 0, queued: 0, degraded: 0 },
    cliAvailable: false,
    mcpInjectionAvailable: false,
  });

export const codeGraphJobSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["sync", "rebuild"]),
  state: z.enum(["queued", "running", "completed", "failed"]),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const codeGraphProjectStatusSchema = z
  .object({
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    state: codeGraphProjectStateSchema,
    lastIndexedAt: z.iso.datetime().nullable(),
    lastSuccessfulSyncAt: z.iso.datetime().nullable(),
    fileCount: z.number().int().nonnegative().nullable(),
    nodeCount: z.number().int().nonnegative().nullable(),
    edgeCount: z.number().int().nonnegative().nullable(),
    pendingChanges: z.number().int().nonnegative().nullable(),
    statusMessage: z.string().max(1_000).nullable(),
    job: codeGraphJobSchema.nullable(),
  })
  .strict();

export const codeGraphActionAcknowledgementSchema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(["sync", "rebuild", "update-check"]),
  acceptedAt: z.iso.datetime(),
  status: z.literal("queued"),
});

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
  chatRelocation: z.boolean().default(false),
  externalCodexHistory: z.boolean().default(false),
  codegraph: codeGraphWorkerStatusSchema.default(
    unavailableCodeGraphWorkerStatus,
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

const workerCredentialSecretSchema = z
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

export const skillSummarySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  displayName: z.string().min(1).nullable(),
});

export const skillListSchema = z.array(skillSummarySchema);

export const customizationCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
  stability: z.enum(["stable", "experimental", "unsupported"]),
});

export const nativeSubagentCustomizationCapabilitySchema =
  customizationCapabilitySchema.extend({
    protocolVersion: z.literal(NATIVE_SUBAGENT_PROTOCOL_VERSION).nullable(),
  });

export const codexCustomizationCapabilitiesSchema = z.object({
  isolatedCodexHome: z.literal(true),
  collaborationModes: customizationCapabilitySchema,
  threadGoals: customizationCapabilitySchema,
  nativeSubagents: nativeSubagentCustomizationCapabilitySchema,
  customAgents: customizationCapabilitySchema,
  hooks: customizationCapabilitySchema,
  skills: z.object({
    list: customizationCapabilitySchema,
    configure: customizationCapabilitySchema,
    extraRoots: customizationCapabilitySchema,
  }),
  mcp: z.object({
    status: customizationCapabilitySchema,
    resourceRead: customizationCapabilitySchema,
    oauth: customizationCapabilitySchema,
    reload: customizationCapabilitySchema,
  }),
  plugins: z.object({
    list: customizationCapabilitySchema,
    read: customizationCapabilitySchema,
    install: customizationCapabilitySchema,
    uninstall: customizationCapabilitySchema,
  }),
  externalImports: z.object({
    detect: customizationCapabilitySchema,
    apply: customizationCapabilitySchema,
  }),
});

export const codexSkillInventoryItemSchema = skillSummarySchema.extend({
  path: z.string().min(1),
  scope: z.enum(["user", "repo", "system", "admin"]),
  enabled: z.boolean(),
});

export const codexInventoryErrorSchema = z.object({
  path: z.string(),
  message: z.string().min(1),
});

export const codexHookInventoryItemSchema = z.object({
  key: z.string().min(1),
  eventName: z.enum([
    "preToolUse",
    "permissionRequest",
    "postToolUse",
    "preCompact",
    "postCompact",
    "sessionStart",
    "sessionEnd",
    "userPromptSubmit",
    "subagentStart",
    "subagentStop",
    "stop",
  ]),
  handlerType: z.enum(["command", "prompt", "agent"]),
  matcher: z.string().nullable(),
  command: z.string().nullable(),
  timeoutSeconds: z.number().int().nonnegative(),
  statusMessage: z.string().nullable(),
  sourcePath: z.string().min(1),
  source: z.enum([
    "system",
    "user",
    "project",
    "mdm",
    "sessionFlags",
    "plugin",
    "cloudRequirements",
    "cloudManagedConfig",
    "legacyManagedConfigFile",
    "legacyManagedConfigMdm",
    "unknown",
  ]),
  pluginId: z.string().nullable(),
  enabled: z.boolean(),
  managed: z.boolean(),
  trust: z.enum(["managed", "untrusted", "trusted", "modified"]),
});

export const codexMcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().nullable(),
});

export const codexMcpResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
});

export const codexMcpResourceTemplateSchema = z.object({
  uriTemplate: z.string().min(1),
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
});

export const codexMcpServerSchema = z.object({
  name: z.string().min(1),
  serverInfo: z
    .object({
      name: z.string().min(1),
      title: z.string().nullable(),
      version: z.string(),
      description: z.string().nullable(),
      websiteUrl: z.string().nullable(),
    })
    .nullable(),
  authStatus: z.enum(["unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
  tools: z.array(codexMcpToolSchema),
  resources: z.array(codexMcpResourceSchema),
  resourceTemplates: z.array(codexMcpResourceTemplateSchema),
});

export const codexCustomizationInventorySchema = z.object({
  capabilities: codexCustomizationCapabilitiesSchema,
  skills: z.object({
    items: z.array(codexSkillInventoryItemSchema),
    errors: z.array(codexInventoryErrorSchema),
  }),
  skillRoots: z.array(z.string().min(1).max(8_192)).max(32).default([]),
  hooks: z.object({
    items: z.array(codexHookInventoryItemSchema),
    warnings: z.array(z.string()),
    errors: z.array(codexInventoryErrorSchema),
  }),
  mcpServers: z.array(codexMcpServerSchema),
});

export const codexExternalImportItemTypeSchema = z.enum([
  "AGENTS_MD",
  "CONFIG",
  "SKILLS",
  "PLUGINS",
  "MCP_SERVER_CONFIG",
  "SUBAGENTS",
  "HOOKS",
  "COMMANDS",
  "MEMORY",
  "SESSIONS",
]);

export const codexExternalImportPreviewItemSchema = z.object({
  id: z.string().min(1),
  itemType: codexExternalImportItemTypeSchema,
  description: z.string(),
  cwd: z.string().nullable(),
  details: z
    .object({
      pluginNames: z.array(z.string().min(1)),
      skillNames: z.array(z.string().min(1)),
      sessionCount: z.number().int().nonnegative(),
      mcpServerNames: z.array(z.string().min(1)),
      hookNames: z.array(z.string().min(1)),
      subagentNames: z.array(z.string().min(1)),
      commandNames: z.array(z.string().min(1)),
      memoryFiles: z.array(z.string().min(1)),
    })
    .nullable(),
});

export const codexExternalImportPreviewSchema = z.object({
  sourceScope: z.literal("project"),
  items: z.array(codexExternalImportPreviewItemSchema),
});

export const codexMcpResourceContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    uri: z.string().min(1),
    mimeType: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("blob"),
    uri: z.string().min(1),
    mimeType: z.string().nullable(),
    blob: z.string(),
  }),
]);

export const codexMcpResourceReadSchema = z.object({
  contents: z.array(codexMcpResourceContentSchema),
});

export const codexMcpResourceReadRequestSchema = z.object({
  server: z.string().trim().min(1).max(256),
  uri: z.string().trim().min(1).max(8_192),
});

export const codexSkillConfigUpdateSchema = z.object({
  path: z.string().trim().min(1).max(8_192),
  enabled: z.boolean(),
});

export const codexSkillConfigResultSchema = z.object({
  path: z.string().min(1).max(8_192),
  effectiveEnabled: z.boolean(),
});

export const codexSkillRootsUpdateSchema = z.object({
  roots: z.array(z.string().trim().min(1).max(8_192)).max(32),
});

export const codexSkillRootsResultSchema = z.object({
  roots: z.array(z.string().min(1)).max(32),
});

export const skillSettingsLocationSchema = z.enum([
  "project",
  "account",
  "user",
  "codexUser",
  "system",
  "admin",
]);

export const skillSettingsItemSchema = skillSummarySchema.extend({
  id: z.string().min(1).max(8_192),
  scope: z.enum(["repo", "user", "system", "admin"]),
  location: skillSettingsLocationSchema,
  path: z.string().min(1).max(8_192),
  editable: z.boolean(),
  deletable: z.boolean(),
});

export const skillSettingsErrorSchema = z.object({
  path: z.string().max(8_192),
  message: z.string().min(1).max(2_000),
});

export const skillSettingsInventorySchema = z.object({
  project: z.array(skillSettingsItemSchema).max(1_000),
  global: z.array(skillSettingsItemSchema).max(1_000),
  errors: z.array(skillSettingsErrorSchema).max(200),
});

export const skillSettingsFileSchema = z.object({
  path: z.string().min(1).max(8_192),
  sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
});

export const skillSettingsDocumentSchema = z.object({
  skill: skillSettingsItemSchema,
  file: skillSettingsFileSchema,
  files: z.array(skillSettingsFileSchema).max(500),
  content: z.string().max(1_000_000),
});

export const skillSettingsContextSchema = z.object({
  workerId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200).nullable().default(null),
});

export const skillSettingsFileRequestSchema = skillSettingsContextSchema.extend(
  {
    skillId: skillSettingsItemSchema.shape.id,
    file: skillSettingsFileSchema.shape.path.default("SKILL.md"),
  },
);

export const skillSettingsFileUpdateSchema =
  skillSettingsFileRequestSchema.extend({
    content: z.string().max(1_000_000),
  });

export const skillSettingsDeleteRequestSchema =
  skillSettingsContextSchema.extend({
    skillId: skillSettingsItemSchema.shape.id,
  });

export const skillSettingsMutationResultSchema = z.object({
  changed: z.literal(true),
  recoveryPath: z.string().min(1).max(8_192).nullable(),
});

export const codexMcpOauthStartSchema = z.object({
  server: z.string().trim().min(1).max(256),
});

export const codexMcpOauthStartResultSchema = z.object({
  server: z.string().min(1).max(256),
  authorizationUrl: z.string().url().max(8_192),
  status: z.literal("pending"),
});

export const codexMcpOauthStatusSchema = z.object({
  server: z.string().min(1).max(256),
  status: z.enum(["pending", "succeeded", "failed", "unknown"]),
  error: z.string().max(2_000).nullable(),
});

export const codexMcpReloadResultSchema = z.object({
  reloaded: z.literal(true),
});

export const codexMcpReloadRequestSchema = z.object({}).strict();

export const codexExternalImportApplySchema = z
  .object({
    itemIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .superRefine(({ itemIds }, context) => {
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        message: "Import item ids must be unique.",
        path: ["itemIds"],
      });
    }
  });

export const codexExternalImportFailureSchema = z.object({
  failureStage: z.string().max(200),
  message: z.string().max(2_000),
});

export const codexExternalImportTypeResultSchema = z.object({
  itemType: codexExternalImportItemTypeSchema,
  successCount: z.number().int().nonnegative(),
  failures: z.array(codexExternalImportFailureSchema).max(100),
});

export const codexExternalImportStatusSchema = z.object({
  importId: z.string().min(1).max(200),
  status: z.enum(["pending", "completed", "unknown"]),
  results: z.array(codexExternalImportTypeResultSchema).max(100),
});

export function mentionedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu,
  )) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

export const operationalProbeSchema = z.object({
  status: z.enum(["alive", "ready", "not-ready"]),
  service: z.literal("cantrip_server"),
  database: z
    .object({
      engine: databaseEngineSchema,
      status: z.enum(["ready", "unavailable"]),
      latencyMs: z.number().nonnegative(),
    })
    .optional(),
  coordination: z
    .object({
      shared: z.boolean(),
      status: z.enum(["ready", "unavailable"]),
    })
    .optional(),
  timestamp: z.string().datetime(),
});

const operationalCounterSchema = z.number().int().nonnegative();

export const serverOperationalStatsSchema = z.object({
  instanceId: z.string().min(1).max(100),
  uptimeSeconds: z.number().nonnegative(),
  http: z.object({
    activeRequests: operationalCounterSchema,
    requestCount: operationalCounterSchema,
  }),
  coordination: z.object({
    cachedWorkers: operationalCounterSchema,
    instanceCount: operationalCounterSchema,
    maximumInstances: z.number().int().positive(),
    receivedMessages: operationalCounterSchema,
    rejectedMessages: operationalCounterSchema,
    sentMessages: operationalCounterSchema,
    shared: z.boolean(),
  }),
  workerCommands: z.object({
    activeRequests: operationalCounterSchema,
    connectedWorkers: operationalCounterSchema,
    failedRequests: operationalCounterSchema,
    routedRequests: operationalCounterSchema,
    succeededRequests: operationalCounterSchema,
  }),
  tunnels: z.object({
    activeConnections: operationalCounterSchema,
    activeRoutes: operationalCounterSchema,
    bytesFromSource: operationalCounterSchema,
    bytesToSource: operationalCounterSchema,
    closedConnections: operationalCounterSchema,
    openedConnections: operationalCounterSchema,
    rejectedConnections: operationalCounterSchema,
    terminationsByReason: z.record(
      tunnelDataPlaneCloseCodeSchema,
      operationalCounterSchema,
    ),
  }),
  quotas: z.object({
    activeRemoteSurfaces: operationalCounterSchema,
    rejectedRelayBandwidth: operationalCounterSchema,
    rejectedRemoteSurfaces: operationalCounterSchema,
    rejectedUploads: operationalCounterSchema,
    relayBytes: operationalCounterSchema,
    uploadBytes: operationalCounterSchema,
  }),
  scheduler: z.object({
    dispatchFailures: operationalCounterSchema,
    dispatches: operationalCounterSchema,
    dueOccurrences: operationalCounterSchema,
    lastScanAt: z.string().datetime().nullable(),
    lastScanDurationSeconds: z.number().nonnegative(),
    leaseContentions: operationalCounterSchema,
    leaseRecoveries: operationalCounterSchema,
    maximumLagSeconds: z.number().nonnegative(),
    scanFailures: operationalCounterSchema,
    scans: operationalCounterSchema,
  }),
});

export const systemHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("cantrip_server"),
  database: z.object({
    engine: databaseEngineSchema,
    ready: z.boolean(),
  }),
  workers: z.object({
    connected: z.number().int().nonnegative(),
  }),
  live: z.object({
    acceptedConnectionCount: z.number().int().nonnegative(),
    connectionCount: z.number().int().nonnegative(),
    currentCursor: z.number().int().nonnegative(),
    deliveredEventCount: z.number().int().nonnegative(),
    disconnectedConnectionCount: z.number().int().nonnegative(),
    heartbeatPongCount: z.number().int().nonnegative(),
    heartbeatTimeoutCount: z.number().int().nonnegative(),
    protocolViolationCount: z.number().int().nonnegative(),
    publicationCount: z.number().int().nonnegative(),
    queuePressureCount: z.number().int().nonnegative(),
    replayEventCount: z.number().int().nonnegative(),
    replaySessionCount: z.number().int().nonnegative(),
    replayedEventCount: z.number().int().nonnegative(),
    resyncRequiredCount: z.number().int().nonnegative(),
    resumeAttemptCount: z.number().int().nonnegative(),
    serverEpoch: z.string().uuid(),
    slowConsumerClosureCount: z.number().int().nonnegative(),
  }),
  // Optional while clients and independently deployed servers roll across the
  // release that introduced operational counters.
  operations: serverOperationalStatsSchema.optional(),
  timestamp: z.string().datetime(),
});

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);

export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 192;
export const MAX_SIDEBAR_WIDTH = 480;
export const sidebarWidthPreferenceSchema = z
  .number()
  .int()
  .min(MIN_SIDEBAR_WIDTH)
  .max(MAX_SIDEBAR_WIDTH);
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

const mcpKeyValueSchema = z
  .record(z.string().trim().min(1).max(256), z.string().max(65_536))
  .refine((value) => Object.keys(value).length <= 100, {
    message: "MCP key/value collections cannot contain more than 100 entries.",
  })
  .refine(
    (value) =>
      Object.entries(value).reduce(
        (size, [key, item]) => size + key.length + item.length,
        0,
      ) <= 524_288,
    {
      message: "MCP key/value collections cannot exceed 512 KiB.",
    },
  );

/**
 * Placeholder returned for persisted MCP values that may contain credentials.
 * Sending the placeholder back during an update preserves the existing value;
 * Cantrip never sends the underlying secret to an application client.
 */
export const MCP_SECRET_MASK = "••••••••";

/**
 * Reserved for the worker-synthesized CodeGraph MCP. This is intentionally a
 * protocol-level invariant so old clients cannot create a user server that
 * shadows the managed runtime through a server API.
 */
export const MANAGED_CODEGRAPH_MCP_NAME = "codegraph" as const;
export const MANAGED_CANTRIP_MCP_NAME = "cantrip" as const;

export function isManagedCodeGraphMcpName(name: string): boolean {
  return name.trim().toLowerCase() === MANAGED_CODEGRAPH_MCP_NAME;
}

export function isManagedCantripMcpName(name: string): boolean {
  return name.trim().toLowerCase() === MANAGED_CANTRIP_MCP_NAME;
}

export function isManagedMcpName(name: string): boolean {
  return isManagedCodeGraphMcpName(name) || isManagedCantripMcpName(name);
}

export const mcpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/u, {
    message: "Use only letters, numbers, hyphens, and underscores.",
  });

const mcpServerSharedSchema = z.object({
  name: mcpServerNameSchema,
  enabled: z.boolean().default(true),
});

export const mcpServerStdioConfigurationSchema = mcpServerSharedSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(8_192),
  args: z.array(z.string().max(8_192)).max(100).default([]),
  environment: mcpKeyValueSchema.default({}),
});

export const mcpServerHttpConfigurationSchema = mcpServerSharedSchema.extend({
  transport: z.literal("http"),
  url: z.url().max(8_192),
  bearerTokenEnvironmentVariable: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .nullable()
    .default(null),
  headers: mcpKeyValueSchema.default({}),
  environmentHeaders: mcpKeyValueSchema.default({}),
});

export const mcpServerConfigurationSchema = z.discriminatedUnion("transport", [
  mcpServerStdioConfigurationSchema,
  mcpServerHttpConfigurationSchema,
]);

export const encryptedMcpServerCreateSchema = z
  .object({
    id: z.string().uuid(),
    enabled: z.boolean(),
    workerId: z.string().min(1).max(255).nullable().default(null),
    nameBlindIndex: encryptionKeyBytesSchema,
    protectedConfiguration: protectedSecretEnvelopeSchema,
  })
  .strict();

export const encryptedMcpServerUpdateSchema = encryptedMcpServerCreateSchema
  .omit({ id: true })
  .strict();

export const mcpServerDiscoverySourceSchema = z.enum([
  "codex",
  "claude",
  "localhost",
]);
export const mcpServerDiscoveryScopeSchema = z.enum(["user", "project"]);

export const mcpServerDiscoveryCandidateSchema = z
  .object({
    source: mcpServerDiscoverySourceSchema,
    sourceScope: mcpServerDiscoveryScopeSchema,
    configuration: encryptedMcpServerCreateSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (!candidate.configuration.workerId) {
      context.addIssue({
        code: "custom",
        message: "Discovered MCP servers must be bound to their worker.",
        path: ["configuration", "workerId"],
      });
    }
  });

export const mcpServerDiscoveryIssueSchema = z
  .object({
    source: mcpServerDiscoverySourceSchema,
    sourceScope: mcpServerDiscoveryScopeSchema,
    code: z.enum(["invalid-config", "unsupported-transport"]),
    message: z.string().min(1).max(500),
  })
  .strict();

export const mcpServerDiscoveryResultSchema = z
  .object({
    workerId: z.string().min(1).max(255),
    observedAt: z.string().datetime(),
    candidates: z.array(mcpServerDiscoveryCandidateSchema).max(200),
    issues: z.array(mcpServerDiscoveryIssueSchema).max(200),
  })
  .strict();

export const mcpServerScopeSchema = z.enum(["global", "project"]);

export const mcpServerSummarySchema = mcpServerConfigurationSchema.and(
  z.object({
    id: z.string().min(1),
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).nullable(),
    workerId: z.string().min(1).max(255).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

export const mcpServerListSchema = z.array(mcpServerSummarySchema).max(200);

export const mcpServerWireSummarySchema = mcpServerOpaqueRuntimeSchema.and(
  z.object({
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).nullable(),
    workerId: z.string().min(1).max(255).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

export const mcpServerWireListSchema = z
  .array(mcpServerWireSummarySchema)
  .max(200);

export const mcpServerCopySchema = z.object({
  sourceProjectId: z.string().min(1),
  sourceServerId: z.string().min(1),
});

export const mobileProjectTabConfigurationsSchema = z
  .record(
    z.string().min(1).max(200),
    z.array(z.string().min(1).max(200).nullable()).min(1).max(20),
  )
  .refine((configurations) => Object.keys(configurations).length <= 200, {
    message: "Mobile tab configurations cannot contain more than 200 projects.",
  });

export const DEFAULT_PERMISSION_PROFILE_ID = ":workspace" as const;
export const configurablePermissionProfileIdSchema = z.enum([
  ":read-only",
  ":workspace",
  ":danger-full-access",
  ":yolo",
]);

export const eliteGlitchVariantSchema = z.enum([
  "outline",
  "full-frame",
  "left-frame",
  "right-frame",
  "chromatic",
  "spatial-shift",
  "scanline",
  "text-jitter",
]);

export type EliteGlitchVariant = z.infer<typeof eliteGlitchVariantSchema>;

export const MAX_ELITE_GLITCH_COUNT = 32;

const eliteGlitchVariantWeightSchema = z.number().min(0).max(10);

export const eliteGlitchVariantWeightsSchema = z.object({
  outline: eliteGlitchVariantWeightSchema,
  "full-frame": eliteGlitchVariantWeightSchema,
  "left-frame": eliteGlitchVariantWeightSchema,
  "right-frame": eliteGlitchVariantWeightSchema,
  chromatic: eliteGlitchVariantWeightSchema,
  "spatial-shift": eliteGlitchVariantWeightSchema,
  scanline: eliteGlitchVariantWeightSchema,
  "text-jitter": eliteGlitchVariantWeightSchema,
});

export type EliteGlitchVariantWeights = z.infer<
  typeof eliteGlitchVariantWeightsSchema
>;

export const DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS: EliteGlitchVariantWeights = {
  outline: 1,
  "full-frame": 0.01,
  "left-frame": 0.01,
  "right-frame": 0.01,
  chromatic: 0.25,
  "spatial-shift": 1,
  scanline: 0.33,
  "text-jitter": 1,
};

export const eliteRevealConfigSchema = z
  .object({
    glitchTerminalContents: z.boolean().default(false),
    glitchCountMax: z.number().int().min(1).max(MAX_ELITE_GLITCH_COUNT),
    glitchCountMin: z.number().int().min(1).max(MAX_ELITE_GLITCH_COUNT),
    glitchShowMs: z.number().int().min(5).max(120),
    staggerSpreadMs: z.number().int().min(0).max(250),
    variants: z.array(eliteGlitchVariantSchema).max(8),
    variantWeights: eliteGlitchVariantWeightsSchema.default(
      DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS,
    ),
  })
  .refine(
    ({ glitchCountMax, glitchCountMin }) => glitchCountMax >= glitchCountMin,
    {
      message:
        "Maximum glitches must be greater than or equal to minimum glitches.",
      path: ["glitchCountMax"],
    },
  );

export type EliteRevealConfig = z.infer<typeof eliteRevealConfigSchema>;

export const DEFAULT_ELITE_REVEAL_CONFIG: EliteRevealConfig = {
  glitchTerminalContents: false,
  glitchCountMax: 8,
  glitchCountMin: 4,
  glitchShowMs: 16,
  staggerSpreadMs: 50,
  variants: [...eliteGlitchVariantSchema.options],
  variantWeights: { ...DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS },
};

export const userSettingsSchema = z.object({
  theme: themePreferenceSchema,
  highContrast: z.boolean(),
  proMode: z.boolean(),
  proModeOpacity: z.number().int().min(0).max(100),
  eliteMode: z.boolean().default(true),
  eliteRevealConfig: eliteRevealConfigSchema.default(
    DEFAULT_ELITE_REVEAL_CONFIG,
  ),
  sidebarWidth: sidebarWidthPreferenceSchema,
  desktopFrameRate: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  desktopStreamQuality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
  defaultModelId: z.string().min(1).nullable(),
  defaultReasoningEffort: reasoningEffortSchema.nullable().default(null),
  defaultCustomSubagentModel: z.boolean().default(false),
  defaultSubagentModelId: z.string().min(1).nullable().default(null),
  defaultSubagentReasoningEffort: reasoningEffortSchema
    .nullable()
    .default(null),
  defaultPermissionProfileId: configurablePermissionProfileIdSchema.default(
    DEFAULT_PERMISSION_PROFILE_ID,
  ),
  defaultWorkerId: z.string().min(1).nullable().default(null),
  automaticReplicaProvisioning: z.boolean().default(false),
  automaticReplicaSynchronization: z
    .enum(["off", "verify-only", "fast-forward-primary"])
    .default("off"),
  mobileProjectTabConfigurations: mobileProjectTabConfigurationsSchema.default(
    {},
  ),
});

export const userSettingsUpdateSchema = userSettingsSchema.partial().extend({
  eliteMode: z.boolean().optional(),
  eliteRevealConfig: eliteRevealConfigSchema.optional(),
  defaultReasoningEffort: reasoningEffortSchema.nullable().optional(),
  defaultCustomSubagentModel: z.boolean().optional(),
  defaultSubagentModelId: z.string().min(1).nullable().optional(),
  defaultSubagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
  defaultPermissionProfileId: configurablePermissionProfileIdSchema.optional(),
  defaultWorkerId: z.string().min(1).nullable().optional(),
  automaticReplicaProvisioning: z.boolean().optional(),
  automaticReplicaSynchronization: z
    .enum(["off", "verify-only", "fast-forward-primary"])
    .optional(),
  mobileProjectTabConfigurations:
    mobileProjectTabConfigurationsSchema.optional(),
});

export const settingsBundleSchema = z.object({
  preferences: userSettingsSchema,
  providers: modelProviderListSchema,
  models: modelProfileListSchema,
});

export const settingsBundleWireSchema = settingsBundleSchema
  .omit({ providers: true })
  .extend({ providers: modelProviderWireListSchema })
  .strict();

export const githubAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  login: z.string().min(1).nullable(),
  source: z.enum(["gh-cli", "token", "none"]),
});

export const githubRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  url: z.url(),
  defaultBranch: z.string().min(1),
  updatedAt: z.string().datetime(),
  imported: z.boolean().default(false),
});

export const githubRepositoryListSchema = z.array(githubRepositorySchema);

const githubRepositorySegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== "..", {
    message: "Repository names cannot be dot path segments.",
  });

export const githubRepositoryOwnerSchema = z.object({
  login: githubRepositorySegmentSchema,
  kind: z.enum(["user", "organization"]),
});

export const githubRepositoryOwnerListSchema = z.array(
  githubRepositoryOwnerSchema,
);

export const githubRepositoryVisibilitySchema = z.enum(["public", "private"]);

export const githubRepositoryCreateSchema = z.object({
  owner: githubRepositorySegmentSchema,
  name: githubRepositorySegmentSchema,
  description: z.string().trim().max(350),
  visibility: githubRepositoryVisibilitySchema,
  initialize: z.enum(["readme", "empty"]).default("readme"),
});

export const githubIssueStateSchema = z.enum(["open", "closed"]);
export const githubIssueKindSchema = z.enum(["issue", "pull-request"]);

export const githubIssueLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
});

export const githubIssueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: githubIssueStateSchema,
  url: z.url(),
  author: z.string().min(1),
  commentCount: z.number().int().nonnegative(),
  labels: z.array(githubIssueLabelSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const githubIssueListSchema = z.object({
  kind: githubIssueKindSchema.default("issue"),
  state: githubIssueStateSchema,
  total: z.number().int().nonnegative(),
  issues: z.array(githubIssueSummarySchema),
  nextPage: z.number().int().positive().nullable().default(null),
});

export const githubIssueCommentSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
  url: z.url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const githubIssueDetailSchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  comments: z.array(githubIssueCommentSchema),
});

export const githubIssueCreateSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(1_000_000).default(""),
});

export const githubIssueCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(65_536),
});

export const githubIssueCloseSchema = z.object({
  comment: z.string().trim().min(1).max(65_536).nullable().default(null),
});

export const githubPullRequestCreateSchema = z
  .object({
    base: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Base branch cannot contain control characters.",
      }),
    head: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Head branch cannot contain control characters.",
      }),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(1_000_000).default(""),
    draft: z.boolean().default(false),
    labels: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    reviewers: z
      .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u))
      .max(100)
      .default([]),
    linkedIssueNumbers: z
      .array(z.number().int().positive())
      .max(100)
      .default([]),
  })
  .superRefine((request, context) => {
    if (request.base === request.head) {
      context.addIssue({
        code: "custom",
        path: ["head"],
        message: "Pull request head and base branches must differ.",
      });
    }
  });

export const githubPullRequestSummarySchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
});

export const githubPullRequestListSchema = z.object({
  state: githubIssueStateSchema,
  total: z.number().int().nonnegative(),
  pullRequests: z.array(githubPullRequestSummarySchema),
  nextPage: z.number().int().positive().nullable().default(null),
});

export const githubPullRequestCreateResultSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
});

export const githubPullRequestCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  shortSha: z.string().regex(/^[0-9a-f]{7,12}$/u),
  message: z.string().max(1_000_000),
  author: z.string().min(1).max(1_000),
  authoredAt: z.string().datetime().nullable(),
  url: z.url(),
});

export const githubPullRequestFileSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  path: z.string().min(1).max(8_192),
  previousPath: z.string().min(1).max(8_192).nullable(),
  status: z.string().min(1).max(64),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  blobUrl: z.url(),
  rawUrl: z.url().nullable(),
  patch: z.string().max(1_000_000).nullable(),
  patchTruncated: z.boolean(),
});

export const githubPullRequestCheckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(1_000),
  source: z.enum(["check-run", "commit-status"]),
  status: z.enum(["queued", "in-progress", "completed"]),
  conclusion: z.string().min(1).max(100).nullable(),
  url: z.url().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().max(100_000).nullable(),
});

export const githubPullRequestReviewSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  state: z.enum([
    "approved",
    "changes-requested",
    "commented",
    "dismissed",
    "pending",
  ]),
  body: z.string().max(1_000_000),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  submittedAt: z.string().datetime().nullable(),
  url: z.url().nullable(),
});

export const githubPullRequestReviewCommentSchema = z.object({
  id: z.number().int().positive(),
  reviewId: z.number().int().positive().nullable(),
  author: z.string().min(1),
  body: z.string().max(1_000_000),
  url: z.url(),
  path: z.string().min(1).max(8_192),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  startLine: z.number().int().positive().nullable(),
  startSide: z.enum(["LEFT", "RIGHT"]).nullable(),
  diffHunk: z.string().max(100_000),
  inReplyToId: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const githubPullRequestReviewThreadSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).max(8_192),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  resolved: z.boolean().nullable(),
  comments: z.array(githubPullRequestReviewCommentSchema).min(1).max(100),
});

const githubPullRequestReviewPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === ""),
    { message: "Review path must be a repository-relative file path." },
  );

export const githubPullRequestReviewSubmitSchema = z
  .object({
    event: z.enum(["approve", "request-changes"]),
    body: z.string().trim().max(65_536).default(""),
  })
  .superRefine((request, context) => {
    if (request.event === "request-changes" && !request.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Requesting changes requires an explanation.",
      });
    }
  });

export const githubPullRequestInlineCommentCreateSchema = z
  .object({
    body: z.string().trim().min(1).max(65_536),
    path: githubPullRequestReviewPathSchema,
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]),
    startLine: z.number().int().positive().nullable().default(null),
    startSide: z.enum(["LEFT", "RIGHT"]).nullable().default(null),
  })
  .superRefine((request, context) => {
    if ((request.startLine === null) !== (request.startSide === null)) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "A multi-line comment requires both start line and side.",
      });
    }
    if (request.startLine !== null && request.startLine > request.line) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "Review start line cannot be after the end line.",
      });
    }
  });

export const githubPullRequestReviewActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("comment"),
      body: githubIssueCommentCreateSchema.shape.body,
    }),
    z.object({
      type: z.literal("submit-review"),
      review: githubPullRequestReviewSubmitSchema,
    }),
    z.object({
      type: z.literal("inline-comment"),
      comment: githubPullRequestInlineCommentCreateSchema,
    }),
    z.object({
      type: z.literal("reply"),
      commentId: z.number().int().positive(),
      body: githubIssueCommentCreateSchema.shape.body,
    }),
  ],
);

export const githubPullRequestLifecycleActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("close") }),
    z.object({ type: z.literal("reopen") }),
    z.object({ type: z.literal("mark-ready") }),
    z.object({
      type: z.literal("merge"),
      method: z.enum(["merge", "squash", "rebase"]),
      commitTitle: z.string().trim().min(1).max(256).nullable().default(null),
      commitMessage: z
        .string()
        .trim()
        .min(1)
        .max(1_000_000)
        .nullable()
        .default(null),
    }),
  ],
);

export const githubPullRequestLifecyclePreviewSchema = z.object({
  action: githubPullRequestLifecycleActionSchema,
  number: z.number().int().positive(),
  title: z.string().min(1).max(10_000),
  state: githubIssueStateSchema,
  draft: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().min(1).max(100),
  checksState: z.enum(["success", "failure", "pending", "neutral", "none"]),
  reviewDecision: z.enum([
    "approved",
    "changes-requested",
    "review-required",
    "reviewed",
    "none",
  ]),
  destructive: z.boolean(),
  confirmationPhrase: z.string().min(1).max(100).nullable(),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const githubPullRequestLifecycleApplySchema = z.object({
  action: githubPullRequestLifecycleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.string().max(100).default(""),
});

export const githubPullRequestCheckoutPreparedSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  branch: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(200),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  remote: z.string().trim().min(1).max(255),
});

export const githubPullRequestDetailSchema =
  githubPullRequestSummarySchema.extend({
    comments: z.array(githubIssueCommentSchema).max(100),
    commentsTruncated: z.boolean(),
    requestedReviewers: z.array(z.string().min(1)).max(100),
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().min(1).max(100),
    reviewDecision: z.enum([
      "approved",
      "changes-requested",
      "review-required",
      "reviewed",
      "none",
    ]),
    checksState: z.enum(["success", "failure", "pending", "neutral", "none"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    commitCount: z.number().int().nonnegative(),
    commits: z.array(githubPullRequestCommitSchema).max(100),
    commitsTruncated: z.boolean(),
    files: z.array(githubPullRequestFileSchema).max(100),
    filesTruncated: z.boolean(),
    checks: z.array(githubPullRequestCheckSchema).max(200),
    checksTruncated: z.boolean(),
    reviews: z.array(githubPullRequestReviewSchema).max(100),
    reviewsTruncated: z.boolean(),
    reviewThreads: z.array(githubPullRequestReviewThreadSchema).max(100),
    reviewThreadsTruncated: z.boolean(),
  });

export const githubReleaseSummarySchema = z.object({
  id: z.number().int().positive(),
  tagName: z.string().min(1).max(1_000),
  name: z.string().min(1).max(10_000),
  body: z.string().max(1_000_000),
  url: z.url(),
  author: z.string().min(1),
  draft: z.boolean(),
  prerelease: z.boolean(),
  createdAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});

export const githubReleaseListSchema = z.object({
  releases: z.array(githubReleaseSummarySchema).max(100),
  truncated: z.boolean(),
});

export const githubReleaseCreateSchema = z.object({
  tagName: z.string().trim().min(1).max(1_000),
  name: z.string().trim().min(1).max(10_000),
  body: z.string().max(1_000_000),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export const projectGithubConversionRepositorySchema = z.object({
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: githubRepositorySchema.shape.url,
});

export const projectGithubRoutingRepositorySchema = z.object({
  repositoryId: repositoryRoutingHandleSchema,
  nameWithOwner: repositoryRoutingHandleSchema,
  url: repositoryRoutingHandleSchema,
});

export const projectGithubWireRepositorySchema = z.union([
  projectGithubConversionRepositorySchema,
  projectGithubRoutingRepositorySchema,
]);

export const projectReplicaPlacementModeSchema = z.enum([
  "managed",
  "managed-link",
  "direct",
]);

const projectReplicaManagedPlacementSchema = z
  .object({ mode: z.literal("managed") })
  .strict();

const projectReplicaManagedLinkPlacementSchema = z
  .object({
    mode: z.literal("managed-link"),
    path: z.string().trim().min(1).max(8_192),
  })
  .strict();

const projectReplicaDirectPlacementSchema = z
  .object({
    mode: z.literal("direct"),
    path: z.string().trim().min(1).max(8_192),
  })
  .strict();

export const projectReplicaPlacementRequestSchema = z.discriminatedUnion(
  "mode",
  [
    projectReplicaManagedPlacementSchema,
    projectReplicaManagedLinkPlacementSchema,
    projectReplicaDirectPlacementSchema,
  ],
);

export const encryptedProjectReplicaPlacementRequestSchema =
  z.discriminatedUnion("mode", [
    projectReplicaManagedPlacementSchema,
    z
      .object({
        mode: z.literal("managed-link"),
        path: repositoryRoutingHandleSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("direct"),
        path: repositoryRoutingHandleSchema,
      })
      .strict(),
  ]);

export const projectReplicaMaterializationSchema = z.enum([
  "cloned",
  "reused",
  "attached",
]);

export const projectReplicaOwnershipKindSchema = z.enum(["cantrip", "user"]);

export const projectReplicaPlacementResultSchema = z
  .object({
    mode: projectReplicaPlacementModeSchema,
    materialization: projectReplicaMaterializationSchema,
    ownership: projectReplicaOwnershipKindSchema,
    canonicalPath: z.string().min(1).max(8_192),
    requestedPath: z.string().min(1).max(8_192).nullable(),
    linkPath: z.string().min(1).max(8_192).nullable(),
  })
  .strict();

export const githubProjectCreateSchema = z.object({
  workerId: z.string().min(1),
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: z.url(),
  placement: projectReplicaPlacementRequestSchema.optional(),
  workspaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});

export const encryptedGithubProjectCreateSchema = githubProjectCreateSchema
  .omit({ repositoryId: true, nameWithOwner: true, placement: true, url: true })
  .extend({
    id: z.string().uuid(),
    nameProtection: privateDisplayLabelOpaqueSchema,
    repositoryBlindIndex: encryptionKeyBytesSchema,
    repositoryId: repositoryRoutingHandleSchema,
    nameWithOwner: repositoryRoutingHandleSchema,
    placement: encryptedProjectReplicaPlacementRequestSchema.optional(),
    url: repositoryRoutingHandleSchema,
  })
  .strict();

export const managedFolderProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workerId: z.string().min(1),
  existingPath: z.string().trim().min(1).max(8_192).optional(),
  workspaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});

export const encryptedManagedFolderProjectCreateSchema =
  managedFolderProjectCreateSchema
    .omit({ name: true, existingPath: true })
    .extend({
      id: z.string().uuid(),
      nameProtection: privateDisplayLabelOpaqueSchema,
      existingPath: repositoryRoutingHandleSchema.optional(),
    })
    .strict();

export const projectWorkspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const projectWorkspaceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    projectIds: z.array(z.string().min(1)).max(10_000).optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.projectIds !== undefined ||
      input.isDefault !== undefined,
    { message: "At least one workspace field is required." },
  );

const projectWorkspaceWireBaseSchema = z
  .object({
    id: z.string().min(1).max(255),
    position: z.number().int().nonnegative(),
    isDefault: z.boolean(),
    projectIds: z.array(z.string().min(1)),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const encryptedProjectWorkspaceNameSchema = z
  .object({
    state: z.literal("encrypted"),
    formatVersion: z.literal(1),
    keyRevision: z.number().int().positive(),
    blindIndex: encryptionKeyBytesSchema,
    envelope: encryptedPayloadEnvelopeSchema.refine(
      (envelope) => envelope.ciphertext.length <= 448,
      "Encrypted workspace name is too large.",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.envelope.keyRevision !== value.keyRevision) {
      context.addIssue({
        code: "custom",
        message: "Workspace name and envelope key revisions must match.",
        path: ["envelope", "keyRevision"],
      });
    }
  });

export const systemDefaultProjectWorkspaceNameSchema = z
  .object({
    state: z.literal("system-default"),
  })
  .strict();

export const projectWorkspaceWireSummarySchema =
  projectWorkspaceWireBaseSchema.extend({
    nameProtection: z.discriminatedUnion("state", [
      encryptedProjectWorkspaceNameSchema,
      systemDefaultProjectWorkspaceNameSchema,
    ]),
  });

export const projectWorkspaceWireListSchema = z
  .object({
    workspaces: z.array(projectWorkspaceWireSummarySchema),
  })
  .strict();

export const encryptedProjectWorkspaceCreateSchema = z
  .object({
    id: z.string().uuid(),
    nameProtection: encryptedProjectWorkspaceNameSchema,
  })
  .strict();

export const encryptedProjectWorkspaceUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    nameProtection: encryptedProjectWorkspaceNameSchema.optional(),
    projectIds: z.array(z.string().min(1)).max(10_000).optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.nameProtection !== undefined ||
      input.projectIds !== undefined ||
      input.isDefault !== undefined,
    { message: "At least one workspace field is required." },
  );

export const projectWorkspaceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  projectIds: z.array(z.string().min(1)),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorkspaceListSchema = z.array(
  projectWorkspaceSummarySchema,
);

export const projectOriginKindSchema = z.enum(["github", "managed-folder"]);
export const projectFolderManagementSchema = z.enum(["managed", "external"]);
export const projectSourceKindSchema = z.enum(["git", "folder"]);
export const projectRootKindSchema = z.enum(["git-worktree", "folder-root"]);

export const projectCapabilitiesSchema = z
  .object({
    git: z.boolean(),
    github: z.boolean(),
    worktrees: z.boolean(),
    replicas: z.boolean(),
    relocation: z.boolean(),
  })
  .strict();

export const projectCapabilitySchema = projectCapabilitiesSchema.keyof();

export const projectCapabilityUnavailableErrorSchema = z
  .object({
    code: z.literal("project-capability-unavailable"),
    capability: projectCapabilitySchema,
    error: z.string().min(1).max(1_000),
  })
  .strict();

export function projectCapabilitiesForOriginKind(
  originKind: z.infer<typeof projectOriginKindSchema>,
): z.infer<typeof projectCapabilitiesSchema> {
  const available = originKind === "github";
  return {
    git: available,
    github: available,
    worktrees: available,
    replicas: available,
    relocation: available,
  };
}

export const projectSourceSummarySchema = z.object({
  id: z.string().min(1),
  sourceKind: projectSourceKindSchema.default("git"),
  workerId: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  ownershipKind: projectReplicaOwnershipKindSchema.default("cantrip"),
  requestedPath: z.string().min(1).nullable().default(null),
  linkPath: z.string().min(1).nullable().default(null),
});

export const projectReplicaSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceKind: projectSourceKindSchema.default("git"),
  workerId: z.string().min(1),
  workerName: z.string().min(1),
  workerOnline: z.boolean(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  ownershipKind: projectReplicaOwnershipKindSchema.default("cantrip"),
  requestedPath: z.string().min(1).nullable().default(null),
  linkPath: z.string().min(1).nullable().default(null),
  repositoryFingerprint: z.string().min(1).nullable(),
  primaryWorktreeId: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  dirty: z.boolean().nullable(),
  ready: z.boolean(),
  worktreeCount: z.number().int().nonnegative(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectReplicaListSchema = z
  .array(projectReplicaSummarySchema)
  .max(1_000);

export const projectReplicaJobKindSchema = z.enum([
  "provision",
  "synchronize",
  "remove",
]);

export const projectReplicaJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const projectReplicaJobErrorCodeSchema = z.enum([
  "target-not-found",
  "target-mismatch",
  "worker-offline",
  "capability-missing",
  "replica-not-ready",
  "worktree-dirty",
  "revision-diverged",
  "lease-conflict",
  "attachment-unavailable",
  "runtime-incompatible",
  "stale-attempt",
  "policy-denied",
  "remote-unavailable",
  "windows-long-paths-disabled",
  "placement-unsupported",
  "path-invalid",
  "path-permission-denied",
  "parent-creation-failed",
  "target-type-mismatch",
  "target-repository-mismatch",
  "target-not-primary-worktree",
  "target-owned-by-another-project",
  "target-revision-mismatch",
  "link-unsupported",
  "link-target-mismatch",
  "ownership-proof-missing",
  "replica-in-use",
  "unpushed-commits",
  "worker-error",
]);

export const projectReplicaJobErrorSchema = z.object({
  code: projectReplicaJobErrorCodeSchema,
  retryable: z.boolean(),
});

export const projectReplicaJobProgressStageSchema = z.enum([
  "queued",
  "dispatching",
  "validating",
  "validating-placement",
  "inspecting-existing-checkout",
  "fetching",
  "inspecting",
  "materializing",
  "resolving-revision",
  "verifying",
  "fast-forwarding",
  "removing",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

export const projectReplicaJobProgressSchema = z.object({
  stage: projectReplicaJobProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const projectReplicaJobProgressEventSchema =
  projectReplicaJobProgressSchema.omit({ updatedAt: true });

const gitObjectRevisionSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{40,64}$/u);

export const projectReplicaJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  projectReplicaId: z.string().min(1).nullable(),
  workerId: z.string().min(1),
  kind: projectReplicaJobKindSchema,
  state: projectReplicaJobStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  repository: z.string().min(1),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  placementPath: z.string().min(1).nullable().default(null),
  resolvedMaterialization: projectReplicaMaterializationSchema
    .nullable()
    .default(null),
  resolvedOwnership: projectReplicaOwnershipKindSchema.nullable().default(null),
  expectedRevision: gitObjectRevisionSchema.nullable(),
  resolvedRevision: gitObjectRevisionSchema.nullable(),
  synchronizationPolicy: z
    .enum(["verify-only", "fast-forward-primary"])
    .nullable()
    .default(null),
  deleteLocalFiles: z.boolean().nullable().default(null),
  attempt: z.number().int().nonnegative(),
  progress: projectReplicaJobProgressSchema,
  error: projectReplicaJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancellationUnsafeAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectReplicaJobListSchema = z
  .array(projectReplicaJobSummarySchema)
  .max(1_000);

export const projectReplicaProvisionCreateSchema = z.object({
  workerId: z.string().min(1),
  placement: projectReplicaPlacementRequestSchema.optional(),
  expectedRevision: gitObjectRevisionSchema.nullable().default(null),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaProvisionCreateSchema =
  projectReplicaProvisionCreateSchema
    .omit({ placement: true })
    .extend({
      placement: encryptedProjectReplicaPlacementRequestSchema.optional(),
      repository: repositoryRoutingHandleSchema,
    })
    .strict();

export const projectReplicaSynchronizationPolicySchema = z.enum([
  "verify-only",
  "fast-forward-primary",
]);

export const projectReplicaSynchronizeCreateSchema = z.object({
  expectedRevision: gitObjectRevisionSchema,
  policy: projectReplicaSynchronizationPolicySchema.default("verify-only"),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaSynchronizeCreateSchema =
  projectReplicaSynchronizeCreateSchema
    .extend({ repository: repositoryRoutingHandleSchema })
    .strict();

export const projectReplicaRemoveCreateSchema = z.object({
  deleteLocalFiles: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaRemoveCreateSchema =
  projectReplicaRemoveCreateSchema
    .extend({ repository: repositoryRoutingHandleSchema })
    .strict();

export const projectReplicaJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectReplicaJobCancelSchema = z.object({
  stateRevision: z.number().int().positive(),
});

const executionResourceIdSchema = z.string().min(1).max(200);

export const executionSurfaceKindSchema = z.enum([
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "remote-desktop",
  "remote-surface",
]);

export const executionPlacementSchema = z
  .object({
    projectId: executionResourceIdSchema,
    workerId: executionResourceIdSchema,
    projectReplicaId: executionResourceIdSchema.nullable(),
    worktreeId: executionResourceIdSchema.nullable(),
    surface: z
      .object({
        kind: executionSurfaceKindSchema,
        id: executionResourceIdSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((placement, context) => {
    if (placement.worktreeId !== null && placement.projectReplicaId === null) {
      context.addIssue({
        code: "custom",
        message: "A worktree placement requires a project replica.",
        path: ["projectReplicaId"],
      });
    }
  });

export const executionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker"),
      projectId: executionResourceIdSchema,
      workerId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replica"),
      projectId: executionResourceIdSchema,
      projectReplicaId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worktree"),
      projectId: executionResourceIdSchema,
      worktreeId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface"),
      projectId: executionResourceIdSchema,
      surfaceKind: executionSurfaceKindSchema,
      surfaceId: executionResourceIdSchema,
    })
    .strict(),
]);

export const executionPlacementSelectionSchema = z.enum([
  "explicit",
  "project-preference",
  "default-worker",
  "fallback",
]);

export const executionPlacementResolveRequestSchema = z
  .object({
    surfaceKind: executionSurfaceKindSchema,
    target: executionTargetSchema.optional(),
  })
  .strict();

export const executionPlacementResolutionSchema = z.object({
  placement: executionPlacementSchema,
  selection: executionPlacementSelectionSchema,
});

export const executionTargetResourceKindSchema = z.enum([
  "project",
  "worker",
  "replica",
  "worktree",
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "remote-desktop",
  "remote-surface",
]);

export const executionTargetAvailabilitySchema = z.enum([
  "available",
  "worker-offline",
  "capability-unavailable",
  "resource-unavailable",
]);

const executionTargetWorkerSchema = z.object({
  workerId: executionResourceIdSchema,
  name: z.string().min(1).max(200),
  online: z.boolean(),
});

export const executionTargetResolutionSchema = z
  .object({
    target: executionTargetSchema,
    placement: executionPlacementSchema,
    worker: executionTargetWorkerSchema,
    availability: executionTargetAvailabilitySchema,
    unavailableReason: z.string().min(1).max(4_000).nullable(),
  })
  .strict();

export const executionTargetResolveRequestSchema = z
  .object({
    target: executionTargetSchema,
    allowUnavailable: z.boolean().default(false),
  })
  .strict();

const executionTargetDescriptorBaseSchema = executionTargetResolutionSchema
  .extend({
    resourceKind: executionTargetResourceKindSchema,
    status: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const executionTargetDescriptorSchema =
  executionTargetDescriptorBaseSchema.extend({
    title: z.string().min(1).max(500),
  });

export const executionTargetWireDescriptorSchema =
  executionTargetDescriptorBaseSchema
    .extend({
      title: z.string().min(1).max(500).nullable(),
      titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    })
    .superRefine((descriptor, context) => {
      const expectedRecordKind =
        descriptor.resourceKind === "chat"
          ? "chat"
          : descriptor.resourceKind === "terminal"
            ? "terminal"
            : descriptor.resourceKind === "explorer"
              ? "explorer"
              : descriptor.resourceKind === "code"
                ? "code-tab"
                : descriptor.resourceKind === "browser"
                  ? "browser"
                  : descriptor.resourceKind === "remote-desktop"
                    ? "project-view"
                    : descriptor.resourceKind === "remote-surface"
                      ? "remote-surface"
                      : null;
      const protectedResource = expectedRecordKind !== null;
      if (
        protectedResource !== (descriptor.titleProtection !== null) ||
        protectedResource === (descriptor.title !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface execution targets require an opaque title; placement targets require a plaintext title.",
          path: ["titleProtection"],
        });
      }
      if (
        descriptor.titleProtection &&
        descriptor.titleProtection.classification.recordKind !==
          expectedRecordKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target title classification must match its resource kind.",
          path: ["titleProtection", "classification", "recordKind"],
        });
      }
      if (protectedResource && descriptor.target.kind !== "surface") {
        context.addIssue({
          code: "custom",
          message: "Protected execution targets must identify a surface.",
          path: ["target"],
        });
      }
      if (
        protectedResource &&
        descriptor.target.kind === "surface" &&
        descriptor.target.surfaceKind !== descriptor.resourceKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target resource and surface kinds must describe the same surface.",
          path: ["target", "surfaceKind"],
        });
      }
      if (
        protectedResource &&
        descriptor.placement.surface?.kind !== descriptor.resourceKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target placement must point at the protected surface.",
          path: ["placement", "surface"],
        });
      }
    });

export const executionTargetCatalogSchema = z
  .object({
    projectId: executionResourceIdSchema,
    targets: z.array(executionTargetDescriptorSchema).max(2_000),
    truncated: z.boolean(),
  })
  .strict();

export const executionTargetWireCatalogSchema = z
  .object({
    projectId: executionResourceIdSchema,
    targets: z.array(executionTargetWireDescriptorSchema).max(2_000),
    truncated: z.boolean(),
  })
  .strict();

export const worktreePolicySchema = z.enum([
  "direct",
  "agent-managed",
  "required-for-writes",
]);
export const worktreeOriginSchema = z.enum([
  "cantrip",
  "agent",
  "user",
  "external",
]);
export const worktreeLifecycleStateSchema = z.enum([
  "creating",
  "preparing",
  "ready",
  "setup-failed",
  "setup-stale",
  "missing",
  "prunable",
  "removing",
]);

export const projectWorktreeSummarySchema = z.object({
  id: z.string().min(1),
  projectSourceId: z.string().min(1),
  projectId: z.string().min(1),
  rootKind: projectRootKindSchema.default("git-worktree"),
  workerId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  isPrimary: z.boolean(),
  isDefault: z.boolean(),
  origin: worktreeOriginSchema,
  lifecycleState: worktreeLifecycleStateSchema,
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  detached: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  lastScannedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorktreeListSchema = z.array(projectWorktreeSummarySchema);

export const githubPullRequestCheckoutResultSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  worktree: projectWorktreeSummarySchema,
  reused: z.boolean(),
});

export const projectSetupStatusSchema = z.enum([
  "preparing",
  "cloning",
  "ready",
  "failed",
]);

const projectSummaryBaseSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().nonnegative(),
  originKind: projectOriginKindSchema.default("github"),
  folderManagement: projectFolderManagementSchema.nullable().optional(),
  capabilities: projectCapabilitiesSchema.default(
    projectCapabilitiesForOriginKind("github"),
  ),
  setupStatus: projectSetupStatusSchema,
  setupError: z.string().min(1).nullable(),
  worktreePolicy: worktreePolicySchema,
  preferredWorkerId: z.string().min(1).nullable().optional(),
  source: projectSourceSummarySchema.nullable(),
  replicas: projectReplicaListSchema.default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

function refineProjectSummary(
  project: z.infer<typeof projectSummaryBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    (project.originKind === "github" && project.folderManagement != null) ||
    (project.originKind === "managed-folder" &&
      project.folderManagement === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "folder management must match the project origin",
      path: ["folderManagement"],
    });
  }
  const expected = projectCapabilitiesForOriginKind(project.originKind);
  for (const capability of projectCapabilitySchema.options) {
    if (project.capabilities[capability] !== expected[capability]) {
      context.addIssue({
        code: "custom",
        message: `${capability} capability does not match ${project.originKind} origin`,
        path: ["capabilities", capability],
      });
    }
  }
}

export const projectSummarySchema = projectSummaryBaseSchema
  .extend({
    name: z.string().min(1).max(1_000),
    github: projectGithubConversionRepositorySchema.nullable(),
  })
  .strict()
  .superRefine(refineProjectSummary);

export const projectWireSummarySchema = projectSummaryBaseSchema
  .extend({
    nameProtection: privateDisplayLabelOpaqueSchema,
    github: projectGithubWireRepositorySchema.nullable(),
  })
  .strict()
  .superRefine((project, context) => {
    refineProjectSummary(project, context);
    if (project.nameProtection.classification.recordKind !== "project") {
      context.addIssue({
        code: "custom",
        message: "Project display-label classification must be project.",
        path: ["nameProtection", "classification", "recordKind"],
      });
    }
  });

export const projectListSchema = z.array(projectSummarySchema);
export const projectWireListSchema = z.array(projectWireSummarySchema);

export const projectPreferredWorkerUpdateSchema = z.object({
  workerId: z.string().min(1).nullable(),
});

const tunnelResourceIdSchema = z.string().trim().min(1).max(200);
const tunnelNameSchema = z.string().trim().min(1).max(120);
const tunnelDescriptionSchema = z.string().trim().max(1_000).nullable();

export const tunnelOriginSchema = z.enum([
  "user",
  "browser",
  "project-share",
  "code",
  "workflow",
  "system",
]);

export const tunnelManagementSchema = z.enum([
  "user-managed",
  "managed-durable",
  "managed-ephemeral",
]);

export const tunnelProtocolHintSchema = z.enum([
  "tcp",
  "http",
  "https",
  "http-websocket",
  "https-websocket",
  "webdav",
]);

export const tunnelDesiredStateSchema = z.enum(["stopped", "started"]);

export const tunnelStatusSchema = z.enum([
  "stopped",
  "starting",
  "active",
  "offline",
  "degraded",
  "stopping",
  "failed",
]);

export const tunnelWorkerHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);

export const tunnelSourceEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop-loopback") }).strict(),
  z
    .object({
      kind: z.literal("worker-listener"),
      workerId: tunnelResourceIdSchema,
      host: tunnelWorkerHostSchema,
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
]);

export const tunnelDestinationEndpointSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("worker-tcp"),
      workerId: tunnelResourceIdSchema,
      host: tunnelWorkerHostSchema,
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker-adapter"),
      workerId: tunnelResourceIdSchema,
      adapter: z.enum(["code", "project-share"]),
      resourceId: tunnelResourceIdSchema,
    })
    .strict(),
]);

export const tunnelManagedResourceSchema = z
  .object({
    kind: z.enum(["browser", "code", "project-share", "workflow", "system"]),
    id: tunnelResourceIdSchema,
  })
  .strict();

export const tunnelUserCreateSchema = z
  .object({
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema.default(null),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    protocolHint: tunnelProtocolHintSchema,
    destination: z
      .object({
        kind: z.literal("worker-tcp"),
        workerId: tunnelResourceIdSchema,
        host: tunnelWorkerHostSchema.default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
  })
  .strict();

export const tunnelUserUpdateSchema = z
  .object({
    name: tunnelNameSchema.optional(),
    description: tunnelDescriptionSchema.optional(),
    projectId: tunnelResourceIdSchema.nullable().optional(),
    protocolHint: tunnelProtocolHintSchema.optional(),
    destination: tunnelUserCreateSchema.shape.destination.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one tunnel field is required.",
  });

export const tunnelUserWireCreateSchema = z
  .object({
    id: z.string().uuid(),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    protocolHint: tunnelProtocolHintSchema,
    destination: tunnelPublicDestinationEndpointSchema.and(
      z.object({ kind: z.literal("worker-tcp") }).strict(),
    ),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(({ id, protectedRecord }) => id === protectedRecord.operationId, {
    message: "A new tunnel record must use its tunnel id as operation id.",
    path: ["protectedRecord", "operationId"],
  })
  .refine(({ protectedRecord }) => protectedRecord.revision === 1, {
    message: "A new tunnel record must begin at revision one.",
    path: ["protectedRecord", "revision"],
  });

export const tunnelUserWireUpdateSchema = z
  .object({
    projectId: tunnelResourceIdSchema.nullable().optional(),
    protocolHint: tunnelProtocolHintSchema.optional(),
    destination: tunnelPublicDestinationEndpointSchema
      .and(z.object({ kind: z.literal("worker-tcp") }).strict())
      .optional(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict();

export const tunnelManagedRegistrationSchema = z
  .object({
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema.default(null),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    origin: tunnelOriginSchema.exclude(["user"]),
    management: tunnelManagementSchema.exclude(["user-managed"]),
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelSourceEndpointSchema,
    destination: tunnelDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema,
    desiredState: tunnelDesiredStateSchema.default("started"),
    status: tunnelStatusSchema.default("starting"),
  })
  .strict()
  .superRefine((tunnel, context) => {
    if (tunnel.origin !== tunnel.managedBy.kind) {
      context.addIssue({
        code: "custom",
        message: "A managed tunnel origin must match its owning resource.",
        path: ["managedBy", "kind"],
      });
    }
    if (
      tunnel.destination.kind === "worker-adapter" &&
      (tunnel.origin !== tunnel.destination.adapter ||
        tunnel.destination.resourceId !== tunnel.managedBy.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker adapters must match the owning resource.",
        path: ["destination"],
      });
    }
  });

export const tunnelAttachmentKindSchema = z.enum(["desktop-loopback"]);

export const tunnelAttachmentSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    kind: tunnelAttachmentKindSchema,
    clientId: tunnelResourceIdSchema.nullable(),
    localHost: tunnelWorkerHostSchema.nullable(),
    localPort: z.number().int().min(1).max(65_535).nullable(),
    status: tunnelStatusSchema,
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    lastError: z.string().min(1).max(4_000).nullable(),
    expiresAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((attachment, context) => {
    const desktop = attachment.kind === "desktop-loopback";
    if (desktop !== (attachment.clientId !== null)) {
      context.addIssue({
        code: "custom",
        message: "Desktop attachments require a client identity.",
        path: ["clientId"],
      });
    }
    if (!desktop && attachment.localHost !== null) {
      context.addIssue({
        code: "custom",
        message: "Server relay attachments cannot expose a local host.",
        path: ["localHost"],
      });
    }
    if (!desktop && attachment.localPort !== null) {
      context.addIssue({
        code: "custom",
        message: "Server relay attachments cannot expose a local port.",
        path: ["localPort"],
      });
    }
    if ((attachment.localHost === null) !== (attachment.localPort === null)) {
      context.addIssue({
        code: "custom",
        message: "A local attachment host and port must be reported together.",
        path: ["localPort"],
      });
    }
  });

export const tunnelAttachmentWireSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    kind: tunnelAttachmentKindSchema,
    clientId: tunnelResourceIdSchema.nullable(),
    status: tunnelStatusSchema,
    errorCode: tunnelContentErrorCodeSchema.nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    expiresAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const tunnelAttachmentCreateSchema = z
  .object({
    clientId: tunnelResourceIdSchema,
  })
  .strict();

export const tunnelAttachmentCreateResultSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    secret: z.string().min(32).max(512),
    connectPath: z.string().startsWith("/api/tunnel-attachments/"),
    secretExpiresAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const tunnelDirectActivationSchema = z
  .object({
    capabilityId: z.string().uuid(),
  })
  .strict();

export const tunnelAttachmentInitializeSchema = z
  .object({
    type: z.literal("initialize"),
    clientId: tunnelResourceIdSchema,
    diagnosticTraceId: z.string().uuid().optional(),
  })
  .strict();

export const tunnelAttachmentReadySchema = z
  .object({
    type: z.literal("ready"),
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    sourceEndpointId: tunnelResourceIdSchema,
    destinationEndpointId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const tunnelActionCapabilitiesSchema = z
  .object({
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canStart: z.boolean(),
    canStop: z.boolean(),
    canAttach: z.boolean(),
    canOpenOwner: z.boolean(),
  })
  .strict();

export const tunnelSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema,
    projectId: tunnelResourceIdSchema.nullable(),
    position: z.number().int().nonnegative(),
    origin: tunnelOriginSchema,
    management: tunnelManagementSchema,
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelSourceEndpointSchema,
    destination: tunnelDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema.nullable(),
    desiredState: tunnelDesiredStateSchema,
    status: tunnelStatusSchema,
    lastError: z.string().min(1).max(4_000).nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    attachments: z.array(tunnelAttachmentSummarySchema).max(128),
    capabilities: tunnelActionCapabilitiesSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((tunnel, context) => {
    const userManaged = tunnel.management === "user-managed";
    if (userManaged !== (tunnel.origin === "user")) {
      context.addIssue({
        code: "custom",
        message: "Only user-origin tunnels may be user managed.",
        path: ["management"],
      });
    }
    if (userManaged !== (tunnel.managedBy === null)) {
      context.addIssue({
        code: "custom",
        message: "Managed tunnels require an owning resource.",
        path: ["managedBy"],
      });
    }
  });

export const tunnelListSchema = z.array(tunnelSummarySchema).max(10_000);

export const tunnelWireSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    projectId: tunnelResourceIdSchema.nullable(),
    position: z.number().int().nonnegative(),
    origin: tunnelOriginSchema,
    management: tunnelManagementSchema,
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelPublicSourceEndpointSchema,
    destination: tunnelPublicDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema.nullable(),
    desiredState: tunnelDesiredStateSchema,
    status: tunnelStatusSchema,
    errorCode: tunnelContentErrorCodeSchema.nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    attachments: z.array(tunnelAttachmentWireSummarySchema).max(128),
    capabilities: tunnelActionCapabilitiesSchema,
    protectedRecord: protectedTunnelContentRecordSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const tunnelWireListSchema = z
  .array(tunnelWireSummarySchema)
  .max(10_000);

export const projectGitRepositoryStatsSchema = z.object({
  kind: z.literal("git").default("git"),
  commitCount: z.number().int().nonnegative(),
  trackedFileCount: z.number().int().nonnegative(),
  trackedByteCount: z.number().int().nonnegative(),
  textFileCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  excludedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const projectFolderStatsSchema = z.object({
  kind: z.literal("folder"),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  textFileCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  excludedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const projectRepositoryStatsSchema = z.union([
  projectGitRepositoryStatsSchema,
  projectFolderStatsSchema,
]);

export const projectTokenUsageDaySchema = detailedTokenUsageTotalsSchema.extend(
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  },
);

export const projectTokenUsageBreakdownSchema =
  detailedTokenUsageTotalsSchema.extend({
    id: z.string().min(1).nullable(),
    name: z.string().min(1),
    agentTime: agentTimeSummarySchema,
  });

export const projectTokenUsageSchema = z.object({
  total: detailedTokenUsageTotalsSchema,
  agentTime: agentTimeSummarySchema,
  daily: z.array(projectTokenUsageDaySchema).max(366),
  providers: z.array(projectTokenUsageBreakdownSchema),
  models: z.array(projectTokenUsageBreakdownSchema),
  range: z.object({
    start: projectTokenUsageDaySchema.shape.date,
    end: projectTokenUsageDaySchema.shape.date,
  }),
});

export const telemetryValueStatisticsSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  mean: z.number().finite().nullable(),
  median: z.number().finite().nullable(),
  min: z.number().finite().nullable(),
  p10: z.number().finite().nullable(),
  p25: z.number().finite().nullable(),
  p75: z.number().finite().nullable(),
  p90: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
});

export const telemetryQuotaReadingSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  providerAccountId: z.string().min(1),
  providerAccountLabel: z.string().min(1),
  limitName: z.string().min(1),
  windowKind: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  remainingPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
});

export const telemetryQuotaReadingWireSchema = telemetryQuotaReadingSchema
  .omit({
    providerName: true,
    providerAccountLabel: true,
    limitName: true,
  })
  .extend({ limitId: z.string().nullable() })
  .strict();

export const telemetryBreakdownSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  sampleCount: z.number().int().nonnegative(),
  highConfidenceSamples: z.number().int().nonnegative(),
  unattributedSamples: z.number().int().nonnegative(),
  tokens: detailedTokenUsageTotalsSchema,
  effectiveTokensPer100Percent: telemetryValueStatisticsSchema,
});

export const telemetryBreakdownWireSchema = telemetryBreakdownSchema
  .omit({ label: true })
  .strict();

export const modelBehaviorSummarySchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  interruptedCount: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1).nullable(),
  finalAnswerRate: z.number().min(0).max(1).nullable(),
  toolCallCount: z.number().int().nonnegative(),
  invalidToolCallCount: z.number().int().nonnegative(),
  toolErrorRate: z.number().min(0).max(1).nullable(),
  retryFailoverCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  approvalRequestCount: z.number().int().nonnegative(),
  filesChangedCount: z.number().int().nonnegative(),
  testCommandCount: z.number().int().nonnegative(),
  testFailureCount: z.number().int().nonnegative(),
  immediateCorrectiveFollowupCount: z.number().int().nonnegative(),
  durationMs: telemetryValueStatisticsSchema,
  timeToFirstActivityMs: telemetryValueStatisticsSchema,
  timeToVisibleResponseMs: telemetryValueStatisticsSchema,
});

export const modelBehaviorBreakdownSchema = modelBehaviorSummarySchema.extend({
  key: z.string().min(1),
  label: z.string().min(1),
});

export const modelBehaviorDaySchema = modelBehaviorSummarySchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

export const telemetryChangeMetricSchema = z.enum([
  "tokens-per-percent",
  "effective-weekly-allowance",
  "failure-rate",
  "tool-error-rate",
  "latency",
  "compaction-frequency",
  "completion-rate",
  "output-reasoning-mix",
]);

export const telemetryChangePointSchema = z.object({
  id: z.string().min(1),
  metric: telemetryChangeMetricSchema,
  scope: z.enum(["account", "model", "account-model"]),
  providerAccountId: z.string().min(1).nullable(),
  providerAccountLabel: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  modelLabel: z.string().min(1).nullable(),
  detectedAt: z.string().datetime(),
  beforeStart: z.string().datetime(),
  beforeEnd: z.string().datetime(),
  afterStart: z.string().datetime(),
  afterEnd: z.string().datetime(),
  beforeValue: z.number().finite(),
  afterValue: z.number().finite(),
  relativeChangePercent: z.number().finite().nullable(),
  beforeSampleCount: z.number().int().positive(),
  afterSampleCount: z.number().int().positive(),
  confidence: z.enum(["high", "medium"]),
  direction: z.enum(["increased", "decreased"]),
  impact: z.enum(["improvement", "degradation", "neutral"]),
  unit: z.enum(["tokens", "ratio", "milliseconds"]),
});

export const telemetryChangePointWireSchema = telemetryChangePointSchema
  .omit({ providerAccountLabel: true, modelLabel: true })
  .strict();

export const providerTelemetryAnalyticsSchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      providerId: z.string().min(1),
      providerName: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
  currentQuota: z.array(telemetryQuotaReadingSchema),
  quotaHistory: z.array(telemetryQuotaReadingSchema),
  resetBoundaries: z.array(
    z.object({
      providerAccountId: z.string().min(1),
      resetsAt: z.string().datetime(),
      firstObservedAt: z.string().datetime(),
    }),
  ),
  tokens: z.object({
    total: detailedTokenUsageTotalsSchema,
    daily: z.array(projectTokenUsageDaySchema).max(366),
  }),
  estimates: z.object({
    sampleCount: z.number().int().nonnegative(),
    highConfidenceSamples: z.number().int().nonnegative(),
    unattributedSamples: z.number().int().nonnegative(),
    tokensPerPercent: telemetryValueStatisticsSchema,
    effectiveTokensPer100Percent: telemetryValueStatisticsSchema,
  }),
  comparisons: z.object({
    rolling7Days: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
    rolling30Days: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
    monthOverMonth: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
  }),
  breakdowns: z.object({
    accounts: z.array(telemetryBreakdownSchema),
    models: z.array(telemetryBreakdownSchema),
    reasoningEfforts: z.array(telemetryBreakdownSchema),
    months: z.array(telemetryBreakdownSchema),
  }),
  behavior: z.object({
    total: modelBehaviorSummarySchema,
    daily: z.array(modelBehaviorDaySchema).max(366),
    accounts: z.array(modelBehaviorBreakdownSchema),
    models: z.array(modelBehaviorBreakdownSchema),
    reasoningEfforts: z.array(modelBehaviorBreakdownSchema),
  }),
  changePoints: z.array(telemetryChangePointSchema).max(100),
});

export const providerTelemetryWireAnalyticsSchema =
  providerTelemetryAnalyticsSchema
    .omit({
      accounts: true,
      currentQuota: true,
      quotaHistory: true,
      breakdowns: true,
      behavior: true,
      changePoints: true,
    })
    .extend({
      accounts: z.array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
          })
          .strict(),
      ),
      currentQuota: z.array(telemetryQuotaReadingWireSchema),
      quotaHistory: z.array(telemetryQuotaReadingWireSchema),
      breakdowns: z.object({
        accounts: z.array(telemetryBreakdownWireSchema),
        models: z.array(telemetryBreakdownWireSchema),
        reasoningEfforts: z.array(telemetryBreakdownWireSchema),
        months: z.array(telemetryBreakdownWireSchema),
      }),
      behavior: z.object({
        total: modelBehaviorSummarySchema,
        daily: z.array(modelBehaviorDaySchema).max(366),
        accounts: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
        models: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
        reasoningEfforts: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
      }),
      changePoints: z.array(telemetryChangePointWireSchema).max(100),
    })
    .strict();

const telemetryExportQuotaObservationSchema = z.object({
  id: z.string().min(1),
  eventKey: z.string().min(1),
  observationBatchKey: z.string().min(1),
  providerAccountId: z.string().min(1),
  workerId: z.string().nullable(),
  observedAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  usedPercent: z.number().finite(),
  resetsAt: z.string().datetime().nullable(),
  windowDurationMinutes: z.number().int().nonnegative().nullable(),
  limitId: z.string().nullable(),
  windowKind: z.string().min(1),
  reachedType: z.string().nullable(),
  observationTrigger: z.string().min(1),
  chatId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
});

const telemetryExportTokenUsageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().nullable(),
  chatId: z.string().nullable(),
  sourceKey: z.string().min(1),
  modelId: z.string().nullable(),
  modelRouteId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().nullable(),
  attemptKind: z.string().min(1),
  attemptStatus: z.string().min(1),
  reasoningEffort: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  visibleOutputTokens: z.number().int().nonnegative().nullable(),
  reportedTotalTokens: z.number().int().nonnegative().nullable(),
  usageSemantics: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
});

const telemetryExportBehaviorSchema = z.object({
  id: z.string().min(1),
  sourceKey: z.string().min(1),
  projectId: z.string().nullable(),
  chatId: z.string().nullable(),
  modelId: z.string().nullable(),
  modelRouteId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().min(1),
  attemptStatus: z.string().min(1),
  reasoningEffort: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  finalAnswerAppeared: z.boolean(),
  toolCallCount: z.number().int().nonnegative(),
  invalidToolCallCount: z.number().int().nonnegative(),
  retryFailoverCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  approvalRequestCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  filesChangedCount: z.number().int().nonnegative(),
  testCommandCount: z.number().int().nonnegative(),
  testPassCount: z.number().int().nonnegative(),
  testFailureCount: z.number().int().nonnegative(),
  userInterrupted: z.boolean(),
  userRetryRegeneration: z.boolean().nullable(),
  immediateCorrectiveFollowup: z.boolean(),
  forkCount: z.number().int().nonnegative(),
  copyCount: z.number().int().nonnegative().nullable(),
  ratingValue: z.number().int().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
  signalAvailability: z.record(z.string(), z.unknown()),
});

const telemetryExportCatalogSnapshotSchema = z.object({
  id: z.string().min(1),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  availabilityScope: z.string().min(1),
  metadataSource: z.string().min(1),
  metadataHash: z.string().min(1),
  observedAt: z.string().datetime(),
});

export const providerTelemetryExportSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  provider: z.object({ id: z.string().min(1) }),
  privacy: z.object({
    includesMessageContent: z.literal(false),
    rawPayloadsStored: z.literal(false),
    dimensionLabels: z.literal("opaque-ids"),
    retention: z.literal("owner-controlled-indefinite"),
  }),
  quotaObservations: z.array(telemetryExportQuotaObservationSchema),
  tokenUsage: z.array(telemetryExportTokenUsageSchema),
  modelBehavior: z.array(telemetryExportBehaviorSchema),
  modelCatalogSnapshots: z.array(telemetryExportCatalogSnapshotSchema),
});

export const providerTelemetryDeleteResultSchema = z.object({
  providerId: z.string().min(1),
  deleted: z.object({
    quotaObservations: z.number().int().nonnegative(),
    tokenUsage: z.number().int().nonnegative(),
    modelBehavior: z.number().int().nonnegative(),
    modelCatalogSnapshots: z.number().int().nonnegative(),
  }),
});

const chatPlacementCreateFields = {
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).default("agent-managed"),
  tabGroupId: z.string().min(1).optional(),
  target: executionTargetSchema.optional(),
} as const;

const chatPlacementCreateSchema = z
  .object(chatPlacementCreateFields)
  .strict()
  .refine((input) => !(input.worktreeId && input.target), {
    message: "Choose either a legacy worktreeId or an execution target.",
  });

export const chatCreateSchema = chatPlacementCreateSchema
  .safeExtend({
    title: z.string().trim().min(1).max(200).default("New agent"),
  })
  .strict();

export const encryptedChatCreateSchema = chatPlacementCreateSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Chat title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const taskCreateBaseSchema = chatPlacementCreateSchema.safeExtend({
  chatId: z.string().uuid(),
  task: taskOpaqueContentSchema,
});

function refineInitialTask(
  input: z.infer<typeof taskCreateBaseSchema>,
  context: z.RefinementCtx,
): void {
  const classification = input.task.classification;
  if (
    classification.state !== "draft" ||
    classification.stableStateBeforeFailure !== null ||
    classification.activeOperationKind !== null ||
    classification.planAuthorship !== "agent" ||
    classification.planningRound !== 0 ||
    classification.hasPlan ||
    classification.hasQuestions ||
    classification.hasFinalPlan ||
    classification.hasGoalPrompt ||
    classification.lastError !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "A new encrypted Task must begin as an empty draft.",
      path: ["task", "classification"],
    });
  }
}

export const taskCreateSchema = taskCreateBaseSchema
  .safeExtend({
    title: z.string().trim().min(1).max(200).default("New task"),
  })
  .strict()
  .superRefine(refineInitialTask);

export const encryptedTaskCreateSchema = taskCreateBaseSchema
  .safeExtend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .superRefine((input, context) => {
    refineInitialTask(input, context);
    if (input.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Task title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedChatUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "chat",
    {
      message: "Chat title classification must be chat.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const chatForkSchema = z.object({
  messageId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).optional(),
});

export const encryptedChatForkSchema = chatForkSchema
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "chat",
    {
      message: "Forked chat title classification must be chat.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const orderedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

const chatSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  experience: z.enum(["agent", "task"]).default("agent"),
  position: z.number().int().nonnegative(),
  status: z.enum([
    "idle",
    "running",
    "waiting-for-approval",
    "offline",
    "failed",
  ]),
  activeWorkerId: z.string().min(1).nullable(),
  activeWorktreeId: z.string().min(1),
  placementRevision: z.number().int().positive().default(1),
  worktreeMode: z.enum(["agent-managed", "pinned"]),
  modelId: z.string().min(1).nullable(),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  customSubagentModel: z.boolean().optional(),
  subagentModelId: z.string().min(1).nullable().optional(),
  subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  planMode: z.enum(["default", "plan"]),
  hasPendingPlanQuestion: z.boolean(),
  hasUnreadCompletion: z.boolean().default(false),
  automationPaused: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const chatSummarySchema = chatSummaryBaseSchema
  .extend({ title: z.string().min(1).max(200) })
  .strict();

export const chatWireSummarySchema = chatSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const taskCreateResultSchema = z.object({
  chat: chatSummarySchema,
  task: taskOpaqueSummarySchema,
});

export const taskWireCreateResultSchema = z.object({
  chat: chatWireSummarySchema,
  task: taskOpaqueSummarySchema,
});

export const chatListSchema = z.array(chatSummarySchema);
export const chatWireListSchema = z.array(chatWireSummarySchema);

const archivedChatSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  experience: z.enum(["agent", "task"]).default("agent"),
  messageCount: z.number().int().nonnegative(),
  archivedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const archivedChatSummarySchema = archivedChatSummaryBaseSchema
  .extend({ title: z.string().min(1).max(200) })
  .strict();

export const archivedChatWireSummarySchema = archivedChatSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Archived chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const archivedChatListSchema = z.array(archivedChatSummarySchema);
export const archivedChatWireListSchema = z.array(
  archivedChatWireSummarySchema,
);

export const archivedChatCleanupResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

export const permissionProfileIdSchema = z.string().min(1).max(200);
export const YOLO_PERMISSION_PROFILE_ID = ":yolo" as const;

export const permissionProfileSummarySchema = z.object({
  id: permissionProfileIdSchema,
  description: z.string(),
  allowed: z.boolean(),
});

export const permissionProfileCapabilitySchema = z.object({
  available: z.boolean(),
  profiles: z.array(permissionProfileSummarySchema),
  reason: z.string().min(1).nullable(),
});

export const chatPermissionProfileStateSchema =
  permissionProfileCapabilitySchema.extend({
    selectedId: permissionProfileIdSchema,
    effectiveId: permissionProfileIdSchema,
    defaultId: permissionProfileIdSchema.default(DEFAULT_PERMISSION_PROFILE_ID),
    usesDefault: z.boolean().default(false),
    forcedByWorktreePolicy: z.boolean(),
  });

export const chatPermissionProfileUpdateSchema = z.object({
  id: permissionProfileIdSchema.nullable(),
});

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "Expected a safe repository-relative path.",
  );

const terminalPlacementSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    tabGroupId: z.string().min(1).optional(),
    target: executionTargetSchema.optional(),
  })
  .refine((input) => !(input.worktreeId && input.target), {
    message: "Choose either a legacy worktreeId or an execution target.",
  });

export const terminalCreateSchema = terminalPlacementSchema.safeExtend({
  directoryPath: repositoryRelativePathSchema.optional(),
  title: z.string().trim().min(1).max(200).default("Terminal"),
});

export const encryptedTerminalCreateSchema = terminalPlacementSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const encryptedRunTerminalMaterializationSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    terminalId: runInstanceSchema.shape.id,
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Run terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const encryptedLinkedConsoleCreateSchema = z
  .object({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Linked console title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const terminalUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedTerminalUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const terminalServiceConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    command: z.string().max(100_000),
  })
  .superRefine((configuration, context) => {
    if (configuration.enabled && configuration.command.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "A command is required when terminal service mode is enabled.",
        path: ["command"],
      });
    }
  });

export const encryptedTerminalServiceConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict();

export const terminalServiceRuntimeConfigurationSchema = z
  .object({
    terminalId: z.string().min(1),
    serverId: z.string().min(1).max(255),
    worktreePath: z.string().min(1).max(8_192),
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict();

const terminalSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "exited", "offline", "failed"]),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  linkedChatId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const terminalSummarySchema = terminalSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  directoryPath: repositoryRelativePathSchema.nullable(),
  service: terminalServiceConfigurationSchema,
});

export const terminalWireSummarySchema = terminalSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
    serviceEnabled: z.boolean(),
  })
  .strict()
  .refine(
    (terminal) =>
      terminal.titleProtection.classification.recordKind === "terminal",
    {
      message: "Terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const terminalListSchema = z.array(terminalSummarySchema);
export const terminalWireListSchema = z.array(terminalWireSummarySchema);

export const scriptCommandKindSchema = z.enum([
  "package",
  "dart",
  "just",
  "cargo",
  "gradle",
  "make",
]);

const scriptCommandTextSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Script command text cannot contain control characters.",
  });

export const scriptCommandSchema = z.object({
  id: z.string().min(1).max(512),
  kind: scriptCommandKindSchema,
  name: scriptCommandTextSchema.max(200),
  command: scriptCommandTextSchema.max(4_096),
  description: scriptCommandTextSchema.max(4_096).nullable(),
  source: scriptCommandTextSchema.max(512),
});

export const scriptCommandListSchema = z.array(scriptCommandSchema).max(500);

export const protectedScriptCommandListSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    protectedCommands: repositoryOperationOpaqueSchema,
  })
  .strict();

const explorerCreateBaseSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    tabGroupId: z.string().min(1).optional(),
    target: executionTargetSchema.optional(),
    attachToTabLayout: z.boolean().optional(),
  })
  .refine((input) => !(input.worktreeId && input.target), {
    message: "Choose either a legacy worktreeId or an execution target.",
  });

export const explorerCreateSchema = explorerCreateBaseSchema.safeExtend({
  title: z.string().trim().min(1).max(200).default("Explorer"),
});

export const encryptedExplorerCreateSchema = explorerCreateBaseSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedExplorerUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerFileModeSchema = z.enum(["preview", "visual", "edit"]);

export const explorerViewStateUpdateSchema = z.object({
  selectedPath: z.string().min(1).max(8_192).nullable(),
  fileMode: explorerFileModeSchema,
});

export const encryptedExplorerViewStateUpdateSchema = z
  .object({
    stateProtection: explorerPrivateStateOpaqueSchema,
    fileMode: explorerFileModeSchema,
  })
  .strict();

export const encryptedExplorerWorktreeUpdateSchema = z
  .object({
    worktreeId: z.string().min(1),
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict();

const explorerSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  fileMode: explorerFileModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const explorerSummarySchema = explorerSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  selectedPath: explorerViewStateUpdateSchema.shape.selectedPath,
});

export const explorerWireSummarySchema = explorerSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (explorer) =>
      explorer.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerListSchema = z.array(explorerSummarySchema);
export const explorerWireListSchema = z.array(explorerWireSummarySchema);

export const codeThemeModeSchema = z.enum(["follow-cantrip", "independent"]);
export const codePresentationSchema = z.enum(["workbench", "editor"]);
export const codeAppearanceSchema = z.enum([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
  "pro-light",
  "pro-dark",
  "pro-high-contrast-light",
  "pro-high-contrast-dark",
]);
export const codeTabStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "stopped",
  "offline",
  "failed",
]);
export const codeSessionStatusSchema = z.enum([
  "starting",
  "running",
  "idle",
  "stopping",
  "stopped",
  "offline",
  "failed",
]);

const codeTabCreateBaseSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    profileId: z.string().trim().min(1).max(200).default("default"),
    themeMode: codeThemeModeSchema.default("follow-cantrip"),
    tabGroupId: z.string().min(1).optional(),
    target: executionTargetSchema.optional(),
  })
  .refine((input) => !(input.worktreeId && input.target), {
    message: "Choose either a legacy worktreeId or an execution target.",
  });

export const codeTabCreateSchema = codeTabCreateBaseSchema.safeExtend({
  title: z.string().trim().min(1).max(200).default("Code"),
});

export const encryptedCodeTabCreateSchema = codeTabCreateBaseSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .refine(
    (input) => input.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    themeMode: codeThemeModeSchema.optional(),
  })
  .refine(
    (input) => input.title !== undefined || input.themeMode !== undefined,
    { message: "At least one Code tab field is required." },
  );

export const encryptedCodeTabUpdateSchema = z
  .object({
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    themeMode: codeThemeModeSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection === undefined && input.themeMode === undefined) {
      context.addIssue({
        code: "custom",
        message: "At least one Code tab field is required.",
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "code-tab"
    ) {
      context.addIssue({
        code: "custom",
        message: "Code-tab title classification must be code-tab.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const codeTabSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  themeMode: codeThemeModeSchema,
  status: codeTabStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeTabSummarySchema = codeTabSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
});

export const codeTabWireSummarySchema = codeTabSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .refine(
    (codeTab) =>
      codeTab.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabListSchema = z.array(codeTabSummarySchema);
export const codeTabWireListSchema = z.array(codeTabWireSummarySchema);

export const codeEditorBuildSchema = z.object({
  version: z.string().min(1),
  upstreamRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  patchset: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const codeProbeResultSchema = z.object({
  capabilities: codeCapabilitiesSchema,
  editorBuild: codeEditorBuildSchema.nullable(),
});

export const codeSessionSummarySchema = z.object({
  id: z.string().min(1),
  codeTabId: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  editorBuild: codeEditorBuildSchema.nullable(),
  status: codeSessionStatusSchema,
  processInstanceId: z.string().min(1).nullable(),
  lastAttachmentAt: z.string().datetime().nullable(),
  lastStartedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeSessionListSchema = z.array(codeSessionSummarySchema);

export const codeDirtyEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  untitled: z.boolean(),
  dirty: z.literal(true),
});

export const codeSaveBeforeAgentTurnSchema = z.enum(["always", "ask", "never"]);

export const codeWorkbenchAgentStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);

export const codeWorkbenchActiveEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  selection: z.object({
    startLine: z.number().int().nonnegative(),
    startCharacter: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endCharacter: z.number().int().nonnegative(),
  }),
});

export const codeWorkbenchGitStateSchema = z.object({
  branch: z.string().max(1_000).nullable(),
  head: z.string().max(200).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});

export const codeWorkbenchStateSchema = z.object({
  activeEditor: codeWorkbenchActiveEditorSchema.nullable(),
  git: codeWorkbenchGitStateSchema.nullable(),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
  savePolicy: codeSaveBeforeAgentTurnSchema,
  agentStatus: codeWorkbenchAgentStatusSchema,
});

export const codeRuntimeStatusSchema = z.object({
  sessionId: z.string().min(1),
  workspaceUri: z.string().min(1).max(16_384).optional(),
  status: codeSessionStatusSchema,
  editorBuild: codeEditorBuildSchema,
  processInstanceId: z.string().min(1).nullable(),
  bridgeConnected: z.boolean(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  workbench: codeWorkbenchStateSchema,
  startedAt: z.string().datetime().nullable(),
  lastActivityAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const codeSaveAllResultSchema = z.object({
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: z
    .array(
      z.object({
        uri: z.string().min(1).max(16_384),
        message: z.string().min(1).max(4_000),
      }),
    )
    .max(1_000),
});

export const codeAgentTurnPreparationSessionSchema = z.object({
  sessionId: z.string().min(1),
  bridgeConnected: z.boolean(),
  allowed: z.boolean(),
  policy: codeSaveBeforeAgentTurnSchema.nullable(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: codeSaveAllResultSchema.shape.failed,
  reason: z.string().max(4_000).nullable(),
});

export const codeAgentTurnPreparationResultSchema = z.object({
  prepared: z.boolean(),
  sessions: z.array(codeAgentTurnPreparationSessionSchema).max(128),
});

export const codeAgentTurnNotificationResultSchema = z.object({
  notifiedSessions: z.number().int().nonnegative(),
  refreshed: z.array(z.string().max(8_192)).max(5_000),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
});

export const codeAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  sessionId: z.string().min(1),
  url: z.url(),
  expiresAt: z.string().datetime(),
  runtime: codeRuntimeStatusSchema,
});

export const codeProtectedAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    sessionId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    runtime: codeRuntimeStatusSchema,
  })
  .strict()
  .refine(({ attachmentId, tunnelId }) => attachmentId === tunnelId, {
    message: "A protected Code attachment must reuse its tunnel identity.",
    path: ["attachmentId"],
  });

export const codeProtectedAttachmentIntentSchema = z
  .object({
    sessionId: tunnelResourceIdSchema,
    runtime: codeRuntimeStatusSchema,
  })
  .strict()
  .refine(({ sessionId, runtime }) => sessionId === runtime.sessionId, {
    message: "A Code attachment intent must bind its runtime session.",
    path: ["runtime", "sessionId"],
  });

export const projectShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const projectShareTunnelCreateSchema = z
  .object({
    tunnelId: z.string().uuid(),
    workerId: tunnelResourceIdSchema,
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ tunnelId, protectedRecord }) =>
      tunnelId === protectedRecord.operationId || protectedRecord.revision > 1,
    {
      message:
        "A new project share must bind its tunnel identity to its protected record.",
      path: ["protectedRecord", "operationId"],
    },
  );

export const projectShareDirectCreateSchema = z
  .object({
    clientId: tunnelResourceIdSchema,
  })
  .strict();

export const projectShareAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    projectId: tunnelResourceIdSchema,
    protocol: z.literal("webdav"),
    tunnelId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    mountLeaseMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export const projectSharePublicBasePathSchema = z
  .string()
  .regex(/^\/project-shares\/[A-Za-z0-9_-]{43}$/u);

export const projectSharePublicOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
});

export const codeAttachmentCreateSchema = z.object({
  appearance: codeAppearanceSchema.default("dark"),
  expectedWorkerId: executionResourceIdSchema,
  expectedWorktreeId: executionResourceIdSchema,
});

export const codeProtectedAttachmentCreateSchema = codeAttachmentCreateSchema
  .extend({
    tunnelId: z.string().uuid(),
    sessionId: z.string().uuid(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ tunnelId, protectedRecord }) =>
      tunnelId === protectedRecord.operationId &&
      protectedRecord.revision === 1,
    {
      message:
        "A protected Code attachment must begin with its tunnel-bound record.",
      path: ["protectedRecord"],
    },
  );

export const explorerCodeProtectedAttachmentCreateSchema =
  codeProtectedAttachmentCreateSchema.extend({
    path: repositoryRelativePathSchema.optional(),
  });

export const explorerCodeAttachmentCreateSchema = codeAttachmentCreateSchema
  .extend({
    path: repositoryRelativePathSchema,
  })
  .strict();

export const codeOpenFileResultSchema = z
  .object({
    relativePath: repositoryRelativePathSchema,
  })
  .strict();

export const codeOpenFileRequestSchema = codeOpenFileResultSchema;

export const codePresentationUpdateSchema = z
  .object({
    presentation: codePresentationSchema,
  })
  .strict();

export const codeThemeUpdateSchema = z.object({
  themeMode: codeThemeModeSchema,
  appearance: codeAppearanceSchema,
});

export function isForwardableCodeWebSocketCloseCode(code: number): boolean {
  return (
    (code >= 1_000 &&
      code <= 1_014 &&
      code !== 1_004 &&
      code !== 1_005 &&
      code !== 1_006) ||
    (code >= 3_000 && code <= 4_999)
  );
}

export const CODE_MAX_WEBSOCKET_MESSAGE_BYTES = 4 * 1_024 * 1_024;
const browserHttpUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => /^https?:\/\//u.test(value), {
    message: "Browser URLs must use HTTP or HTTPS.",
  });

const browserCreateBaseSchema = z.object({
  tabGroupId: z.string().min(1).optional(),
  target: executionTargetSchema.optional(),
});

export const browserCreateSchema = browserCreateBaseSchema
  .extend({
    title: z.string().trim().min(1).max(200).default("Browser"),
    url: browserHttpUrlSchema.optional(),
  })
  .strict();

export const encryptedBrowserCreateSchema = browserCreateBaseSchema
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: browserPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "browser",
    {
      message: "Browser title classification must be browser.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const browserUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    url: browserHttpUrlSchema.optional(),
  })
  .refine((input) => input.title !== undefined || input.url !== undefined, {
    message: "At least one browser field is required.",
  });

export const encryptedBrowserUpdateSchema = z
  .object({
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    expectedStateRevision: z.number().int().positive().safe().optional(),
    stateProtection: browserPrivateStateOpaqueSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.titleProtection === undefined &&
      input.stateProtection === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one browser field is required.",
      });
    }
    if (
      (input.stateProtection === undefined) !==
      (input.expectedStateRevision === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser state updates require an expected revision.",
        path: ["expectedStateRevision"],
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "browser"
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser title classification must be browser.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const browserSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  stateRevision: z.number().int().positive().safe(),
  workerId: z.string().min(1).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const browserSummarySchema = browserSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  url: browserHttpUrlSchema,
});

export const browserWireSummarySchema = browserSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: browserPrivateStateOpaqueSchema,
  })
  .refine(
    (browser) =>
      browser.titleProtection.classification.recordKind === "browser",
    {
      message: "Browser title classification must be browser.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const browserListSchema = z.array(browserSummarySchema);
export const browserWireListSchema = z.array(browserWireSummarySchema);

export const browserServiceProtocolSchema = z.enum(["http", "https"]);

export const browserServiceSchema = z.object({
  workerId: z.string().min(1).max(200),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  protocol: browserServiceProtocolSchema,
  url: z
    .string()
    .url()
    .max(4_096)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "Browser service URLs must use HTTP or HTTPS.",
    }),
  title: z.string().trim().min(1).max(200).nullable(),
  processName: z.string().trim().min(1).max(200).nullable(),
  statusCode: z.number().int().min(100).max(599),
});

export const browserServiceListSchema = z.array(browserServiceSchema).max(128);

export const browserFleetServiceSchema = browserServiceSchema.extend({
  workerName: z.string().min(1).max(200),
  placement: executionPlacementSchema,
});

export const browserServiceDiscoveryWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "timed-out",
  "error",
]);

export const browserServiceDiscoveryErrorSchema = z.object({
  code: z.enum(["worker-offline", "worker-timeout", "worker-error"]),
  message: z.string().min(1).max(1_000),
});

export const browserServiceDiscoveryWorkerResultSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  status: browserServiceDiscoveryWorkerStatusSchema,
  services: z.array(browserFleetServiceSchema).max(128),
  error: browserServiceDiscoveryErrorSchema.nullable(),
  truncated: z.boolean().default(false),
});

export const browserServiceFleetDiscoverySchema = z.object({
  projectId: z.string().min(1),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean().default(false),
  workers: z.array(browserServiceDiscoveryWorkerResultSchema).max(64),
});

export const browserTunnelRequestSchema = z
  .object({
    protocol: z.enum(["http", "https"]),
    host: z.enum(["127.0.0.1", "localhost", "::1"]),
    port: z.number().int().min(1).max(65_535),
    workerId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const browserTunnelWireRequestSchema = z
  .object({
    tunnelId: z.string().uuid(),
    protocolHint: z.enum(["http-websocket", "https-websocket"]),
    workerId: z.string().min(1).max(200),
    resetAttachments: z.boolean().default(false),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict();

export const remoteDesktopTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("monitor"),
    id: z.string().min(1).max(200).nullable().default(null),
    name: z.string().trim().min(1).max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string().min(1).max(200).nullable().default(null),
    application: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
]);

export const remoteDesktopCreateSchema = z
  .object({
    tabGroupId: z.string().min(1).optional(),
    target: executionTargetSchema.optional(),
  })
  .strict();

export const encryptedRemoteDesktopCreateSchema = remoteDesktopCreateSchema
  .extend({
    id: z.string().uuid(),
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Remote Desktop title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const remoteDesktopMonitorSchema = z.object({
  kind: z.literal("monitor"),
  id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(500),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  primary: z.boolean(),
});

export const remoteDesktopApplicationIconKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_-]+$/u);

export const remoteDesktopWindowSchema = z.object({
  kind: z.literal("window"),
  id: z.string().min(1).max(200),
  application: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(1_000),
  iconKey: remoteDesktopApplicationIconKeySchema.nullable().default(null),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  minimized: z.boolean(),
  focused: z.boolean(),
});

export const remoteDesktopTargetInventorySchema = z.object({
  monitors: z.array(remoteDesktopMonitorSchema).max(64),
  windows: z.array(remoteDesktopWindowSchema).max(2_000),
});

export const encryptedRemoteDesktopUpdateSchema = z
  .object({
    expectedStateRevision: z.number().int().positive().safe(),
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
  })
  .strict();

const remoteDesktopSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  stateRevision: z.number().int().positive().safe(),
  status: remoteSurfaceStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteDesktopSummarySchema = remoteDesktopSummaryBaseSchema.extend(
  {
    title: z.string().min(1).max(200),
    target: remoteDesktopTargetSchema,
  },
);

export const remoteDesktopWireSummarySchema = remoteDesktopSummaryBaseSchema
  .extend({
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .superRefine((desktop, context) => {
    if (desktop.titleProtection.classification.recordKind !== "project-view") {
      context.addIssue({
        code: "custom",
        message: "Remote Desktop title classification must be project-view.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

export const remoteDesktopListSchema = z.array(remoteDesktopSummarySchema);
export const remoteDesktopWireListSchema = z.array(
  remoteDesktopWireSummarySchema,
);

export const remoteDesktopFleetWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "timed-out",
  "error",
]);

export const remoteDesktopFleetErrorSchema = z.object({
  code: z.enum(["worker-offline", "worker-timeout", "worker-error"]),
  message: z.string().min(1).max(1_000),
});

export const remoteDesktopFleetWorkerSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  architecture: z.string().min(1).max(100),
  status: remoteDesktopFleetWorkerStatusSchema,
  inventory: remoteDesktopTargetInventorySchema,
  desktops: z.array(remoteDesktopSummarySchema).max(64),
  error: remoteDesktopFleetErrorSchema.nullable(),
  truncated: z.boolean().default(false),
});

export const remoteDesktopProtectedInventorySchema = z
  .object({
    operationId: z.string().uuid(),
    stateProtection: remoteDesktopPrivateInventoryOpaqueSchema,
    monitorCount: z.number().int().nonnegative().max(64),
    windowCount: z.number().int().nonnegative().max(2_000),
    truncated: z.boolean().default(false),
  })
  .strict();

export const remoteDesktopFleetWireWorkerSchema = remoteDesktopFleetWorkerSchema
  .omit({ inventory: true })
  .extend({
    inventoryOperationId: z.string().uuid().nullable(),
    inventoryProtection: remoteDesktopPrivateInventoryOpaqueSchema.nullable(),
    monitorCount: z.number().int().nonnegative().max(64),
    windowCount: z.number().int().nonnegative().max(2_000),
    desktops: z.array(remoteDesktopWireSummarySchema).max(64),
  })
  .strict()
  .superRefine((worker, context) => {
    if (
      (worker.status === "ok") !==
      (worker.inventoryOperationId !== null &&
        worker.inventoryProtection !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Available Remote Desktop workers require protected inventory.",
        path: ["inventoryProtection"],
      });
    }
  });

export const remoteDesktopFleetSchema = z.object({
  projectId: z.string().min(1),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean().default(false),
  workers: z.array(remoteDesktopFleetWorkerSchema).max(64),
});

export const remoteDesktopFleetWireSchema = remoteDesktopFleetSchema
  .extend({
    workers: z.array(remoteDesktopFleetWireWorkerSchema).max(64),
  })
  .strict();

export const remoteSurfaceConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    profileId: z.string().trim().min(1).max(200).nullable().default(null),
  }),
  z
    .object({
      kind: z.literal("desktop"),
    })
    .strict(),
]);

export const remoteSurfaceCreateSchema = z.object({
  workerId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  configuration: remoteSurfaceConfigurationSchema,
});

export const encryptedRemoteSurfaceCreateSchema = remoteSurfaceCreateSchema
  .omit({ title: true })
  .extend({
    id: z.string().uuid(),
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .optional(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection.classification.recordKind !== "remote-surface") {
      context.addIssue({
        code: "custom",
        message: "Remote Surface title classification must be remote-surface.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const expectedStateKind =
      input.configuration.kind === "browser"
        ? "browser-state"
        : "remote-desktop-state";
    if (
      input.stateProtection?.classification.recordKind !== expectedStateKind
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface protected state must match its kind.",
        path: ["stateProtection"],
      });
    }
  });

export const remoteSurfaceUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    configuration: remoteSurfaceConfigurationSchema.optional(),
    preferredTransport: remoteSurfaceTransportSchema.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.configuration !== undefined ||
      input.preferredTransport !== undefined,
    { message: "At least one remote surface field is required." },
  );

export const encryptedRemoteSurfaceUpdateSchema = z
  .object({
    expectedStateRevision: z.number().int().positive().safe().optional(),
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    configuration: remoteSurfaceConfigurationSchema.optional(),
    preferredTransport: remoteSurfaceTransportSchema.optional(),
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.titleProtection === undefined &&
      input.configuration === undefined &&
      input.preferredTransport === undefined &&
      input.stateProtection === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one remote surface field is required.",
      });
    }
    if (
      (input.stateProtection === undefined) !==
      (input.expectedStateRevision === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface state updates require an expected revision.",
        path: ["expectedStateRevision"],
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "remote-surface"
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface title classification must be remote-surface.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const remoteSurfaceSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  kind: remoteSurfaceKindSchema,
  status: remoteSurfaceStatusSchema,
  preferredTransport: remoteSurfaceTransportSchema,
  configuration: remoteSurfaceConfigurationSchema,
  stateRevision: z.number().int().positive().safe().nullable(),
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteSurfaceSummarySchema = remoteSurfaceSummaryBaseSchema.extend(
  {
    title: z.string().min(1).max(200),
    url: browserHttpUrlSchema.nullable(),
  },
);

export const remoteSurfaceWireSummarySchema = remoteSurfaceSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .nullable(),
  })
  .superRefine((surface, context) => {
    const recordKind = surface.titleProtection.classification.recordKind;
    if (
      recordKind !== "remote-surface" &&
      !(surface.kind === "browser" && recordKind === "browser") &&
      !(surface.kind === "desktop" && recordKind === "project-view")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Remote Surface title classification must match its canonical owner.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const expectedRecordKind =
      surface.kind === "browser" ? "browser-state" : "remote-desktop-state";
    if (
      surface.stateProtection?.classification.recordKind !==
        expectedRecordKind ||
      surface.stateRevision === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surfaces require protected state matching their kind.",
        path: ["stateProtection"],
      });
    }
  });

export const remoteSurfaceListSchema = z.array(remoteSurfaceSummarySchema);
export const remoteSurfaceWireListSchema = z.array(
  remoteSurfaceWireSummarySchema,
);

export const remoteSurfaceViewportSchema = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  devicePixelRatio: z.number().min(0.25).max(8),
});

export const desktopStreamSettingsSchema = z.object({
  targetFps: z.number().int().min(1).max(60),
  quality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
});

export const remoteSurfaceConnectionMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("ready"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      transport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string().min(1),
      recoverable: z.boolean(),
    }),
  ],
);

export const remoteSurfaceAttachResultSchema = z.object({
  accepted: z.literal(true),
  transport: remoteSurfaceTransportSchema,
});

export const remoteSurfaceControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({ type: z.literal("suspend") }),
  z.object({ type: z.literal("resume") }),
]);

export const remoteDesktopProbeResultSchema = z.object({
  available: z.boolean(),
  message: z.string().max(2_048).nullable(),
});

export const remoteDesktopApplicationIconSchema = z.object({
  key: remoteDesktopApplicationIconKeySchema,
  mimeType: z.literal("image/png"),
  data: z.string().max(180_000).nullable(),
});

export const remoteDesktopClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({ type: z.literal("refresh-targets") }),
  z.object({
    type: z.literal("request-target-icons"),
    keys: z.array(remoteDesktopApplicationIconKeySchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
  z.object({
    type: z.literal("stream-feedback"),
    intervalMs: z.number().int().min(250).max(10_000),
    receivedFrames: z.number().int().nonnegative().max(1_000),
    renderedFrames: z.number().int().nonnegative().max(1_000),
    droppedFrames: z.number().int().nonnegative().max(1_000),
    averageDecodeMs: z.number().finite().nonnegative().max(10_000),
  }),
]);

export const remoteDesktopServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("desktop-state"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    status: z.enum(["ready", "launching", "suspended", "error"]),
    message: z.string().max(2_048).nullable(),
    stream: z
      .object({
        backend: z.enum(["native", "compatibility"]),
        targetFps: z.number().int().min(1).max(60),
        observedFps: z.number().finite().nonnegative().max(240),
        quality: z.number().int().min(1).max(100),
        encodedWidth: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
  z
    .object({
      type: z.literal("desktop-targets"),
      operationId: z.string().uuid(),
      stateProtection: remoteDesktopPrivateInventoryOpaqueSchema,
      monitorCount: z.number().int().nonnegative().max(64),
      windowCount: z.number().int().nonnegative().max(2_000),
    })
    .strict(),
  z.object({
    type: z.literal("desktop-target-icons"),
    icons: z.array(remoteDesktopApplicationIconSchema).max(64),
  }),
  z.object({
    type: z.literal("desktop-clipboard"),
    text: z.string().max(1_000_000),
  }),
]);

export const remoteBrowserClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    operationId: z.string().uuid(),
    stateProtection: browserPrivateStateOpaqueSchema,
  }),
  z.object({
    type: z.literal("history"),
    delta: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({
    type: z.literal("touch"),
    event: z.enum(["start", "move", "end", "cancel"]),
    points: z
      .array(
        z.object({
          id: z.number().int().nonnegative(),
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          radiusX: z.number().finite().positive().default(1),
          radiusY: z.number().finite().positive().default(1),
          force: z.number().finite().min(0).max(1).default(1),
        }),
      )
      .max(10),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy-selection", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
]);

export const remoteBrowserServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser-state"),
    operationId: z.string().uuid(),
    stateProtection: browserPrivateStateOpaqueSchema,
    title: z.string().max(2_000),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  }),
  z.object({
    type: z.literal("browser-runtime"),
    status: z.enum(["ready", "recovering", "error"]),
    message: z.string().max(2_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("browser-input-focus"),
    editable: z.boolean(),
  }),
]);

export const remoteBrowserCursorMessageSchema = z.object({
  type: z.literal("browser-cursor"),
  cursor: z.enum([
    "auto",
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "all-scroll",
    "col-resize",
    "row-resize",
    "n-resize",
    "e-resize",
    "s-resize",
    "w-resize",
    "ne-resize",
    "nw-resize",
    "se-resize",
    "sw-resize",
    "ew-resize",
    "ns-resize",
    "nesw-resize",
    "nwse-resize",
    "zoom-in",
    "zoom-out",
  ]),
});

export const remoteBrowserClipboardMessageSchema = z.object({
  type: z.literal("browser-clipboard"),
  operation: z.literal("copy-selection"),
  text: z.string().max(1_000_000),
});

export const remoteSurfaceFrameHeaderSchema = z.object({
  protocolVersion: remoteSurfaceProtocolVersionSchema,
  surfaceId: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative().safe(),
  channel: remoteSurfaceChannelSchema,
});

export const REMOTE_SURFACE_MAX_HEADER_BYTES = 64 * 1_024;
export const REMOTE_SURFACE_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const REMOTE_SURFACE_FRAME_MAGIC = new Uint8Array([0x43, 0x54, 0x52, 0x53]);

export function encodeRemoteSurfaceFrame(
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = remoteSurfaceFrameHeaderSchema.parse(header);
  if (payload.byteLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(REMOTE_SURFACE_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeRemoteSurfaceFrame(frame: Uint8Array): {
  header: RemoteSurfaceFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8)
    throw new Error("Remote Surface frame is truncated.");
  for (let index = 0; index < REMOTE_SURFACE_FRAME_MAGIC.length; index += 1) {
    if (frame[index] !== REMOTE_SURFACE_FRAME_MAGIC[index]) {
      throw new Error("Remote Surface frame has an invalid magic value.");
    }
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Remote Surface frame header is truncated.");
  }
  const payloadLength = frame.byteLength - payloadOffset;
  if (payloadLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Remote Surface frame header is not valid JSON.");
  }
  return {
    header: remoteSurfaceFrameHeaderSchema.parse(rawHeader),
    payload: frame.subarray(payloadOffset),
  };
}

export const projectViewKindSchema = z.enum([
  "history",
  "issues",
  "remote-desktop",
]);

export const projectViewCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).optional(),
  tabGroupId: z.string().min(1).optional(),
});

export const encryptedProjectViewCreateSchema = projectViewCreateSchema
  .omit({ title: true })
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const projectTabKindSchema = z.enum([
  "chat",
  "terminal",
  "explorer",
  "browser",
  "code",
  "history",
  "issues",
  "remote-desktop",
]);

const projectTabMemberSummaryBaseSchema = z.object({
  tabKey: z.string().min(1),
  groupId: z.string().min(1),
  projectId: z.string().min(1),
  tabKind: projectTabKindSchema,
  tabId: z.string().min(1),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectTabMemberSummarySchema =
  projectTabMemberSummaryBaseSchema.extend({ title: z.string().min(1) });

export const projectTabMemberWireSummarySchema =
  projectTabMemberSummaryBaseSchema
    .extend({
      titleProtection: privateDisplayLabelOpaqueSchema,
    })
    .superRefine((member, context) => {
      const expectedRecordKind =
        member.tabKind === "chat"
          ? "chat"
          : member.tabKind === "terminal"
            ? "terminal"
            : member.tabKind === "explorer"
              ? "explorer"
              : member.tabKind === "browser"
                ? "browser"
                : member.tabKind === "code"
                  ? "code-tab"
                  : "project-view";
      if (
        member.titleProtection.classification.recordKind !== expectedRecordKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Tab-member title classification must match its surface kind.",
          path: ["titleProtection", "classification", "recordKind"],
        });
      }
    });

const tabGroupSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  anchorTabKey: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tabGroupSummarySchema = tabGroupSummaryBaseSchema.extend({
  title: z.string().min(1).max(120),
  members: z.array(projectTabMemberSummarySchema).min(1),
});

export const tabGroupWireSummarySchema = tabGroupSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    members: z.array(projectTabMemberWireSummarySchema).min(1),
  })
  .superRefine((group, context) => {
    if (
      group.titleProtection &&
      group.titleProtection.classification.recordKind !== "tab-group"
    ) {
      context.addIssue({
        code: "custom",
        message: "Tab-group title classification must be tab-group.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    if (group.members.length === 1 && group.titleProtection !== null) {
      context.addIssue({
        code: "custom",
        message: "A single-tab group derives its title from its member.",
        path: ["titleProtection"],
      });
    }
  });

export const tabGroupUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(120),
});

export const encryptedTabGroupUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "tab-group",
    {
      message: "Tab-group title classification must be tab-group.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const projectTabLayoutSummarySchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(tabGroupSummarySchema),
});

export const projectTabLayoutWireSummarySchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(tabGroupWireSummarySchema),
});

export const tabGroupOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((groupIds) => new Set(groupIds).size === groupIds.length, {
      message: "Tab group ids must be unique.",
    }),
});

export const tabGroupMemberOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  tabKeys: z
    .array(z.string().min(1))
    .min(1)
    .refine((tabKeys) => new Set(tabKeys).size === tabKeys.length, {
      message: "Tab keys must be unique.",
    }),
});

export const tabGroupMemberMoveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
    targetGroupId: z.string().min(1).nullable(),
    targetMemberPosition: z.number().int().nonnegative(),
    targetGroupPosition: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.targetGroupId === null &&
      input.targetGroupPosition === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A sidebar position is required when splitting a tab into a new group.",
        path: ["targetGroupPosition"],
      });
    }
  });

export const projectViewUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedProjectViewUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

const projectViewSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectViewSummarySchema = projectViewSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
});

export const projectViewWireSummarySchema = projectViewSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .refine(
    (view) => view.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const projectViewListSchema = z.array(projectViewSummarySchema);
export const projectViewWireListSchema = z.array(projectViewWireSummarySchema);

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    operationId: surfaceStreamWireRequestSchema.shape.operationId,
    sequence: surfaceStreamWireRequestSchema.shape.sequence,
    protectedData: surfaceStreamOpaqueSchema,
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("output"),
    operationId: surfaceStreamWireRequestSchema.shape.operationId,
    sequence: surfaceStreamWireRequestSchema.shape.sequence,
    protectedData: surfaceStreamOpaqueSchema,
  }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string().min(1) }),
]);

export const terminalOpenResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("detached") }),
  z.object({
    status: z.literal("exited"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
]);

export const terminalSnapshotResultSchema = z.object({
  terminalId: z.string().min(1).max(200),
  status: z.enum(["running", "restarting", "exited", "not-running"]),
  data: z.string().max(100_000),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
});

export const chatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const agentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export const agentActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
]);
export const agentCommandOutputLimitBytes = 256 * 1_024;
export const agentFilePreviewLimitCharacters = 8_192;
export const agentActivityRawRequestLimitBytes = 64 * 1_024;
export const agentActivityRawResponseLimitBytes = 256 * 1_024;

function encodedTextLimitSchema(limit: number) {
  return z.string().superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength <= limit) return;
    context.addIssue({
      code: "custom",
      message: `Raw capture text may contain at most ${limit} encoded bytes.`,
    });
  });
}

const agentActivityRawDocumentBaseShape = {
  mediaType: z.string().min(1).max(200),
  originalBytes: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  digest: z.string().min(1).max(200).nullable().optional(),
  omittedReason: z.string().min(1).max(500).nullable().optional(),
};

export const agentActivityRawRequestDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawRequestLimitBytes).nullable(),
});

export const agentActivityRawResponseDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawResponseLimitBytes).nullable(),
});

export const agentActivityRawEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  request: agentActivityRawRequestDocumentSchema.nullable(),
  response: agentActivityRawResponseDocumentSchema.nullable(),
  metadata: z
    .record(z.string().min(1).max(100), z.string().max(4_000))
    .refine((value) => Object.keys(value).length <= 32, {
      message: "Raw capture metadata may contain at most 32 entries.",
    }),
});

const agentActivityTimestampSchema = z.number().int().nonnegative().safe();
const agentCommandOutputSchema = z.string().superRefine((value, context) => {
  const size = new TextEncoder().encode(value).byteLength;
  if (size <= agentCommandOutputLimitBytes) return;
  context.addIssue({
    code: "custom",
    message: `Agent command output may contain at most ${agentCommandOutputLimitBytes} encoded bytes.`,
  });
});
export const codexEventCorrelationSchema = z.object({
  sourceMethod: z.string().min(1).max(200),
  diagnosticId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  itemId: z.string().min(1).max(200).nullable(),
});

export const agentScopeSchema = z
  .object({
    agentThreadId: z.string().min(1).max(200),
    rootThreadId: z.string().min(1).max(200),
    parentThreadId: z.string().min(1).max(200).nullable(),
    rootTurnId: z.string().min(1).max(200),
    agentPath: z.array(z.string().min(1).max(200)).max(32),
    nickname: z.string().min(1).max(200).nullable(),
    role: z.string().min(1).max(500).nullable(),
    depth: z.number().int().nonnegative().max(32),
    isRoot: z.boolean(),
  })
  .strict();

export const agentCommunicationKindSchema = z.enum([
  "spawned",
  "messageSent",
  "followupSent",
  "waiting",
  "statusChanged",
  "interrupted",
  "returned",
  "failed",
]);

const agentActivityBaseShape = {
  id: z.string().min(1),
  status: agentActivityStatusSchema,
  startedAtMs: agentActivityTimestampSchema.optional(),
  updatedAtMs: agentActivityTimestampSchema.optional(),
  completedAtMs: agentActivityTimestampSchema.nullable().optional(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
  raw: agentActivityRawEnvelopeSchema.optional(),
};

export const agentTokenUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
});

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});

export const agentActivitySchema = z.discriminatedUnion("type", [
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("instructionContext"),
    provenance: z.enum(["exact", "assembled", "unavailable"]),
    text: z.string().max(agentActivityRawRequestLimitBytes).nullable(),
    sources: z.array(z.string().min(1).max(500)).max(100),
    model: z.string().max(200).nullable(),
    provider: z.string().max(200).nullable(),
    reasoningEffort: z.string().max(100).nullable(),
    collaborationMode: z.string().max(100).nullable(),
    permissionProfile: z.string().max(200).nullable(),
    runtimeVersion: z.string().max(100).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("command"),
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    output: z.string().nullable(),
    outputTail: agentCommandOutputSchema.nullable().optional(),
    outputTruncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("fileChange"),
    changes: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["add", "delete", "update"]),
        latestLine: z
          .string()
          .max(agentFilePreviewLimitCharacters)
          .nullable()
          .optional(),
        lastActivityAtMs: agentActivityTimestampSchema.optional(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("worktree"),
    operation: z.string().min(1),
    summary: z.string().min(1),
    worktreeId: z.string().min(1).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("plan"),
    text: z.string(),
    explanation: z.string().nullable(),
    steps: z.array(
      z.object({
        step: z.string().min(1),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reasoning"),
    summary: z.array(z.string().min(1)).max(100),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("mcpToolCall"),
    server: z.string().min(1),
    tool: z.string().min(1),
    query: z.string().max(4_000).nullable().optional(),
    resultText: z.string().max(20_000).nullable().optional(),
    error: z.string().nullable(),
    errorCode: z.string().min(1).max(200).nullable().optional(),
    retryable: z.boolean().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("dynamicToolCall"),
    namespace: z.string().min(1).nullable(),
    tool: z.string().min(1),
    success: z.boolean().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("collabToolCall"),
    tool: z.string().min(1),
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)).max(100),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    agentStates: z.array(
      z.object({
        threadId: z.string().min(1),
        status: z.string().min(1),
        message: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("subAgent"),
    kind: z.enum(["started", "interacted", "interrupted"]),
    agentThreadId: z.string().min(1),
    agentPath: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("agentCommunication"),
    kind: agentCommunicationKindSchema,
    senderThreadId: z.string().min(1).max(200),
    receiverThreadIds: z.array(z.string().min(1).max(200)).max(100),
    message: z.string().max(100_000).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("webSearch"),
    query: z.string(),
    action: z.string().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("imageView"),
    path: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reviewMode"),
    state: z.enum(["entered", "exited"]),
    review: z.string(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("contextCompaction"),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("notice"),
    level: z.enum(["warning", "error"]),
    message: z.string().min(1),
    details: z.string().nullable(),
    willRetry: z.boolean().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("usage"),
    total: agentTokenUsageSchema,
    last: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("rateLimit"),
    limitId: z.string().nullable().default(null),
    limitName: z.string().nullable(),
    planType: z.string().nullable(),
    reachedType: z.string().nullable(),
    primary: rateLimitWindowSchema.nullable(),
    secondary: rateLimitWindowSchema.nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("turnSummary"),
    durationMs: z.number().int().nonnegative().nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    completedAt: z.number().int().nonnegative().nullable(),
  }),
]);
export const chatMessageContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
      phase: agentMessagePhaseSchema.nullable().optional(),
      correlation: codexEventCorrelationSchema.nullable().optional(),
      agentScope: agentScopeSchema.optional(),
    }),
    z.object({
      type: z.literal("activity"),
      activity: agentActivitySchema,
    }),
    z.object({
      type: z.literal("attachment"),
      attachment: chatAttachmentSummarySchema,
    }),
  ]),
);

export const chatTurnModeSchema = z.enum(["default", "plan", "goal"]);

export const chatComposerDraftSchema = z
  .object({
    text: z.string().max(100_000),
    mode: chatTurnModeSchema,
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export const chatMessageCreateSchema = z.object({
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema.min(1),
  mode: chatTurnModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = chatMessageCreateSchema
  .omit({ idempotencyKey: true })
  .extend({
    id: z.string().min(1),
    chatId: z.string().min(1),
    worktreeId: z.string().min(1),
    executionLaneId: z.string().min(1).nullable(),
    sequence: z.number().int().positive(),
    mode: chatTurnModeSchema.default("default"),
    reasoningEffort: reasoningEffortSchema.nullable().default(null),
    modelId: z.string().min(1).nullable(),
    modelRouteId: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    providerName: z.string().min(1).nullable(),
    providerModelName: z.string().min(1).nullable(),
    appliedReasoningEffort: reasoningEffortSchema.nullable().default(null),
    reasoningAdjusted: z.boolean().default(false),
    createdAt: z.string().datetime(),
  });

export const chatRelocationStateSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const chatRelocationErrorCodeSchema = z.enum([
  "target-not-found",
  "target-mismatch",
  "worker-offline",
  "capability-missing",
  "replica-not-ready",
  "worktree-dirty",
  "revision-diverged",
  "attachment-unavailable",
  "runtime-incompatible",
  "stale-attempt",
  "policy-denied",
  "worker-error",
]);

export const chatRelocationErrorSchema = z.object({
  code: chatRelocationErrorCodeSchema,
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const chatRelocationJobErrorSchema = chatRelocationErrorSchema.omit({
  message: true,
});

export const chatRelocationProgressStageSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "recovering",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

export const chatRelocationProgressSchema = z.object({
  stage: chatRelocationProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatRelocationContextMessageSchema = z.object({
  sequence: z.number().int().positive(),
  role: chatMessageRoleSchema,
  mode: chatTurnModeSchema,
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  content: chatMessageContentSchema,
  createdAt: z.string().datetime(),
});

export const taskRelocationContextMessageSchema =
  taskMessageOpaqueSummarySchema;

export const chatRelocationAttachmentAvailabilitySchema = z.object({
  attachment: chatAttachmentOpaqueSummarySchema,
  sourceWorkerId: z.string().min(1).max(200),
  availableWorkerIds: z.array(z.string().min(1).max(200)).max(1_000),
});

export const chatRelocationContextPayloadSchema = z.union([
  z.object({
    version: z.literal(1),
    kind: z.literal("visible").default("visible"),
    messages: z.array(chatRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("task-encrypted"),
    messages: z.array(taskRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("chat-encrypted"),
    messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
]);

export const chatRelocationSnapshotSummarySchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().min(1),
  sourcePlacement: executionPlacementSchema,
  throughSequence: z.number().int().nonnegative(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  messageCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  modelId: z.string().min(1).nullable(),
  modelRouteId: z.string().min(1).nullable(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  requiredRevision: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40,64}$/u),
  createdAt: z.string().datetime(),
});

export const chatRelocationHydrationBeginResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("upload") }),
    z.object({
      status: z.literal("hydrated"),
      threadId: z.string().min(1),
    }),
  ],
);

export const chatRelocationHydrationResultSchema = z.object({
  snapshotId: z.string().uuid(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  threadId: z.string().min(1),
  reused: z.boolean(),
});

export const chatRelocationJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  chatId: z.string().min(1),
  state: chatRelocationStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  sourcePlacement: executionPlacementSchema,
  sourcePlacementRevision: z.number().int().positive(),
  targetPlacement: executionPlacementSchema,
  contextSnapshotId: z.string().uuid(),
  targetRuntimeThreadId: z.string().min(1).nullable(),
  targetModelRouteId: z.string().min(1).nullable(),
  targetProviderAccountId: z.string().min(1).nullable().default(null),
  attempt: z.number().int().nonnegative(),
  progress: chatRelocationProgressSchema,
  error: chatRelocationJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancellationUnsafeAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatRelocationJobListSchema = z
  .array(chatRelocationJobSummarySchema)
  .max(1_000);

export const chatRelocationCreateSchema = z.object({
  target: executionTargetSchema,
  approved: z.literal(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const chatRelocationJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const chatRelocationJobCancelSchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const chatExecutionLaneActorSchema = z.enum(["agent", "user"]);
export const chatExecutionLaneStateSchema = z.enum([
  "active",
  "suspended",
  "delivering",
  "released",
]);
export const chatExecutionLaneSummarySchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  worktreeId: z.string().min(1),
  workerId: z.string().min(1),
  acquiringActor: chatExecutionLaneActorSchema,
  exclusive: z.boolean(),
  purpose: z.string().min(1).nullable(),
  state: chatExecutionLaneStateSchema,
  baseRevision: z.string().min(1).nullable(),
  startingHead: z.string().min(1).nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  codexThreadId: z.string().min(1).nullable(),
  transitionKind: z.enum(["switch", "release"]).nullable(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const chatExecutionLaneListSchema = z.array(
  chatExecutionLaneSummarySchema,
);

export const chatExecutionLaneReleaseSchema = z.object({
  allowDirty: z.boolean().default(false),
  returnToPrimary: z.boolean().default(true),
});

export const agentInteractionRequestKindSchema = z.enum([
  "commandExecution",
  "fileChange",
  "permissions",
  "userInput",
  "mcpElicitation",
]);

export const agentInteractionRequestStatusSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "interrupted",
]);

export const agentInteractionProvenanceSchema = z.object({
  chatId: z.string().min(1).nullable(),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  executionLaneId: z.string().min(1).nullable(),
  workflowRunId: z.string().min(1).nullable(),
  workflowNodeId: z.string().min(1).nullable(),
  workerId: z.string().min(1),
});

export const agentInteractionRequestPayloadSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("commandExecution"),
      startedAtMs: z.number().int().nonnegative(),
      approvalId: z.string().min(1).nullable(),
      environmentId: z.string().min(1).nullable(),
      reason: z.string().nullable(),
      command: z.string().nullable(),
      cwd: z.string().nullable(),
      commandActions: z.json().nullable().optional(),
      networkApprovalContext: z
        .object({
          host: z.string().min(1),
          protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
        })
        .nullable(),
      additionalPermissions: z.json().nullable(),
      proposedExecpolicyAmendment: z.array(z.string()).nullable(),
      proposedNetworkPolicyAmendments: z
        .array(
          z.object({
            host: z.string().min(1),
            action: z.enum(["allow", "deny"]),
          }),
        )
        .nullable(),
      availableDecisions: z
        .array(
          z.enum([
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
          ]),
        )
        .nullable(),
    }),
    z.object({
      kind: z.literal("fileChange"),
      startedAtMs: z.number().int().nonnegative(),
      reason: z.string().nullable(),
      grantRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("permissions"),
      startedAtMs: z.number().int().nonnegative(),
      environmentId: z.string().min(1).nullable(),
      cwd: z.string().min(1),
      reason: z.string().nullable(),
      requestedPermissions: z.json(),
    }),
    z.object({
      kind: z.literal("userInput"),
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            header: z.string().min(1),
            question: z.string().min(1),
            isOther: z.boolean(),
            isSecret: z.boolean(),
            options: z
              .array(
                z.object({
                  label: z.string().min(1),
                  description: z.string(),
                }),
              )
              .nullable(),
          }),
        )
        .min(1)
        .max(3),
      autoResolutionMs: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("mcpElicitation"),
      serverName: z.string().min(1),
      mode: z.enum(["form", "openai/form", "url"]),
      message: z.string().min(1),
      requestedSchema: z.json().nullable(),
      url: z.url().nullable(),
      elicitationId: z.string().min(1).nullable(),
      metadata: z.json().nullable(),
    }),
  ],
);

export const agentInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commandExecution"),
    decision: z.enum([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]),
    execpolicyAmendment: z.array(z.string()).nullable().default(null),
    networkPolicyAmendment: z
      .object({
        host: z.string().min(1),
        action: z.enum(["allow", "deny"]),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal("fileChange"),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  z.object({
    kind: z.literal("permissions"),
    permissions: z.json(),
    scope: z.enum(["turn", "session"]),
    strictAutoReview: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("userInput"),
    answers: z.record(
      z.string().min(1),
      z.object({ answers: z.array(z.string()).min(1) }),
    ),
  }),
  z.object({
    kind: z.literal("mcpElicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.json().nullable(),
    metadata: z.json().nullable().default(null),
  }),
]);

function fitsAgentInteractionStorageLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= 1_000_000;
  } catch {
    return false;
  }
}

export const agentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction request exceeds the 1 MB storage limit.",
  });

export const agentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction response exceeds the 1 MB storage limit.",
  });

export const encryptedAgentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction request exceeds the storage limit.",
  });

export const encryptedAgentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    ...interactionResponseOpaqueContentSchema.shape,
  })
  .strict()
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction response exceeds the storage limit.",
  });

export const agentInteractionRuntimeRequestSchema = z.object({
  requestKey: z.string().min(1).max(200),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  payload: agentInteractionRequestPayloadSchema,
  expiresAt: z.string().datetime(),
});

export const encryptedAgentInteractionRuntimeRequestSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    threadId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    itemId: z.string().min(1).nullable(),
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const agentInteractionAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const agentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    status: agentInteractionRequestStatusSchema,
    response: agentInteractionResponseSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((request, context) => {
    if (request.response && request.response.kind !== request.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["response", "kind"],
        message: "Response kind must match request kind.",
      });
    }
    const terminalWithoutResponse =
      request.status === "expired" || request.status === "interrupted";
    if (request.status === "pending") {
      if (request.response || request.resolvedByUserId || request.resolvedAt) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
    } else if (request.status === "resolved") {
      if (
        !request.response ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require response and resolution data.",
        });
      }
    } else if (
      terminalWithoutResponse &&
      (request.response || request.resolvedByUserId || !request.resolvedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestListSchema = z.array(
  agentInteractionRequestSchema,
);

export const encryptedAgentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    classification: interactionProtectedClassificationSchema,
    protectedPayload:
      interactionRequestOpaqueContentSchema.shape.protectedPayload,
    status: agentInteractionRequestStatusSchema,
    protectedResponse: encryptedInteractionResponseContentSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.status === "pending") {
      if (
        request.protectedResponse ||
        request.resolvedByUserId ||
        request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
      return;
    }
    if (request.status === "resolved") {
      if (
        !request.protectedResponse ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require protected resolution data.",
        });
      }
      return;
    }
    if (
      request.protectedResponse ||
      request.resolvedByUserId ||
      !request.resolvedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestWireSchema = z.union([
  agentInteractionRequestSchema,
  encryptedAgentInteractionRequestSchema,
]);

export const agentInteractionRequestWireListSchema = z.array(
  agentInteractionRequestWireSchema,
);

export const agentInteractionResolutionWireCreateSchema = z.union([
  agentInteractionResolutionCreateSchema,
  encryptedAgentInteractionResolutionCreateSchema,
]);

export const agentInteractionRequestQuerySchema = z.object({
  chatId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  status: agentInteractionRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const cantripCliArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 20, {
    message: "Cantrip CLI commands accept at most 20 arguments.",
  });

export const cantripAgentOperationNameSchema = z.enum([
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-config.list",
  "run-config.read",
  "run-config.schema",
  "run-config.action-add",
  "run-config.authoring",
  "run-config.write",
  "run.start",
  "run.open",
  "run.setup-status",
  "run.setup-retry",
  "run.status",
  "run.read",
  "run.stop",
  "worktree.list",
  "worktree.status",
  "worktree.create",
  "worktree.acquire",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "browser.services",
  "browser.open",
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
]);

export const CANTRIP_MCP_READ_OPERATIONS = [
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-config.list",
  "run-config.read",
  "run-config.schema",
  "run.setup-status",
  "run.status",
  "run.read",
  "worktree.list",
  "worktree.status",
  "explorer.list",
  "explorer.read",
  "terminal.read",
  "browser.services",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_READ_TOOL_NAMES = [
  "context_get",
  "tool_help",
  "policy_list",
  "policy_read",
  "target_list",
  "target_inspect",
  "run_config_list",
  "run_config_read",
  "run_config_schema",
  "run_setup_status",
  "run_status",
  "run_read",
  "worktree_list",
  "worktree_status",
  "explorer_list",
  "explorer_read",
  "terminal_read",
  "browser_services",
] as const;

export const CANTRIP_MCP_WORKER_MUTATION_OPERATIONS = [
  "run-config.action-add",
  "run.start",
  "run.open",
  "run.setup-retry",
  "run.stop",
  "worktree.create",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.write",
  "terminal.send",
  "terminal.restart",
  "browser.open",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS = [
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_MUTATION_OPERATIONS = [
  ...CANTRIP_MCP_WORKER_MUTATION_OPERATIONS,
  ...CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
] as const;

export const CANTRIP_MCP_MUTATION_TOOL_NAMES = [
  "run_config_action_add",
  "run_start",
  "run_open",
  "run_setup_retry",
  "run_stop",
  "worktree_create",
  "worktree_switch",
  "worktree_release",
  "worktree_remove",
  "explorer_write",
  "terminal_send",
  "terminal_restart",
  "browser_navigate",
  "client_notify",
  "client_focus_project",
  "client_focus_surface",
  "client_show_interaction",
] as const;

export const CANTRIP_MCP_OPERATIONS = [
  ...CANTRIP_MCP_READ_OPERATIONS,
  ...CANTRIP_MCP_MUTATION_OPERATIONS,
] as const;

export const CANTRIP_MCP_TOOL_NAMES = [
  ...CANTRIP_MCP_READ_TOOL_NAMES,
  ...CANTRIP_MCP_MUTATION_TOOL_NAMES,
] as const;

export const cantripMcpToolNameSchema = z.enum(CANTRIP_MCP_TOOL_NAMES);

export function cantripMcpToolNamesForOperations(
  operations: readonly z.infer<typeof cantripAgentOperationNameSchema>[],
): Array<(typeof CANTRIP_MCP_TOOL_NAMES)[number]> {
  const allowed = new Set<string>(operations);
  return CANTRIP_MCP_OPERATIONS.flatMap((operation, index) =>
    allowed.has(operation) ? [CANTRIP_MCP_TOOL_NAMES[index]!] : [],
  );
}

export function isCantripMcpMutationOperation(
  operation: z.infer<typeof cantripAgentOperationNameSchema>,
): boolean {
  return (CANTRIP_MCP_MUTATION_OPERATIONS as readonly string[]).includes(
    operation,
  );
}

export function cantripMcpOperationsForPermissionProfile(
  permissionProfileId: string,
): readonly z.infer<typeof cantripAgentOperationNameSchema>[] {
  return permissionProfileId === ":read-only"
    ? CANTRIP_MCP_READ_OPERATIONS
    : CANTRIP_MCP_OPERATIONS;
}

export const cantripAgentOperationArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 32, {
    message: "Cantrip agent operations accept at most 32 arguments.",
  });

export const cantripAgentOperationRequestSchema = z
  .object({
    operation: cantripAgentOperationNameSchema,
    arguments: cantripAgentOperationArgumentsSchema,
  })
  .strict();

const cantripMcpBindingFields = {
  bindingId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  executionLaneId: z.string().min(1).max(200),
  workerId: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200),
  rootKind: projectRootKindSchema,
  permissionProfileId: permissionProfileIdSchema,
  allowedOperations: z
    .array(cantripAgentOperationNameSchema)
    .min(1)
    .max(cantripAgentOperationNameSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, {
      message: "Cantrip MCP binding operations must be unique.",
    }),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};

export const cantripMcpBindingSchema = z
  .object(cantripMcpBindingFields)
  .strict()
  .superRefine((binding, context) => {
    const issuedAt = Date.parse(binding.issuedAt);
    const expiresAt = Date.parse(binding.expiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings must expire after they are issued.",
      });
    }
    if (expiresAt - issuedAt > 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings cannot live longer than 24 hours.",
      });
    }
  });

export const cantripMcpConnectionDocumentSchema = z
  .object({
    protocolVersion: z.literal(1),
    endpoint: z.url(),
    bindingId: z.string().uuid(),
    credential: z.string().min(32).max(512),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const cantripMcpBrokerOperationRequestSchema = z
  .object({
    bindingId: z.string().uuid(),
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

export const workerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: cantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

const compatibleCantripMcpBindingSchema = z.object({
  ...cantripMcpBindingFields,
  canonicalRoot: z.string().min(1).max(8_192).optional(),
  allowedOperations: z.array(z.string().min(1).max(100)).min(1).max(100),
});

/**
 * Accepts both the current binding and the legacy binding used during rolling
 * worker/server upgrades. Unknown binding claims never grant authority: they
 * are discarded, and only locally known operation names survive normalization.
 */
export const compatibleWorkerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: compatibleCantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict()
  .transform(({ binding, ...call }) => {
    const {
      canonicalRoot: _legacyCanonicalRoot,
      allowedOperations,
      ...currentBinding
    } = binding;
    return {
      ...call,
      binding: {
        ...currentBinding,
        allowedOperations: allowedOperations.filter(
          (operation) =>
            cantripAgentOperationNameSchema.safeParse(operation).success,
        ),
      },
    };
  })
  .pipe(workerCantripMcpOperationCallSchema);

export const CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS = [1, 2] as const;

export const workerCantripMcpCapabilitiesQuerySchema = z
  .object({
    workerId: z.string().min(1).max(200),
  })
  .strict();

export const workerCantripMcpServerCapabilitiesSchema = z
  .object({
    bindingProtocolVersions: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .max(10)
      .refine((versions) => new Set(versions).size === versions.length, {
        message: "Cantrip MCP binding protocol versions must be unique.",
      }),
    operations: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(100)
      .refine((operations) => new Set(operations).size === operations.length, {
        message: "Cantrip MCP server operations must be unique.",
      }),
  })
  .strict();

export const cantripAgentOperationResultSchema = z.object({
  summary: z.string().min(1).max(2_000),
  target: executionTargetSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable().default(null),
  continuationScheduled: z.boolean().default(false),
  mutated: z.boolean().default(false),
  data: z.unknown().optional(),
});

const cantripMcpReadResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema.nullable().default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(false).default(false),
  })
  .strict();

export const cantripMcpContextGetInputSchema = z.object({}).strict();
export const cantripMcpToolHelpInputSchema = z
  .object({ tool: cantripMcpToolNameSchema })
  .strict();
export const cantripMcpBindingStaleClaimSchema = z.enum([
  "chat",
  "project",
  "worker",
  "execution-lane",
  "worktree",
  "root-kind",
  "permission-profile",
  "chat-status",
]);
export const cantripMcpBindingReadinessSchema = z
  .object({
    status: z.enum(["ready", "read-only", "refresh-required"]),
    mutationReady: z.boolean(),
    staleClaims: z.array(cantripMcpBindingStaleClaimSchema).max(8),
    recoveryInstruction: z.string().min(1).max(500).nullable(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const cantripMcpPolicyListInputSchema = z.object({}).strict();
export const cantripMcpPolicyReadInputSchema = z
  .object({ key: policyKeySchema })
  .strict();
export const cantripMcpTargetListInputSchema = z
  .object({
    kind: executionTargetResourceKindSchema.optional(),
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpTargetInspectInputSchema = z
  .object({ target: executionTargetSchema })
  .strict();
export const cantripMcpRunConfigListInputSchema = z.object({}).strict();
export const cantripMcpRunConfigSchemaInputSchema = z.object({}).strict();
export const cantripMcpRunConfigReadInputSchema = z
  .object({
    actionId: runConfigurationActionSchema.shape.id,
    configRevision: runConfigurationDefinitionSchema.shape.revision,
  })
  .strict();
export const cantripMcpRunConfigActionAddInputSchema =
  runConfigurationActionAddInputSchema;
export const cantripMcpRunSetupStatusInputSchema = z.object({}).strict();
export const cantripMcpRunStatusInputSchema = z
  .object({ runId: runInstanceSchema.shape.id.optional() })
  .strict();
export const cantripMcpRunReadInputSchema = z
  .object({
    runId: runInstanceSchema.shape.id,
    maxChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
export const cantripMcpWorktreeListInputSchema = z
  .object({
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
    includeLeaseHistory: z.boolean().default(false),
  })
  .strict();
export const cantripMcpWorktreeStatusInputSchema = z
  .object({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    fileLimit: z.number().int().min(1).max(2_000).default(500),
    branchLimit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

const cantripMcpSurfaceTargetSchema = <
  Kind extends "browser" | "explorer" | "terminal",
>(
  kind: Kind,
) =>
  z
    .object({
      kind: z.literal("surface"),
      projectId: z.string().min(1).max(200),
      surfaceKind: z.literal(kind),
      surfaceId: z.string().min(1).max(200),
    })
    .strict();

export const cantripMcpExplorerListInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().max(8_192).default(""),
    cursor: z.number().int().min(0).max(999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpExplorerReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().min(1).max(8_192),
    maxChars: z.number().int().min(1).max(200_000).default(100_000),
  })
  .strict();
export const cantripMcpTerminalReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    maxChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
export const cantripMcpBrowserServicesInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("browser") })
  .strict();

const cantripMcpWorktreeTargetSchema = z
  .object({
    kind: z.literal("worktree"),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
  })
  .strict();

export const cantripMcpWorktreeCreateInputSchema = z.discriminatedUnion(
  "intent",
  [
    z
      .object({
        intent: z.literal("newBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .optional()
          .describe(
            "Optional starting revision; matches CLI --base-revision (legacy alias --from).",
          ),
      })
      .strict(),
    z
      .object({
        intent: z.literal("existingBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
      })
      .strict(),
    z
      .object({
        intent: z.literal("detached"),
        name: z.string().trim().min(1).max(200),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .describe(
            "Required detached revision; CLI expresses this variant with --detach.",
          ),
      })
      .strict(),
  ],
);
export const cantripMcpWorktreeSwitchInputSchema = z
  .object({
    target: cantripMcpWorktreeTargetSchema,
    purpose: z.string().trim().min(1).max(500),
  })
  .strict();
export const cantripMcpWorktreeReleaseInputSchema = z
  .object({ purpose: z.string().trim().min(1).max(500) })
  .strict();
export const cantripMcpWorktreeRemoveInputSchema = z
  .object({ target: cantripMcpWorktreeTargetSchema })
  .strict();
export const cantripMcpRunStartInputSchema = z
  .object({
    actionId: runConfigurationActionSchema.shape.id,
    configRevision: runConfigurationDefinitionSchema.shape.revision,
    focus: z.boolean().default(true),
  })
  .strict();
export const cantripMcpRunOpenInputSchema = z
  .object({
    runId: runInstanceSchema.shape.id,
    focus: z.boolean().default(true),
  })
  .strict();
export const cantripMcpRunStopInputSchema = z
  .object({ runId: runInstanceSchema.shape.id })
  .strict();
export const cantripMcpRunSetupRetryInputSchema = z.object({}).strict();
export const cantripMcpExplorerWriteInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: explorerFileWriteSchema.shape.path,
    content: z.string().max(200_000),
    version: explorerFileWriteSchema.shape.version,
  })
  .strict();
export const cantripMcpTerminalSendInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.string().max(100_000),
  })
  .strict();
export const cantripMcpTerminalRestartInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("terminal") })
  .strict();
export const cantripMcpBrowserNavigateInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("browser"),
    url: browserHttpUrlSchema,
  })
  .strict();
export const cantripMcpClientNotifyInputSchema = z
  .object({
    level: z.enum(["info", "warning", "error"]).default("info"),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const cantripMcpClientFocusProjectInputSchema = z.object({}).strict();
export const cantripMcpClientSurfaceTargetSchema = z.discriminatedUnion(
  "surfaceKind",
  [
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("terminal"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("explorer"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("code"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("browser"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export const cantripMcpClientFocusSurfaceInputSchema = z
  .object({ target: cantripMcpClientSurfaceTargetSchema })
  .strict();
export const cantripMcpClientShowInteractionInputSchema = z
  .object({ interactionId: z.string().min(1).max(200) })
  .strict();

export const cantripMcpContextGetResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        worker: z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            online: z.boolean(),
          })
          .strict(),
        context: z
          .object({
            chatId: z.string().min(1).max(200).nullable(),
            executionLaneId: z.string().min(1).max(200).nullable(),
            permissionProfileId: permissionProfileIdSchema.nullable(),
            projectId: z.string().min(1).max(200),
            rootKind: projectRootKindSchema,
            terminalId: z.string().min(1).max(200).nullable(),
            workerId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
            worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
          })
          .strict(),
        binding: cantripMcpBindingReadinessSchema,
      })
      .strict(),
  });
export const cantripMcpToolHelpResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        tool: cantripMcpToolNameSchema,
        inputSchema: z.record(z.string(), z.unknown()),
        examples: z.array(z.record(z.string(), z.unknown())).max(3),
        notes: z.array(z.string().min(1).max(500)).max(8),
      })
      .strict(),
  })
  .strict();
export const cantripMcpPolicyListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliListResultSchema,
  });
export const cantripMcpPolicyReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliReadResultSchema,
  });
export const cantripMcpTargetListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        projectId: z.string().min(1).max(200),
        targets: z.array(executionTargetDescriptorSchema).max(200),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpTargetInspectResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: executionTargetSchema,
    data: executionTargetResolutionSchema
      .extend({
        stateRevision: z.number().int().positive().nullable(),
      })
      .strict(),
  });
export const cantripMcpRunConfigListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationInspectionSchema,
  });
export const cantripMcpRunConfigReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationSelectionSchema,
  });
export const cantripMcpRunConfigSchemaResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationAuthoringHelpSchema,
  });
export const cantripMcpRunSetupStatusResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runSetupStatusResultSchema,
  });
export const cantripMcpRunStatusResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runInstanceResultSchema,
  });
export const cantripMcpRunReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    worktreeId: z.string().min(1).max(200),
    data: runLogResultSchema,
  });

export const cantripMcpWorktreeSummarySchema = projectWorktreeSummarySchema
  .omit({ path: true, displayPath: true })
  .strict();
export const cantripMcpWorktreeListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        currentWorktreeId: z.string().min(1).max(200),
        worktrees: z.array(cantripMcpWorktreeSummarySchema).max(200),
        leases: z.array(chatExecutionLaneSummarySchema).max(1_000),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: z
      .object({
        path: z.string().max(8_192),
        entries: z.array(explorerEntrySchema).max(200),
        cursor: z.number().int().min(0).max(999),
        nextCursor: z.number().int().positive().max(1_000).nullable(),
        total: z.number().int().nonnegative().max(1_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.extend({
      content: z.string().max(200_000),
      truncated: z.boolean(),
    }),
  });
export const cantripMcpTerminalReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z
      .object({
        status: z.enum(["running", "restarting", "exited", "not-running"]),
        data: z.string().max(100_000),
        truncated: z.boolean(),
        exitCode: z.number().int().nullable(),
      })
      .strict(),
  });
export const cantripMcpBrowserServicesResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: browserServiceListSchema,
  });

const cantripMcpMutationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(true),
  })
  .strict();
const cantripMcpContinuationResultBaseSchema =
  cantripMcpMutationResultBaseSchema.extend({
    continuationScheduled: z.literal(true),
  });
const cantripMcpTransitionDataSchema = z
  .object({
    lane: z
      .object({
        id: z.string().min(1).max(200),
        state: chatExecutionLaneStateSchema,
        transitionKind: z.enum(["switch", "release"]),
      })
      .strict(),
    worktree: cantripMcpWorktreeSummarySchema,
  })
  .strict();

export const cantripMcpWorktreeCreateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z.object({ worktree: cantripMcpWorktreeSummarySchema }).strict(),
  });
export const cantripMcpRunConfigActionAddResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationAuthoringSnapshotSchema,
  });
export const cantripMcpWorktreeSwitchResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeReleaseResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeRemoveResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z
      .object({
        removedWorktreeId: z.string().min(1).max(200),
        branchRetained: z.literal(true),
      })
      .strict(),
  });
const cantripMcpRunMutationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
  })
  .strict();
export const cantripMcpRunStartResultSchema =
  cantripMcpRunMutationResultBaseSchema.extend({
    data: runStartResultSchema,
  });
export const cantripMcpRunOpenResultSchema =
  cantripMcpRunMutationResultBaseSchema.extend({
    data: runStartResultSchema,
  });
export const cantripMcpRunStopResultSchema =
  cantripMcpRunMutationResultBaseSchema.extend({
    data: runInstanceResultSchema,
  });
export const cantripMcpRunSetupRetryResultSchema =
  cantripMcpRunMutationResultBaseSchema.extend({
    data: runSetupStatusResultSchema,
  });
export const cantripMcpExplorerWriteResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.omit({ content: true }).strict(),
  });
export const cantripMcpTerminalSendResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ accepted: z.literal(true) }).strict(),
  });
export const cantripMcpTerminalRestartResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ status: z.literal("running") }).strict(),
  });
export const cantripMcpBrowserNavigateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: z
      .object({
        url: browserHttpUrlSchema,
        stateRevision: z.number().int().positive().safe(),
      })
      .strict(),
  });

const cantripMcpClientControlDataSchema = z
  .object({
    correlationId: z.string().uuid(),
    status: clientControlResultStatusSchema,
  })
  .strict();
const cantripMcpClientControlResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
    data: cantripMcpClientControlDataSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.mutated === (result.data.status === "applied")) return;
    context.addIssue({
      code: "custom",
      path: ["mutated"],
      message: "Client-control mutation state must match its applied status.",
    });
  });
export const cantripMcpClientNotifyResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("project"),
        projectId: z.string().min(1).max(200),
      })
      .strict(),
  });
export const cantripMcpClientFocusProjectResultSchema =
  cantripMcpClientNotifyResultSchema;
export const cantripMcpClientFocusSurfaceResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: cantripMcpClientSurfaceTargetSchema,
  });
export const cantripMcpClientShowInteractionResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  });

// The human CLI is a compatibility adapter over the same operation result
// contract used by worker-owned agent transports.
export const cantripCliCommandResultSchema = cantripAgentOperationResultSchema;

export const cantripCliCommandNameSchema = z.enum([
  "status",
  "policy.list",
  "policy.read",
  "worktree.list",
  "worktree.create",
  "worktree.switch",
  "worktree.status",
  "worktree.release",
  "worktree.remove",
  "target.list",
  "target.show",
  "run.list",
  "run.show",
  "run.validate",
  "run.config-path",
  "run.config-schema",
  "run.config-example",
  "run.config-init",
  "run.config-action-add",
  "run.start",
  "run.open",
  "run.setup-status",
  "run.setup-retry",
  "run.status",
  "run.logs",
  "run.stop",
  "target.resolve-browser",
  "target.resolve-explorer",
  "target.resolve-terminal",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "browser.services",
  "browser.create",
  "browser.open",
]);

export const cantripCliContextSchema = z
  .object({
    codexThreadId: z.string().min(1).max(200).nullable().default(null),
    terminalId: z.string().min(1).max(200).nullable().default(null),
    cwd: z.string().min(1).max(8_192).nullable().default(null),
    selection: z.enum(["auto", "cwd", "lane"]).default("auto"),
  })
  .strict();

export const cantripCliCommandRequestSchema = z
  .object({
    command: cantripCliCommandNameSchema,
    context: cantripCliContextSchema,
    arguments: cantripCliArgumentsSchema,
  })
  .strict();

export const workerCliCommandCallSchema = cantripCliCommandRequestSchema
  .extend({
    chatContext: z
      .object({
        chatId: z.string().min(1).max(200),
        executionLaneId: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
    requestId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
  })
  .strict();

export const chatMessageListSchema = z.array(chatMessageSchema);

export const CHAT_MESSAGE_PAGE_DEFAULT_LIMIT = 150;
export const CHAT_MESSAGE_PAGE_MAX_LIMIT = 200;
export const CHAT_MESSAGE_PAGE_BOUNDARY_MAX = 500;

export const chatMessagePageQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CHAT_MESSAGE_PAGE_MAX_LIMIT)
      .default(CHAT_MESSAGE_PAGE_DEFAULT_LIMIT),
  })
  .strict();

export const chatMessagePageInfoSchema = z
  .object({
    hasMore: z.boolean(),
    nextBeforeSequence: z.number().int().positive().nullable(),
    oldestSequence: z.number().int().positive().nullable(),
    newestSequence: z.number().int().positive().nullable(),
    startsAtUserTurn: z.boolean(),
  })
  .strict();

export const chatMessageWireListSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z.array(taskMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
]);

export const chatMessageWirePageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z
        .array(taskMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z
        .array(chatMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
]);

export const encryptedQueuedPromptSchema = queuedPromptOpaqueContentSchema
  .extend({
    chatId: z.string().min(1).max(200),
    attachments: chatAttachmentOpaqueListSchema.default([]),
    position: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const encryptedQueuedPromptListSchema = z
  .array(encryptedQueuedPromptSchema)
  .max(1_000);

export const encryptedChatTurnCreateSchema = z
  .object({
    message: chatMessageOpaqueContentSchema,
    queuedPrompt: queuedPromptOpaqueContentSchema,
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.message) !==
      JSON.stringify(value.queuedPrompt.pendingMessage)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The queued prompt must carry the submitted encrypted message.",
        path: ["queuedPrompt", "pendingMessage"],
      });
    }
    if (
      value.modelId !== undefined &&
      value.modelId !== value.queuedPrompt.modelId
    ) {
      context.addIssue({
        code: "custom",
        message: "The queued prompt model must match the submitted model.",
        path: ["queuedPrompt", "modelId"],
      });
    }
  });

export const projectAutomationProtectedDispatchResultSchema = z
  .object({
    allowed: z.boolean(),
    protectedTurn: encryptedChatTurnCreateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowed !== Boolean(value.protectedTurn)) {
      context.addIssue({
        code: "custom",
        message: "Allowed automation dispatches require a protected turn.",
        path: ["protectedTurn"],
      });
    }
  });

export const encryptedQueuedPromptUpdateSchema = z
  .object({ prompt: queuedPromptOpaqueContentSchema })
  .strict();

export const encryptedChatPromptSubmitResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("started"),
        message: chatMessageOpaqueSummarySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("queued"),
        prompt: encryptedQueuedPromptSchema,
      })
      .strict(),
  ],
);

export const chatTurnCreateSchema = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    attachmentIds: z.array(z.string().min(1)).max(20).default([]),
    mode: chatTurnModeSchema.default("default"),
    idempotencyKey: z.string().min(1).max(200),
    modelId: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
  })
  .refine(
    ({ attachmentIds, text }) => text.length > 0 || attachmentIds.length > 0,
    { message: "A prompt needs text or at least one attachment." },
  )
  .refine(({ mode, text }) => mode !== "goal" || text.length > 0, {
    message: "Goal mode needs a text objective.",
  });

export const queuedPromptSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  text: z.string().trim().max(100_000),
  attachments: chatAttachmentListSchema.default([]),
  mode: chatTurnModeSchema.default("default"),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  customSubagentModel: z.boolean().default(false),
  subagentModelId: z.string().min(1).nullable().default(null),
  subagentReasoningEffort: reasoningEffortSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  frozen: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const queuedPromptListSchema = z.array(queuedPromptSchema);

export const queuedPromptCreateSchema = chatTurnCreateSchema.extend({
  frozen: z.boolean().default(false),
  worktreeId: z.string().min(1).nullable().default(null),
});

export const queuedPromptUpdateSchema = z
  .object({
    text: z.string().trim().max(100_000).optional(),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
    mode: chatTurnModeSchema.optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    frozen: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.text !== undefined ||
      value.attachmentIds !== undefined ||
      value.mode !== undefined ||
      value.reasoningEffort !== undefined ||
      value.frozen !== undefined,
    { message: "At least one queued prompt field is required." },
  );

export const queuedPromptOrderSchema = z.object({
  ids: z.array(z.string().min(1)).max(1_000),
});

export const chatModelUpdateSchema = z.object({
  modelId: z.string().min(1),
});

export const chatModelConfigurationUpdateSchema =
  modelConfigurationSchema.refine(
    (configuration) => configuration.modelId !== null,
    {
      message: "A root model must be selected.",
      path: ["modelId"],
    },
  );

export const chatReasoningOptionSchema = modelReasoningEffortOptionSchema;

export const chatReasoningStateSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  options: z.array(chatReasoningOptionSchema).max(32),
  reasoningMandatory: z.boolean(),
  incompleteMetadata: z.boolean(),
});

export const chatReasoningUpdateSchema = z.object({
  reasoningEffort: reasoningEffortSchema.nullable(),
});

export const chatTurnAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: chatMessageSchema,
});

export const chatPromptSubmitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), message: chatMessageSchema }),
  z.object({ status: z.literal("queued"), prompt: queuedPromptSchema }),
]);

export const chatPromptSteerResultSchema = z.object({
  steered: z.literal(true),
  message: chatMessageSchema,
});

export const encryptedChatPromptSteerResultSchema = z
  .object({
    steered: z.literal(true),
    message: chatMessageOpaqueSummarySchema,
  })
  .strict();

export const chatCompactAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const chatInterruptAcceptedSchema = z.object({
  interrupted: z.boolean(),
});

export const chatTurnRollbackAcceptedSchema = z.object({
  rolledBack: z.literal(true),
});

export const chatPauseUpdateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseStateSchema = z.object({
  paused: z.boolean(),
});

export const threadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const threadGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1),
  status: threadGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatGoalResponseSchema = z.object({
  goal: threadGoalSchema.nullable(),
});

export const chatGoalWireResponseSchema = z.union([
  z
    .object({
      kind: z.literal("task-encrypted"),
      goal: taskGoalObjectiveOpaqueSnapshotSchema.nullable(),
    })
    .strict(),
  chatGoalResponseSchema,
]);

export const chatGoalCreateSchema = z.object({
  objective: z.string().trim().min(1).max(100_000),
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export const chatGoalUpdateSchema = z.object({
  status: z.enum(["active", "paused"]),
});

export const chatGoalClearSchema = z.object({
  cleared: z.boolean(),
});

export const planModeSchema = z.enum(["default", "plan"]);

export const planStepSchema = z.object({
  step: z.string().min(1),
  status: z.enum(["pending", "inProgress", "completed"]),
});

export const planQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});

export const planQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(planQuestionOptionSchema).min(1).nullable(),
});

export const pendingPlanQuestionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(planQuestionSchema).min(1).max(3),
  createdAt: z.string().datetime(),
});

export const chatPlanStateSchema = z.object({
  mode: planModeSchema,
  explanation: z.string().nullable(),
  steps: z.array(planStepSchema),
  question: pendingPlanQuestionSchema.nullable(),
});

export const encryptedChatPlanWireStateSchema = z
  .object({
    kind: z.literal("chat-encrypted"),
    chatId: z.string().min(1).max(200),
    mode: planModeSchema,
    hasQuestion: z.boolean(),
    state: chatPlanOpaqueStateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state &&
      value.state.classification.hasQuestion !== value.hasQuestion
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted plan question metadata is inconsistent.",
        path: ["state", "classification", "hasQuestion"],
      });
    }
    if (!value.state && value.hasQuestion) {
      context.addIssue({
        code: "custom",
        message: "Pending encrypted plans require protected state.",
        path: ["state"],
      });
    }
  });

export const chatPlanUpdateSchema = z.object({ mode: planModeSchema });

export const chatPlanAnswerSchema = z.object({
  answers: z.record(
    z.string().min(1),
    z.array(z.string().trim().min(1).max(10_000)).min(1).max(16),
  ),
});

export const chatPlanAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestKey: z.string().min(1).optional(),
});

export const githubWorkerRepositorySchema = githubRepositorySchema.omit({
  imported: true,
});

export const githubWorkerRepositoryListSchema = z.array(
  githubWorkerRepositorySchema,
);

export const projectCloneResultSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean().default(false),
  updated: z.boolean().default(false),
  warning: z.string().min(1).nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const managedFolderMaterializeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean(),
});

export const managedFolderDeleteResultSchema = z.object({
  deleted: z.boolean(),
});

export const projectFolderSetupJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectFolderSetupJobErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "materialization-failed",
  ]),
  retryable: z.boolean(),
});

export const projectFolderSetupJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  state: projectFolderSetupJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  error: projectFolderSetupJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectFolderSetupRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "project-not-ready",
    "transition-active",
    "repository-collision",
    "github-auth-required",
    "repository-unavailable",
    "repository-not-empty",
    "local-git-ambiguous",
    "preflight-changed",
    "initial-commit-required",
    "git-initialization-failed",
    "commit-failed",
    "push-failed",
    "reconciliation-failed",
  ]),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const projectGithubConversionJobErrorSchema =
  projectGithubConversionErrorSchema.omit({ message: true });

const projectGithubConversionPreflightBaseSchema = z.object({
  projectId: z.string().uuid(),
  repository: projectGithubWireRepositorySchema,
});

export const projectGithubConversionPreflightReadySchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("ready"),
    confirmationToken: z.string().regex(/^[0-9a-f]{64}$/u),
    localState: z.enum(["not-initialized", "unborn", "committed"]),
    branch: z.string().min(1).max(255).nullable(),
    head: gitObjectRevisionSchema.nullable(),
    dirty: z.boolean(),
    originUrl: z.string().min(1).max(8_192).nullable(),
    requiresInitialCommit: z.boolean(),
    warnings: z.array(z.string().min(1).max(1_000)).max(20),
  });

export const projectGithubConversionPreflightBlockedSchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("blocked"),
    error: projectGithubConversionErrorSchema,
  });

export const projectGithubConversionPreflightResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionPreflightReadySchema,
    projectGithubConversionPreflightBlockedSchema,
  ]);

export const projectGithubConversionPreflightRequestSchema = z.object({
  repository: projectGithubConversionRepositorySchema,
});

export const encryptedProjectGithubConversionPreflightRequestSchema = z
  .object({
    repository: projectGithubRoutingRepositorySchema,
    repositoryBlindIndex: encryptionKeyBytesSchema,
  })
  .strict();

export const projectGithubConversionStartSchema = z.object({
  repository: projectGithubConversionRepositorySchema,
  confirmationToken:
    projectGithubConversionPreflightReadySchema.shape.confirmationToken,
  initialCommit: z
    .object({
      message: z.string().trim().min(1).max(1_000),
    })
    .nullable()
    .default(null),
});

export const encryptedProjectGithubConversionStartSchema =
  projectGithubConversionStartSchema
    .omit({ repository: true, initialCommit: true })
    .extend({
      repository: projectGithubRoutingRepositorySchema,
      repositoryBlindIndex: encryptionKeyBytesSchema,
      initialCommit: z
        .object({ message: repositoryRoutingHandleSchema })
        .nullable(),
    })
    .strict();

export const projectGithubConversionJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectGithubConversionJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  repository: projectGithubWireRepositorySchema,
  state: projectGithubConversionJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  initialCommitRequested: z.boolean(),
  error: projectGithubConversionJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectGithubConversionRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  repository: projectGithubWireRepositorySchema,
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  branch: z.string().min(1).max(255),
  head: gitObjectRevisionSchema,
  worktreePolicy: worktreePolicySchema,
});

export const projectGithubConversionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectGithubConversionJobErrorSchema,
});

export const projectGithubConversionExecutionResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionReadySchema,
    projectGithubConversionBlockedSchema,
  ]);

export const projectReplicaProvisionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaProvisionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().min(1),
  resolvedRevision: gitObjectRevisionSchema.nullable(),
  branch: z.string().min(1).nullable(),
  reused: z.boolean(),
  placement: projectReplicaPlacementResultSchema.nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const projectReplicaProvisionResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaProvisionReadySchema],
);

export const projectReplicaSynchronizeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  previousRevision: gitObjectRevisionSchema,
  resolvedRevision: gitObjectRevisionSchema,
  branch: z.string().min(1).nullable(),
  changed: z.boolean(),
});

export const projectReplicaSynchronizeResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaSynchronizeReadySchema],
);

export const projectReplicaRemoveReadySchema = z.object({
  status: z.literal("removed"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  localFilesDeleted: z.boolean(),
  linkRemoved: z.boolean().default(false),
  ownershipReleased: z.boolean().default(false),
  warning: z.string().min(1).max(1_000).nullable().default(null),
});

export const projectReplicaRemoveResultSchema = z.discriminatedUnion("status", [
  projectReplicaProvisionBlockedSchema,
  projectReplicaRemoveReadySchema,
]);

export const projectReplicaLinkRepairReadySchema = z.object({
  status: z.literal("ready"),
  projectId: z.string().uuid(),
  path: z.string().min(1).max(8_192),
  linkPath: z.string().min(1).max(8_192),
  repaired: z.boolean(),
});

export const projectReplicaLinkRepairBlockedSchema = z.object({
  status: z.literal("blocked"),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaLinkRepairResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaLinkRepairReadySchema, projectReplicaLinkRepairBlockedSchema],
);

export const projectRemoveSchema = z.object({
  deleteLocalFiles: z.boolean().default(false),
});

export const gitRefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["head", "local", "remote", "tag"]),
  current: z.boolean(),
});

export const gitCommitSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  parents: z.array(z.string().min(1)),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
  refs: z.array(gitRefSchema),
  isHead: z.boolean(),
});

export const gitCommitPersonSchema = z.object({
  name: z.string().min(1),
  email: z.string(),
  date: z.string().datetime({ offset: true }),
});

export const gitSignatureSchema = z.object({
  status: z.enum([
    "unsigned",
    "valid",
    "valid-unknown",
    "invalid",
    "expired",
    "revoked",
    "unverifiable",
  ]),
  signer: z.string().nullable(),
  key: z.string().nullable(),
  fingerprint: z.string().nullable(),
  format: z.enum(["gpg", "ssh", "x509", "unknown"]).nullable().default(null),
  verification: z
    .enum([
      "available",
      "missing-key",
      "missing-config",
      "missing-tool",
      "error",
      "not-applicable",
    ])
    .default("not-applicable"),
  verificationMessage: z.string().max(10_000).nullable().default(null),
});

export const gitAgentDraftTaskSchema = z.enum([
  "summarize-changes",
  "draft-commit-message",
  "draft-pr-description",
  "review-commit-range",
  "explain-conflicts",
  "summarize-failed-checks",
]);

const gitAgentRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => !value.startsWith("-") && !/[\0\r\n]/u.test(value),
    "Expected a safe Git revision.",
  );

export const gitAgentDraftCreateSchema = z
  .object({
    task: gitAgentDraftTaskSchema,
    modelId: z.string().min(1).max(200).optional(),
    instructions: z.string().trim().max(2_000).nullable().default(null),
    baseRevision: gitAgentRevisionSchema.nullable().default(null),
    headRevision: gitAgentRevisionSchema.nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (
      ["draft-pr-description", "review-commit-range"].includes(value.task) &&
      (!value.baseRevision || !value.headRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "This task requires both base and head revisions.",
      });
    }
    if (value.task === "summarize-failed-checks" && !value.pullRequestNumber) {
      context.addIssue({
        code: "custom",
        message: "This task requires a pull request number.",
      });
    }
  });

export const gitAgentDraftModelOutputSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
});

export const gitAgentDraftResultSchema = z.object({
  generationId: z.string().min(1).max(200),
  task: gitAgentDraftTaskSchema,
  text: z.string().trim().min(1).max(100_000),
  modelId: z.string().min(1).max(200),
  modelName: z.string().min(1).max(500),
  providerName: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200),
  generatedAt: z.iso.datetime(),
});

export const gitRelativePathSchema = repositoryRelativePathSchema;

export const gitCommitFileSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
    "unmerged",
    "unknown",
  ]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitCommitDetailSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(64),
  children: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(10_000),
  parentIndex: z.number().int().nonnegative().nullable(),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  author: gitCommitPersonSchema,
  committer: gitCommitPersonSchema,
  signature: gitSignatureSchema.nullable(),
  refs: z.array(gitRefSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitRevisionFileDiffSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitRevisionCandidateSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  name: z.string().min(1).max(1_024),
  kind: z.enum(["head", "local", "remote", "tag", "worktree"]),
  current: z.boolean(),
  worktreeId: z.string().min(1).nullable(),
  worktreeName: z.string().min(1).nullable(),
});

export const gitRevisionCandidateListSchema = z
  .array(gitRevisionCandidateSchema)
  .max(20_000);

export const gitComparisonModeSchema = z.enum(["direct", "merge-base"]);

export const gitComparisonCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitComparisonSchema = z.object({
  mode: gitComparisonModeSchema,
  left: z.string().regex(/^[0-9a-f]{40,64}$/u),
  right: z.string().regex(/^[0-9a-f]{40,64}$/u),
  mergeBase: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  diffBase: z.string().regex(/^[0-9a-f]{40,64}$/u),
  leftAhead: z.number().int().nonnegative(),
  rightAhead: z.number().int().nonnegative(),
  leftCommits: z.array(gitComparisonCommitSchema).max(100),
  rightCommits: z.array(gitComparisonCommitSchema).max(100),
  leftCommitsTruncated: z.boolean(),
  rightCommitsTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitHistorySchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  commits: z.array(gitCommitSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitFileHistoryEntrySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitFileHistorySchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  commits: z.array(gitFileHistoryEntrySchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitBlameRangeSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortCommit: z.string().min(1).max(64),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime(),
  summary: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  lines: z.array(z.string()).min(1).max(501),
});

export const gitBlameSchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  ranges: z.array(gitBlameRangeSchema).max(501),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitGraphNodeKindSchema = z.enum([
  "directory",
  "file",
  "symlink",
  "submodule",
]);

export const gitGraphMetricStateSchema = z.enum([
  "pending",
  "ready",
  "deferred",
  "unavailable",
]);

export const gitGraphAnalysisStateSchema = z.object({
  structure: z.literal("ready"),
  lines: gitGraphMetricStateSchema,
  history: gitGraphMetricStateSchema,
  blame: gitGraphMetricStateSchema,
});

const gitGraphNodeIdSchema = z.string().min(1).max(4_200);

export const gitGraphNodeSchema = z.object({
  id: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  parentId: gitGraphNodeIdSchema.nullable(),
  name: z.string().min(1).max(4_096),
  kind: gitGraphNodeKindSchema,
  objectId: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  extension: z.string().max(200).nullable(),
  language: z.string().max(200).nullable(),
});

export const gitGraphSnapshotSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  branch: z.string().nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  rootId: gitGraphNodeIdSchema,
  nodes: z.array(gitGraphNodeSchema).min(1).max(100_000),
  totalNodes: z.number().int().positive(),
  truncated: z.boolean(),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphNodeMetricsSchema = z.object({
  nodeId: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  binary: z.boolean().nullable(),
  commitTouches: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  churn: z.number().int().nonnegative(),
  binaryCommitTouches: z.number().int().nonnegative(),
  firstChangedAt: z.string().datetime({ offset: true }).nullable(),
  lastChangedAt: z.string().datetime({ offset: true }).nullable(),
  dominantAuthorName: z.string().max(500).nullable(),
  dominantAuthorEmail: z.string().max(1_000).nullable(),
  dominantAuthorShare: z.number().min(0).max(1).nullable(),
  averageBlameAgeDays: z.number().nonnegative().nullable(),
});

export const gitGraphMetricsSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  historyScope: z.enum(["current-branch", "none"]),
  renameAware: z.boolean(),
  blameCoverage: z
    .object({
      analyzedFiles: z.number().int().nonnegative(),
      totalFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .nullable()
    .default(null),
  nodes: z.array(gitGraphNodeMetricsSchema).min(1).max(100_000),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphRequestSchema = z.object({
  revision: gitAgentRevisionSchema.default("HEAD"),
  rootPath: gitRelativePathSchema.nullable().default(null),
  maxNodes: z.number().int().min(1).max(100_000).default(100_000),
  includeBlame: z.boolean().default(false),
});

export const gitGraphCommitOverlayRequestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  rootPath: gitRelativePathSchema.nullable().default(null),
});

export const gitGraphCommitOverlayNodeSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: gitCommitFileSchema.shape.status,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  weight: z.number().int().nonnegative(),
  binary: z.boolean(),
  ghost: z.boolean(),
});

export const gitGraphCommitOverlaySchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  nodes: z.array(gitGraphCommitOverlayNodeSchema).max(100_000),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const gitSearchDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const gitCommitSearchQuerySchema = z
  .object({
    message: z.string().trim().min(1).max(1_000).nullable().default(null),
    author: z.string().trim().min(1).max(1_000).nullable().default(null),
    hash: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{4,64}$/u)
      .nullable()
      .default(null),
    dateFrom: gitSearchDateSchema.nullable().default(null),
    dateTo: gitSearchDateSchema.nullable().default(null),
    path: gitRelativePathSchema.nullable().default(null),
    branch: z.string().trim().min(1).max(1_024).nullable().default(null),
    tag: z.string().trim().min(1).max(1_024).nullable().default(null),
  })
  .superRefine((query, context) => {
    if (query.branch && query.tag) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "Search can target a branch or tag, not both.",
      });
    }
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      context.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "Search end date cannot precede its start date.",
      });
    }
    if (!Object.values(query).some(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "At least one commit search filter is required.",
      });
    }
  });

export const gitCommitSearchResultSchema = z.object({
  query: gitCommitSearchQuerySchema,
  commits: z.array(gitCommitSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryCandidateSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  selector: z.string().min(1).max(1_024),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  action: z.string().min(1).max(100),
  subject: z.string().max(10_000),
  explanation: z.string().min(1).max(10_000),
  actorName: z.string().max(1_000).nullable(),
  actorEmail: z.string().max(1_000).nullable(),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
});

export const gitRecoveryCandidateListSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  entries: z.array(gitRecoveryCandidateSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("restoreBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("reset"),
    mode: z.enum(["soft", "mixed", "hard"]),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
]);

export const gitRecoveryPreviewSchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  confirmation: z.string().min(1).max(1_000),
  targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  branchBefore: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  commitsRemoved: z.array(gitComparisonCommitSchema).max(200),
  commitsRemovedTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  status: z.lazy(() => gitStatusSchema),
});

export const gitRecoveryApplySchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.string().min(1).max(1_000),
});

export const gitRecoveryResultSchema = z.object({
  action: gitRecoveryActionSchema,
  output: z.string().max(1_000_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  headBefore: z.string().regex(/^[0-9a-f]{40,64}$/u),
  headAfter: z.string().regex(/^[0-9a-f]{40,64}$/u),
  status: z.lazy(() => gitStatusSchema),
});

export const gitFileChangeSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).nullable(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().min(1),
  upstream: z.string().min(1).nullable(),
});

export const gitStatusSchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  upstream: z.string().min(1).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(gitFileChangeSchema),
  branches: z.array(gitBranchSchema),
});

export const gitDiffScopeSchema = z.enum(["unstaged", "staged"]);

export const gitFileDiffSchema = z.object({
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
});

export const gitPartialPatchOperationSchema = z.enum([
  "stage",
  "unstage",
  "discard",
]);

export const gitPartialPatchHunkSelectionSchema = z.object({
  hunkIndex: z.number().int().nonnegative(),
  lineIndexes: z.array(z.number().int().nonnegative()).max(100_000).nullable(),
});

export const gitPartialPatchRequestSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  hunks: z.array(gitPartialPatchHunkSelectionSchema).min(1).max(10_000),
});

export const gitPartialPatchPreviewSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().min(1).max(2_000_000),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  selectedHunks: z.number().int().positive(),
  selectedLines: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitPartialPatchApplySchema = z.object({
  request: gitPartialPatchRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashFileSchema = z.object({
  path: gitRelativePathSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitStashSummarySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  message: z.string().max(10_000),
  createdAt: z.string().datetime({ offset: true }),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  files: z.array(gitStashFileSchema).max(10_000),
  filesChanged: z.number().int().nonnegative(),
  filesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  includesUntracked: z.boolean(),
});

export const gitStashListSchema = z.object({
  stashes: z.array(gitStashSummarySchema).max(10_000),
  truncated: z.boolean(),
});

export const gitStashCreateSchema = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    includeStaged: z.boolean(),
    includeUnstaged: z.boolean(),
    includeUntracked: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      !value.includeStaged &&
      !value.includeUnstaged &&
      !value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Select at least one change scope.",
      });
    }
    if (
      value.includeStaged &&
      !value.includeUnstaged &&
      value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Git cannot combine staged-only and untracked stash scopes.",
      });
    }
  });

const gitStashIdentitySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
});

export const gitBranchNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\0\r\n]+$/u);

export const gitStashActionSchema = z.discriminatedUnion("type", [
  gitStashIdentitySchema.extend({ type: z.literal("apply") }),
  gitStashIdentitySchema.extend({ type: z.literal("pop") }),
  gitStashIdentitySchema.extend({ type: z.literal("drop") }),
  z.object({ type: z.literal("clear") }),
  gitStashIdentitySchema.extend({
    type: z.literal("branch"),
    branch: gitBranchNameInputSchema,
  }),
]);

export const gitStashActionPreviewSchema = z.object({
  action: gitStashActionSchema,
  stashes: z.array(gitStashSummarySchema).min(1).max(10_000),
  destructive: z.boolean(),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitStashActionApplySchema = z.object({
  action: gitStashActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  stash: gitStashSummarySchema.nullable(),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
  operation: z
    .object({
      type: z.literal("stash"),
      state: z.literal("conflicted"),
      originalHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      sourceRef: z.string().min(1).max(1_024),
      sourceRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      targetRef: z.string().min(1).max(1_024).nullable(),
      targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      pendingCommits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).length(1),
      currentStep: z.literal(1),
      totalSteps: z.literal(1),
      checkpointRef: z.string().min(1).max(1_024),
      conflictedPaths: z.array(gitRelativePathSchema).min(1).max(100_000),
    })
    .nullable()
    .default(null),
});

export const gitStashFileDiffSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  path: gitRelativePathSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitBranchCommitSummarySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  subject: z.string().max(100_000),
  authorName: z.string().min(1).max(10_000),
  authoredAt: z.string().datetime({ offset: true }),
});

const gitBranchDisplayNameSchema = z.string().min(1).max(1_000);

export const gitManagedBranchSchema = z.object({
  name: gitBranchDisplayNameSchema,
  fullRef: z.string().min(1).max(1_000),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  upstream: z.string().min(1).max(1_000).nullable(),
  upstreamGone: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergedIntoHead: z.boolean().nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  remoteAvailable: z.boolean(),
  trackingLocalBranches: z.array(gitBranchDisplayNameSchema).max(10_000),
  worktree: z
    .object({
      label: z.string().min(1).max(1_000),
      current: z.boolean(),
    })
    .nullable(),
  lastCommit: gitBranchCommitSummarySchema,
});

export const gitPullStrategySchema = z.object({
  mode: z.enum(["fast-forward-only", "rebase", "merge", "unspecified"]),
  description: z.string().min(1).max(1_000),
});

export const gitBranchListSchema = z.object({
  currentBranch: gitBranchDisplayNameSchema.nullable(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  detached: z.boolean(),
  defaultRemote: z.string().min(1).max(255).nullable(),
  remotes: z.array(z.string().min(1).max(255)).max(1_000),
  pullStrategy: gitPullStrategySchema,
  branches: z.array(gitManagedBranchSchema).max(20_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);
const gitRevisionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitBranchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    name: gitBranchNameInputSchema,
    startPoint: gitRevisionInputSchema.nullable(),
    checkout: z.boolean(),
  }),
  z.object({
    type: z.literal("switch"),
    name: gitBranchNameInputSchema,
    kind: z.enum(["local", "remote"]),
  }),
  z.object({
    type: z.literal("publish"),
    name: gitBranchNameInputSchema,
    remote: gitRemoteNameInputSchema,
  }),
  z.object({
    type: z.literal("rename"),
    name: gitBranchNameInputSchema,
    newName: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("deleteLocal"),
    name: gitBranchNameInputSchema,
    force: z.boolean(),
  }),
  z.object({
    type: z.literal("deleteRemote"),
    remote: gitRemoteNameInputSchema,
    name: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("setUpstream"),
    name: gitBranchNameInputSchema,
    upstream: z.string().trim().min(1).max(1_000).nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    prune: z.boolean(),
  }),
]);

export const gitBranchActionPreviewSchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  branch: gitManagedBranchSchema.nullable(),
});

export const gitBranchActionApplySchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitBranchMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  branches: gitBranchListSchema,
});

export const gitRemoteSummarySchema = z.object({
  name: z.string().min(1).max(255),
  fetchUrl: z.string().min(1).max(8_192),
  fetchUrlRedacted: z.boolean(),
  pushUrl: z.string().min(1).max(8_192),
  pushUrlRedacted: z.boolean(),
  defaultFetch: z.boolean(),
  defaultPush: z.boolean(),
});

export const gitRemoteListSchema = z.object({
  remotes: z.array(gitRemoteSummarySchema).max(1_000),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitRemoteActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("edit"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({ type: z.literal("remove"), name: gitRemoteNameInputSchema }),
  z.object({
    type: z.literal("setDefaults"),
    fetchRemote: gitRemoteNameInputSchema.nullable(),
    pushRemote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema,
    prune: z.boolean(),
  }),
]);

export const gitRemoteActionPreviewSchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  remote: gitRemoteSummarySchema.nullable(),
});

export const gitRemoteActionApplySchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitRemoteMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  remotes: gitRemoteListSchema,
});

export const gitSubmoduleSummarySchema = z.object({
  name: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  url: z.string().min(1).max(8_192),
  branch: z.string().min(1).max(1_024).nullable(),
  expectedHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  currentHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  initialized: z.boolean(),
  dirty: z.boolean(),
  nested: z.boolean(),
  state: z.enum(["clean", "uninitialized", "changed", "conflicted", "missing"]),
});

export const gitSubmoduleListSchema = z.object({
  submodules: z.array(gitSubmoduleSummarySchema).max(10_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitSubmoduleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initialize"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("update"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
    remote: z.boolean(),
  }),
  z.object({
    type: z.literal("sync"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("deinitialize"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitSubmoduleActionPreviewSchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  targets: z.array(gitSubmoduleSummarySchema).max(10_000),
});

export const gitSubmoduleActionApplySchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitSubmoduleMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  submodules: gitSubmoduleListSchema,
});

export const gitLfsTrackedPatternSchema = z.object({
  pattern: z.string().min(1).max(4_096),
  source: gitRelativePathSchema,
});

export const gitLfsFileSchema = z.object({
  path: gitRelativePathSchema,
  oid: z.string().regex(/^[0-9a-f]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checkedOut: z.boolean(),
  downloaded: z.boolean(),
  status: z.string().min(1).max(100).nullable(),
});

export const gitLfsLockSchema = z.object({
  id: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  owner: z.string().min(1).max(1_024).nullable(),
  lockedAt: z.string().datetime({ offset: true }).nullable(),
  ours: z.boolean(),
});

export const gitLfsStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).max(1_024).nullable(),
  message: z.string().max(10_000).nullable(),
  patterns: z.array(gitLfsTrackedPatternSchema).max(10_000),
  files: z.array(gitLfsFileSchema).max(10_000),
  filesTruncated: z.boolean(),
  missingObjects: z.number().int().nonnegative().max(10_000),
  pendingPaths: z
    .array(
      z.object({
        path: gitRelativePathSchema,
        status: z.string().min(1).max(100),
      }),
    )
    .max(10_000),
  locks: z.array(gitLfsLockSchema).max(10_000),
  locksTruncated: z.boolean(),
  locksCached: z.boolean(),
  lockError: z.string().max(10_000).nullable(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitLfsPatternInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .regex(/^[^\0\r\n-][^\0\r\n]*$/u);

export const gitLfsActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("install") }),
  z.object({ type: z.literal("track"), pattern: gitLfsPatternInputSchema }),
  z.object({ type: z.literal("untrack"), pattern: gitLfsPatternInputSchema }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    all: z.boolean(),
  }),
  z.object({
    type: z.literal("pull"),
    remote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({ type: z.literal("prune"), verifyRemote: z.boolean() }),
  z.object({ type: z.literal("refreshLocks") }),
  z.object({ type: z.literal("lock"), path: gitRelativePathSchema }),
  z.object({
    type: z.literal("unlock"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitLfsActionPreviewSchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  status: gitLfsStatusSchema,
});

export const gitLfsActionApplySchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitLfsMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  lfs: gitLfsStatusSchema,
});

export const gitTagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitTagSummarySchema = z.object({
  name: z.string().min(1).max(1_000),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetHash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetType: z.enum(["commit", "tree", "blob", "tag", "other"]),
  annotated: z.boolean(),
  subject: z.string().max(100_000),
  taggerName: z.string().min(1).max(10_000).nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  signature: gitSignatureSchema,
  publishedRemotes: z.array(z.string().min(1).max(255)).max(1_000),
});

export const gitTagDetailSchema = gitTagSummarySchema.extend({
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
});

export const gitTagListSchema = z.object({
  tags: z.array(gitTagSummarySchema).max(10_000),
  truncated: z.boolean(),
  remoteChecks: z.array(
    z.object({
      remote: z.string().min(1).max(255),
      available: z.boolean(),
      error: z.string().max(1_000).nullable(),
    }),
  ),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitTagActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("create"),
      name: gitTagNameInputSchema,
      target: gitRevisionInputSchema.nullable(),
      annotated: z.boolean(),
      message: z.string().trim().min(1).max(1_000_000).nullable(),
    }),
    z.object({
      type: z.literal("push"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
    z.object({ type: z.literal("deleteLocal"), name: gitTagNameInputSchema }),
    z.object({
      type: z.literal("deleteRemote"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
  ])
  .superRefine((action, context) => {
    if (action.type !== "create") return;
    if (action.annotated && !action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Annotated tags require a message.",
      });
    }
    if (!action.annotated && action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Lightweight tags do not have a tag message.",
      });
    }
  });

export const gitTagActionPreviewSchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  tag: gitTagSummarySchema.nullable(),
});

export const gitTagActionApplySchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitTagMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  tags: gitTagListSchema,
});

const gitCommitHashInputSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

export const gitCherryPickSelectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commits"),
    revisions: z.array(gitCommitHashInputSchema).min(1).max(1_000),
  }),
  z.object({
    type: z.literal("range"),
    fromRevision: gitCommitHashInputSchema,
    toRevision: gitCommitHashInputSchema,
  }),
]);

export const gitCommitActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cherryPick"),
    selection: gitCherryPickSelectionSchema,
  }),
  z.object({
    type: z.literal("revert"),
    revision: gitCommitHashInputSchema,
    mainlineParent: z.number().int().positive().max(64).nullable(),
  }),
  z.object({
    type: z.literal("amend"),
    message: z.string().min(1).max(1_000_000).nullable(),
  }),
  z.object({
    type: z.literal("fixup"),
    revision: gitCommitHashInputSchema,
  }),
]);

export const gitOperationSummarySchema = z.object({
  type: z.enum(["cherry-pick", "revert"]),
  state: z.enum([
    "queued",
    "running",
    "conflicted",
    "awaiting-user-action",
    "completed",
    "failed",
    "aborted",
  ]),
  originalHead: gitCommitHashInputSchema,
  currentHead: gitCommitHashInputSchema,
  sourceRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  currentStep: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive().max(1_000),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
});

export const gitManagedOperationTypeSchema = z.enum([
  "merge",
  "rebase",
  "bisect",
  "cherry-pick",
  "revert",
  "stash",
]);

export const gitManagedOperationStateSchema = z.enum([
  "queued",
  "running",
  "conflicted",
  "awaiting-user-action",
  "completed",
  "failed",
  "aborted",
]);

export const gitInteractiveRebaseTodoActionSchema = z.enum([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
]);

export const gitInteractiveRebaseTodoItemSchema = z
  .object({
    action: gitInteractiveRebaseTodoActionSchema,
    revision: gitCommitHashInputSchema,
    message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
  })
  .superRefine((item, context) => {
    if (item.action === "reword" && !item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Reword steps require a replacement commit message.",
      });
    }
    if (item.action !== "reword" && item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Only reword steps accept a replacement commit message.",
      });
    }
  });

export const gitMergeRebaseActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("merge"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("rebase"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("interactiveRebase"),
    upstreamRef: gitRevisionInputSchema,
    todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  }),
]);

export const gitBisectActionSchema = z.object({
  type: z.literal("bisect"),
  goodRef: gitRevisionInputSchema,
  badRef: gitRevisionInputSchema,
});

export const gitManagedOperationActionSchema = z.union([
  gitMergeRebaseActionSchema,
  gitBisectActionSchema,
]);

export const gitManagedOperationContextSchema = z.object({
  type: gitManagedOperationTypeSchema,
  originalHead: gitCommitHashInputSchema,
  sourceRef: z.string().min(1).max(1_024).nullable(),
  sourceRevision: gitCommitHashInputSchema.nullable(),
  targetRef: z.string().min(1).max(1_024).nullable(),
  targetRevision: gitCommitHashInputSchema,
  pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
  totalSteps: z.number().int().positive().max(10_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitManagedOperationWorkerStateSchema =
  gitManagedOperationContextSchema.extend({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    status: gitStatusSchema,
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitOperationObservationStateSchema = z
  .object({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    totalSteps: z.number().int().positive().max(10_000),
    pendingCommitCount: z.number().int().nonnegative().max(10_000),
    conflictedPathCount: z.number().int().nonnegative().max(100_000),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable(),
  })
  .strict();

export const gitManagedOperationPreviewSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  context: gitManagedOperationContextSchema,
  commits: z.array(gitComparisonCommitSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  todoText: z.string().max(2_000_000).default(""),
  publishedRefs: z.array(z.string().min(1).max(1_024)).max(1_000).default([]),
});

export const gitManagedOperationStartSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitManagedOperationControlSchema = z.object({
  action: z.enum(["continue", "skip", "abort", "good", "bad", "reset"]),
});

export const gitManagedOperationAmendSchema = z.object({
  message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
});

export const gitManagedOperationRecordSchema =
  gitManagedOperationContextSchema.extend({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    worktreeId: z.string().uuid(),
    workerId: z.string().min(1).max(255),
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    error: z.string().max(1_000_000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitManagedOperationResponseSchema = z.object({
  operation: gitManagedOperationRecordSchema.nullable(),
});

export const gitConflictKindSchema = z.enum([
  "both-modified",
  "both-added",
  "both-deleted",
  "added-by-ours",
  "added-by-theirs",
  "deleted-by-ours",
  "deleted-by-theirs",
  "unknown",
]);

export const gitConflictStageSchema = z.object({
  available: z.boolean(),
  oid: gitCommitHashInputSchema.nullable(),
  mode: z
    .string()
    .regex(/^[0-7]{6}$/u)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  content: z.string().max(2_000_000).nullable(),
  truncated: z.boolean(),
});

export const gitConflictSummarySchema = z.object({
  path: gitRelativePathSchema,
  code: z.string().length(2),
  kind: gitConflictKindSchema,
  baseAvailable: z.boolean(),
  oursAvailable: z.boolean(),
  theirsAvailable: z.boolean(),
});

export const gitConflictListSchema = z.object({
  files: z.array(gitConflictSummarySchema).max(100_000),
  truncated: z.boolean(),
});

export const gitConflictDetailSchema = gitConflictSummarySchema.extend({
  base: gitConflictStageSchema,
  ours: gitConflictStageSchema,
  theirs: gitConflictStageSchema,
  result: z.object({
    exists: z.boolean(),
    oid: gitCommitHashInputSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    content: z.string().max(2_000_000).nullable(),
    truncated: z.boolean(),
  }),
});

export const gitConflictResolutionStrategySchema = z.enum([
  "ours",
  "theirs",
  "both",
  "result",
  "manual",
  "delete",
]);

export const gitConflictResolutionRequestSchema = z
  .object({
    path: gitRelativePathSchema,
    strategy: gitConflictResolutionStrategySchema,
    content: z.string().max(2_000_000).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.strategy === "manual" && value.content === null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Manual conflict resolution requires result content.",
      });
    }
    if (value.strategy !== "manual" && value.content !== null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Only manual conflict resolution accepts result content.",
      });
    }
  });

export const gitConflictResolutionPreviewSchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  resultDeleted: z.boolean(),
  resultBinary: z.boolean(),
  resultContent: z.string().max(2_000_000).nullable(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitConflictResolutionApplySchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitConflictResolutionResultSchema = z.object({
  path: gitRelativePathSchema,
  resolved: z.boolean(),
  remainingPaths: z.array(gitRelativePathSchema).max(100_000),
  status: gitStatusSchema,
});

export const gitCommitActionPreviewSchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  resolvedRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  commits: z.array(gitComparisonCommitSchema).max(1_000),
  files: z.array(gitFileChangeSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitCommitActionApplySchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitCommitActionResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  headBefore: gitCommitHashInputSchema,
  headAfter: gitCommitHashInputSchema,
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  operation: gitOperationSummarySchema.nullable(),
});

const gitPathsSchema = z.array(gitRelativePathSchema).min(1).max(1_000);
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("unstage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("discard"), paths: gitPathsSchema }),
  z.object({ type: z.literal("stageAll") }),
  z.object({ type: z.literal("unstageAll") }),
  z.object({ type: z.literal("discardAll") }),
  z.object({
    type: z.literal("commit"),
    message: z.string().trim().min(1).max(10_000),
    all: z.boolean().default(false),
  }),
  z.object({ type: z.literal("pull") }),
  z.object({ type: z.literal("push") }),
  z.object({
    type: z.literal("checkout"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("createBranch"),
    name: z.string().trim().min(1).max(255),
  }),
]);

export const gitActionResultSchema = z.object({
  status: gitStatusSchema,
  output: z.string(),
});

export const gitForcePushPreviewSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.literal(true),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  remote: gitRemoteNameInputSchema,
  localBranch: gitBranchNameInputSchema,
  remoteBranch: gitBranchNameInputSchema,
  localHead: gitCommitHashInputSchema,
  expectedRemoteHead: gitCommitHashInputSchema,
  localCommits: z.array(gitComparisonCommitSchema).max(200),
  localCommitCount: z.number().int().nonnegative(),
  localCommitsTruncated: z.boolean(),
  remoteCommits: z.array(gitComparisonCommitSchema).max(200),
  remoteCommitCount: z.number().int().positive(),
  remoteCommitsTruncated: z.boolean(),
});

export const gitForcePushApplySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const workerWorktreeSummarySchema = z.object({
  path: z.string().min(1),
  head: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  detached: z.boolean(),
  isPrimary: z.boolean(),
  managed: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().min(1).nullable(),
  missing: z.boolean(),
});

export const worktreeInventorySchema = z.object({
  sourcePath: z.string().min(1),
  primaryPath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  managedRoot: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  worktrees: z.array(workerWorktreeSummarySchema),
});

export const worktreeCreateModeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("newBranch"),
    branch: z.string().trim().min(1).max(255),
    startPoint: z.string().trim().min(1).max(1_024).nullable().default(null),
  }),
  z.object({
    type: z.literal("existingBranch"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("detached"),
    revision: z.string().trim().min(1).max(1_024),
  }),
]);

export const worktreeCreateResultSchema = z.object({
  created: z.boolean(),
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeCreateMutationOutcomeSchema = z.enum([
  "notStarted",
  "committed",
  "rolledBack",
  "partial",
]);

export const worktreeCreateMutationFailureSchema = z
  .object({
    code: z.enum([
      "worktree-create-not-started",
      "worktree-create-committed",
      "worktree-create-rolled-back",
      "worktree-create-partial",
    ]),
    error: z.string().min(1).max(2_000),
    mutation: z
      .object({
        outcome: worktreeCreateMutationOutcomeSchema,
        retryable: z.boolean(),
        target: z
          .object({
            kind: z.literal("worktree"),
            projectId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((failure, context) => {
    const expectedCode = `worktree-create-${
      failure.mutation.outcome === "notStarted"
        ? "not-started"
        : failure.mutation.outcome === "rolledBack"
          ? "rolled-back"
          : failure.mutation.outcome
    }`;
    if (failure.code !== expectedCode) {
      context.addIssue({
        code: "custom",
        message: "Worktree mutation failure code must match its outcome.",
        path: ["code"],
      });
    }
    if (
      (failure.mutation.outcome === "notStarted") !==
      (failure.mutation.target === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only a worktree mutation that did not start may omit its recovery target.",
        path: ["mutation", "target"],
      });
    }
  });

export const worktreeMutationResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeRemoveResultSchema = z.object({
  removedPath: z.string().min(1),
  inventory: worktreeInventorySchema,
});

export const worktreePruneResultSchema = z.object({
  prunedPaths: z.array(z.string().min(1)),
  inventory: worktreeInventorySchema,
});

export const worktreeStatusResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  status: gitStatusSchema,
});

const cantripMcpWorkerWorktreeSummarySchema = workerWorktreeSummarySchema
  .omit({ path: true })
  .strict();
const cantripMcpGitStatusSchema = gitStatusSchema.extend({
  files: gitStatusSchema.shape.files.max(2_000),
  branches: gitStatusSchema.shape.branches.max(500),
});
export const cantripMcpWorktreeStatusResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict(),
    data: z
      .object({
        worktree: cantripMcpWorkerWorktreeSummarySchema,
        status: cantripMcpGitStatusSchema,
        filesTruncated: z.boolean(),
        branchesTruncated: z.boolean(),
      })
      .strict(),
  });

export const worktreeObservationTargetSchema = z.object({
  projectId: z.string().uuid().optional(),
  worktreeId: z.string().min(1).max(200).optional(),
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
  operation: z
    .object({
      id: z.string().uuid(),
      context: gitManagedOperationContextSchema,
    })
    .strict()
    .nullable()
    .optional(),
});

export const worktreeObservationTargetsSchema = z
  .array(worktreeObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Worktree observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const codeGraphObservationTargetSchema = z.object({
  projectId: z.string().uuid(),
  worktreeId: z.string().min(1).max(200),
  rootKind: projectRootKindSchema,
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
});

export const codeGraphObservationTargetsSchema = z
  .array(codeGraphObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.rootKind}\0${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "CodeGraph observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const projectWorktreeCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: worktreeCreateModeSchema,
});

export const projectWorktreeLockSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().default(null),
});

export const projectWorktreeRemoveSchema = z.object({
  force: z.boolean().default(false),
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePruneSchema = z.object({
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePolicyUpdateSchema = z.object({
  policy: worktreePolicySchema,
});

export const chatWorktreeUpdateSchema = z.object({
  worktreeId: z.string().min(1),
  mode: z.enum(["agent-managed", "pinned"]),
});

export const worktreeSelectionSchema = z.object({
  worktreeId: z.string().min(1),
});

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  text: z.string(),
  structuredResult: z.unknown().optional(),
  measuredUsage: agentTokenUsageSchema.nullable().optional(),
  status: z.literal("completed"),
});

export const agentTurnResultModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible") }),
  z.object({
    kind: z.literal("structured"),
    outputSchema: workflowJsonObjectSchema,
  }),
  z.object({
    kind: z.literal("task-encrypted"),
    operation: taskOperationRelayRequestSchema,
  }),
  z.object({
    kind: z.literal("task-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("chat-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
]);

export const chatMessageRelayResultSchema = z
  .object({
    message: chatMessageOpaqueContentSchema.nullable(),
  })
  .strict();

export const normalizedAgentMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  phase: agentMessagePhaseSchema.nullable(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
});

export const agentThreadSyncItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("userMessage"),
      id: z.string().min(1),
      text: z.string(),
      externalAttachmentIds: z.array(z.string().uuid()).max(20).default([]),
    })
    .refine(
      (item) =>
        item.text.trim().length > 0 || item.externalAttachmentIds.length > 0,
      { message: "User messages require text or an external attachment." },
    ),
  z.object({
    type: z.literal("agentMessage"),
    ...normalizedAgentMessageSchema.shape,
  }),
  z.object({
    type: z.literal("activity"),
    activity: agentActivitySchema,
  }),
]);

export const agentThreadSyncSchema = z.object({
  threadId: z.string().min(1),
  status: z.enum(["idle", "running", "failed"]),
  turns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      items: z.array(agentThreadSyncItemSchema),
    }),
  ),
});

export const externalChatSourceKindSchema = z.enum(["chatgpt-codex"]);

export const externalChatSourceAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "incompatible",
]);

export const externalChatThreadStatusSchema = z.enum([
  "not-loaded",
  "idle",
  "system-error",
]);

export const chatImportStateSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const externalChatImportReferenceSchema = z.object({
  jobId: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
});

export const externalChatThreadMatchSchema = z.object({
  kind: z.enum(["worktree-path", "replica-path", "git-origin"]),
  projectReplicaId: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200).nullable(),
});

export const externalChatThreadMetadataSchema = z.object({
  sourceThreadId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  preview: z.string().max(2_000),
  cwd: z.string().min(1).max(8_192),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean(),
  source: z.enum(["cli", "vscode"]),
  status: externalChatThreadStatusSchema,
  modelProvider: z.string().min(1).max(200),
  cliVersion: z.string().max(100).nullable(),
  git: z
    .object({
      branch: z.string().max(1_000).nullable(),
      sha: z.string().max(200).nullable(),
      originUrl: z.string().max(4_000).nullable(),
    })
    .nullable(),
  match: externalChatThreadMatchSchema,
  existingImport: externalChatImportReferenceSchema.nullable().default(null),
});

export const externalChatSourceSchema = z.object({
  kind: externalChatSourceKindSchema,
  sourceId: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "win32"]),
  homeLabel: z.string().min(1).max(500),
  availability: externalChatSourceAvailabilitySchema,
  message: z.string().min(1).max(2_000).nullable(),
  runtimeVersion: z.string().max(100).nullable(),
  threads: z.array(externalChatThreadMetadataSchema).max(5_000),
  truncated: z.boolean(),
});

export const externalChatDiscoveryWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "unsupported",
  "timed-out",
  "error",
]);

export const externalChatDiscoveryWorkerSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  status: externalChatDiscoveryWorkerStatusSchema,
  sources: z.array(externalChatSourceSchema).max(8),
  error: z
    .object({
      code: z.enum([
        "worker-offline",
        "capability-missing",
        "worker-timeout",
        "worker-error",
      ]),
      message: z.string().min(1).max(2_000),
    })
    .nullable(),
});

export const projectExternalChatDiscoverySchema = z.object({
  projectId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean(),
  workers: z.array(externalChatDiscoveryWorkerSchema).max(64),
});

export const externalChatDiscoveryTargetSchema = z.object({
  projectReplicaId: z.string().min(1).max(200),
  path: z.string().min(1).max(8_192),
  repositoryFingerprint: z.string().min(1).max(500).nullable(),
  worktrees: z
    .array(
      z.object({
        worktreeId: z.string().min(1).max(200),
        path: z.string().min(1).max(8_192),
        isPrimary: z.boolean(),
      }),
    )
    .max(512),
});

export const externalChatDiscoveryWorkerResultSchema = z.object({
  sources: z.array(externalChatSourceSchema).max(8),
  truncated: z.boolean(),
});

export const externalChatTranscriptMetadataSchema =
  externalChatThreadMetadataSchema.omit({
    archived: true,
    existingImport: true,
    title: true,
  });

export const externalChatAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    sourceAttachmentId: z.string().regex(/^[0-9a-f]{64}$/u),
    itemId: z.string().min(1).max(500),
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    status: z.enum(["available", "missing", "unsafe", "unsupported"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
  })
  .superRefine((attachment, context) => {
    if (attachment.status === "available" && attachment.sizeBytes === 0) {
      context.addIssue({
        code: "custom",
        message: "Available external attachments cannot be empty.",
        path: ["sizeBytes"],
      });
    }
  });

export const externalChatTranscriptSchema = z
  .object({
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    metadata: externalChatTranscriptMetadataSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
    sync: agentThreadSyncSchema,
    attachments: z.array(externalChatAttachmentSchema).max(20).default([]),
  })
  .superRefine((transcript, context) => {
    if (transcript.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Imported title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const descriptors = new Map(
      transcript.attachments.map((attachment) => [attachment.id, attachment]),
    );
    if (descriptors.size !== transcript.attachments.length) {
      context.addIssue({
        code: "custom",
        message: "External attachment ids must be unique.",
        path: ["attachments"],
      });
    }
    const references = new Map<string, string>();
    for (const [turnIndex, turn] of transcript.sync.turns.entries()) {
      for (const [itemIndex, item] of turn.items.entries()) {
        if (item.type !== "userMessage") continue;
        for (const attachmentId of item.externalAttachmentIds) {
          if (references.has(attachmentId)) {
            context.addIssue({
              code: "custom",
              message: "An external attachment may be referenced only once.",
              path: [
                "sync",
                "turns",
                turnIndex,
                "items",
                itemIndex,
                "externalAttachmentIds",
              ],
            });
          }
          references.set(attachmentId, item.id);
        }
      }
    }
    for (const [
      attachmentIndex,
      attachment,
    ] of transcript.attachments.entries()) {
      if (references.get(attachment.id) !== attachment.itemId) {
        context.addIssue({
          code: "custom",
          message:
            "Every external attachment must reference its originating user message.",
          path: ["attachments", attachmentIndex, "itemId"],
        });
      }
    }
    for (const attachmentId of references.keys()) {
      if (!descriptors.has(attachmentId)) {
        context.addIssue({
          code: "custom",
          message: "External attachment references require a descriptor.",
          path: ["sync"],
        });
      }
    }
  });

export const externalChatReadWorkerResultSchema = z.object({
  transcript: externalChatTranscriptSchema,
});

export const externalChatAttachmentReadResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("available"),
      chunk: attachmentChunkOpaqueSchema,
      sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    }),
    z.object({
      status: z.literal("unavailable"),
      reasonCode: z.enum(["missing", "changed", "invalid"]),
    }),
  ],
);

export const chatImportErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "source-not-found",
    "source-changed",
    "project-mismatch",
    "runtime-incompatible",
    "target-not-found",
    "stale-attempt",
    "worker-error",
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export const chatImportJobErrorSchema = chatImportErrorSchema.omit({
  message: true,
});

export const chatImportProgressStageSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "blocked",
  "failed",
  "succeeded",
]);

export const chatImportProgressSchema = z.object({
  stage: chatImportProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatImportJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  targetPlacement: executionPlacementSchema,
  managedThreadId: z.string().min(1).max(500).nullable(),
  targetModelRouteId: z.string().min(1).max(200).nullable(),
  targetProviderAccountId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  attempt: z.number().int().nonnegative(),
  progress: chatImportProgressSchema,
  error: chatImportJobErrorSchema.nullable(),
  sourceMetadata: externalChatTranscriptMetadataSchema.nullable(),
  attachmentCount: z.number().int().nonnegative(),
  attachmentWarningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatImportJobListSchema = z
  .array(chatImportJobSummarySchema)
  .max(1_000);

export const chatImportSelectionSchema = z.object({
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  idempotencyKey: z.string().min(1).max(200),
  target: executionTargetSchema.optional(),
  modelId: z.string().min(1).max(200).nullable().default(null),
  modelRouteId: z.string().min(1).max(200).nullable().default(null),
  providerAccountId: z.string().min(1).max(200).nullable().default(null),
  permissionProfileId: z.string().min(1).max(200).nullable().default(null),
  planMode: planModeSchema.default("default"),
});

export const chatImportCreateSchema = z.object({
  imports: z.array(chatImportSelectionSchema).min(1).max(50),
});

export const chatImportJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

const workerRuntimeModelSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  name: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  catalog: providerModelCatalogEntrySchema
    .pick({
      nativeModelId: true,
      displayName: true,
      description: true,
      contextWindow: true,
      maxOutputTokens: true,
      inputModalities: true,
      outputModalities: true,
      supportsTools: true,
      supportsParallelTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedReasoningEfforts: true,
      defaultReasoningEffort: true,
      reasoningMandatory: true,
      metadataSource: true,
    })
    .nullable()
    .optional(),
});

const workerRuntimeProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  protectedApiKey: protectedSecretEnvelopeSchema.nullable().default(null),
  accountId: z.string().min(1).nullable().default(null),
  credentialHomeKey: z.string().min(1).max(500).nullable().default(null),
});

export const workerChatAttachmentSchema = chatAttachmentOpaqueSummarySchema;

export const workerAttachmentUploadResultSchema = z.object({
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  verified: z.literal(true),
});

export const workerAttachmentReadResultSchema = z.object({
  chunk: attachmentChunkOpaqueSchema,
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
});

export const workerProjectShareDescriptorSchema = z
  .object({
    shareId: z.string().min(1).max(200),
    protocol: z.literal("webdav"),
    publicBasePath: projectSharePublicBasePathSchema,
    publicOrigin: projectSharePublicOriginSchema,
    loopbackHost: z.literal("127.0.0.1"),
    loopbackPort: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(128),
    password: z.string().min(24).max(256),
    realm: z.string().min(1).max(200),
  })
  .strict();

export const workerProjectShareOpenResultSchema = z
  .object({
    accepted: z.literal(true),
    shareId: z.string().min(1).max(200),
  })
  .strict();

export const ollamaModelInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  modifiedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  digest: z.string().trim().min(1).max(500).nullable(),
  family: z.string().trim().min(1).max(500).nullable(),
  families: z.array(z.string().trim().min(1).max(500)).max(32),
  parameterSize: z.string().trim().min(1).max(100).nullable(),
  quantization: z.string().trim().min(1).max(100).nullable(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(64),
  modelInfo: z.record(z.string(), z.unknown()),
});

export const ollamaModelInventorySchema = z.object({
  models: z.array(ollamaModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
});

export const chatGptModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: reasoningEffortSchema,
        description: z.string().max(500),
      }),
    )
    .max(32),
  defaultReasoningEffort: reasoningEffortSchema,
  modelSpecialty: z.string().max(500).nullable(),
  supportsPersonality: z.boolean(),
  upgrade: z.string().max(500).nullable(),
  upgradeInfo: z.record(z.string(), z.unknown()).nullable(),
  availabilityNux: z.record(z.string(), z.unknown()).nullable(),
  additionalSpeedTiers: z.array(z.string().max(100)).max(32),
  serviceTiers: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().max(200),
        description: z.string().max(2_000),
      }),
    )
    .max(32),
  defaultServiceTier: z.string().max(100).nullable(),
});

export const providerQuotaWindowObservationSchema = z.object({
  limitId: z.string().max(500).nullable(),
  limitName: z.string().max(500).nullable(),
  planType: z.string().max(500).nullable(),
  reachedType: z.string().max(500).nullable(),
  windowKind: z.enum(["primary", "secondary"]),
  usedPercent: z.number().min(0).max(100),
  windowDurationMinutes: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
  isWeeklyProjection: z.boolean(),
  rawPayload: z.record(z.string(), z.unknown()).default({}),
});

export const providerRateLimitResetCreditSchema = z.object({
  id: z.string().trim().min(1).max(1_000),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  title: z.string().max(1_000).nullable(),
  description: z.string().max(4_000).nullable(),
});

export const providerRateLimitResetCreditsSummarySchema = z.object({
  availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credits: z.array(providerRateLimitResetCreditSchema).max(100).nullable(),
});

export const providerRateLimitResetConsumeOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

export const providerRateLimitResetConsumeInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    creditId: z.string().trim().min(1).max(1_000).nullable().optional(),
  })
  .strict();

export const providerRateLimitResetConsumeRequestSchema =
  providerRateLimitResetConsumeInputSchema
    .extend({ workerId: z.string().min(1).max(500) })
    .strict();

export const providerQuotaSnapshotSchema = z.object({
  snapshotId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  workerVersion: z.string().max(200).nullable(),
  codexVersion: z.string().max(500).nullable(),
  windows: z.array(providerQuotaWindowObservationSchema).max(500),
  rateLimitResetCredits: providerRateLimitResetCreditsSummarySchema
    .nullable()
    .default(null),
});

export const providerRateLimitResetConsumeResultSchema = z.object({
  outcome: providerRateLimitResetConsumeOutcomeSchema,
  quotaSnapshot: providerQuotaSnapshotSchema.nullable(),
});

export const chatGptModelInventorySchema = z.object({
  models: z.array(chatGptModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const grokModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  outputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z.array(modelReasoningEffortOptionSchema).max(32),
  defaultReasoningEffort: reasoningEffortSchema.nullable(),
  supportsReasoning: z.boolean(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  rawMetadata: z.record(z.string(), z.unknown()),
});

export const grokModelInventorySchema = z.object({
  models: z.array(grokModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const serviceLogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

export const serviceLogRecordSchema = z.object({
  cursor: z.number().int().positive(),
  timestamp: z.string().datetime(),
  system: z.string().trim().min(1).max(100),
  level: serviceLogLevelSchema,
  message: z.string().max(16_384),
  context: z.unknown().optional(),
});

export const serviceLogReadResultSchema = z.object({
  records: z.array(serviceLogRecordSchema).max(500),
  nextCursor: z.number().int().nonnegative(),
  oldestCursor: z.number().int().positive().nullable(),
  latestCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});

export const workerLogStreamSubscriptionIdSchema = z.string().uuid();

export const workerLogStreamBatchSchema = z
  .object({
    records: z.array(serviceLogRecordSchema).max(200),
    nextCursor: z.number().int().nonnegative(),
    oldestCursor: z.number().int().positive().nullable(),
    latestCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const workerLogStreamStartResultSchema = z
  .object({
    accepted: z.literal(true),
    latestCursor: z.number().int().nonnegative(),
  })
  .strict();

export const workerLogStreamRenewResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const workerLogStreamServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      nextCursor: z.number().int().nonnegative(),
    })
    .strict(),
  workerLogStreamBatchSchema.extend({ type: z.literal("batch") }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum([
        "authorization-failed",
        "invalid-request",
        "worker-offline",
        "stream-unavailable",
      ]),
      message: z.string().min(1).max(500),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const workerLogReadQuerySchema = z
  .object({
    afterCursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    minimumLevel: serviceLogLevelSchema.default("trace"),
  })
  .strict();

const workerRepositoryNameSchema = z.union([
  githubRepositorySchema.shape.nameWithOwner,
  repositoryRoutingHandleSchema,
]);

const customizationWorkerContentFields = {
  operationId: z.string().uuid(),
  serverId: z.string().min(1).max(2_000),
  scope: customizationContentScopeSchema,
};

const protectedCustomizationWorkerRequestFields = {
  ...customizationWorkerContentFields,
  protectedRequest: protectedCustomizationRequestSchema.shape.protectedRequest,
};

export const workerCommandSchema = z.discriminatedUnion("type", [
  directCapabilityPrepareCommandSchema,
  directCapabilityRevokeCommandSchema,
  directCapabilityRenewCommandSchema,
  z.object({ type: z.literal("worker.version") }),
  z.object({ type: z.literal("worker.restart") }),
  workerEncryptionRefreshRequestSchema.extend({
    type: z.literal("worker.encryption.refresh"),
  }),
  z
    .object({
      type: z.literal("code.settings.synchronize"),
      initializeIfMissing: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("code.settings.invalidate"),
      profileId: codeSettingsProfileIdSchema,
      revision: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ type: z.literal("code.settings.status") }).strict(),
  z
    .object({
      type: z.literal("code.settings.resolve"),
      resolution: codeSettingsResolutionSchema,
    })
    .strict(),
  z.object({
    type: z.literal("diagnostics.logs.read"),
    afterCursor: z.number().int().nonnegative().default(0),
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
    provider: workerRuntimeProviderSchema.extend({ kind: z.literal("ollama") }),
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
  z.object({ type: z.literal("github.auth.status") }),
  z.object({
    type: z.literal("github.repositories.cached"),
    login: z.string().min(1),
  }),
  z.object({ type: z.literal("github.repositories.list") }),
  z.object({ type: z.literal("github.repository-owners.list") }),
  z.object({
    type: z.literal("github.repositories.create"),
    request: githubRepositoryCreateSchema,
  }),
  z.object({
    type: z.literal("automation.dispatch.protect"),
    automationId: z.string().uuid(),
    content: projectAutomationOpaqueContentSchema,
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema.nullable(),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("github.issues.list"),
    repository: workerRepositoryNameSchema,
    kind: githubIssueKindSchema.default("issue"),
    state: githubIssueStateSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("github.issue.get"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.issue.create"),
    repository: workerRepositoryNameSchema,
    request: githubIssueCreateSchema,
  }),
  z.object({
    type: z.literal("github.issue.comment"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: z.string().trim().min(1).max(65_536),
  }),
  z.object({
    type: z.literal("github.issue.close"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: z.string().trim().min(1).max(65_536).nullable(),
  }),
  z.object({
    type: z.literal("github.pull-request.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubPullRequestCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-requests.list"),
    repository: workerRepositoryNameSchema,
    state: githubIssueStateSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("github.pull-request.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.pull-request.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.review.submit"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    review: githubPullRequestReviewSubmitSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: githubPullRequestInlineCommentCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.reply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.preview"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    action: githubPullRequestLifecycleActionSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.apply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    request: githubPullRequestLifecycleApplySchema,
  }),
  z.object({
    type: z.literal("github.pull-request.checkout.prepare"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.releases.list"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
  }),
  z.object({
    type: z.literal("github.release.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    releaseId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.release.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubReleaseCreateSchema,
  }),
  z.object({
    type: z.literal("project.clone"),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
  }),
  z.object({
    type: z.literal("project.folder.materialize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid(),
    existingPath: z.string().trim().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("project.folder.delete"),
    projectId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("project.folder-conversion.preflight"),
    projectId: z.string().uuid(),
    repository: projectGithubWireRepositorySchema,
  }),
  z.object({
    type: z.literal("project.folder-conversion.execute"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid(),
    repository: projectGithubWireRepositorySchema,
    confirmationToken:
      projectGithubConversionPreflightReadySchema.shape.confirmationToken,
    initialCommit: projectGithubConversionStartSchema.shape.initialCommit,
  }),
  z.object({
    type: z.literal("project.replica.provision"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    placement: projectReplicaPlacementRequestSchema.optional(),
    expectedRevision: gitObjectRevisionSchema.nullable(),
  }),
  z.object({
    type: z.literal("project.replica.synchronize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedRevision: gitObjectRevisionSchema,
    policy: projectReplicaSynchronizationPolicySchema,
  }),
  z.object({
    type: z.literal("project.replica.remove"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    deleteLocalFiles: z.boolean(),
  }),
  z.object({
    type: z.literal("project.replica.link.repair"),
    projectId: z.string().uuid(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    linkPath: z.string().min(1).max(8_192),
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    type: z.literal("project.files.delete"),
    path: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("project.script-commands"),
      operationId: z.string().uuid(),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.script-commands.inspect"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-configurations.metadata"),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-configurations.inspect"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-configurations.read-authoring"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-configurations.write"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
      protectedRequest: endpointContentOpaqueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-setup.start"),
      operationId: z.string().uuid(),
      serverId: z.string().min(1).max(2_000),
      jobId: worktreeSetupJobSummarySchema.shape.id,
      attempt: z.number().int().positive().safe(),
      projectId: runInstanceSchema.shape.projectId,
      worktreeId: runInstanceSchema.shape.worktreeId,
      sourcePath: z.string().min(1).max(8_192),
      worktreePath: z.string().min(1).max(8_192),
      configurationRevision:
        runConfigurationDefinitionSchema.shape.revision.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run-setup.status"),
      operationId: z.string().uuid(),
      serverId: z.string().min(1).max(2_000),
      jobId: worktreeSetupJobSummarySchema.shape.id,
      projectId: runInstanceSchema.shape.projectId,
      worktreeId: runInstanceSchema.shape.worktreeId,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run.start"),
      requestId: z.string().min(1).max(200),
      rootKind: projectRootKindSchema,
      sourcePath: z.string().min(1).max(8_192),
      worktreePath: z.string().min(1).max(8_192),
    })
    .extend(workerRunIdentitySchema.shape)
    .strict(),
  z
    .object({
      type: z.literal("project.run.status"),
      runId: runInstanceSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run.logs"),
      operationId: z.string().uuid(),
      projectId: runInstanceSchema.shape.projectId,
      worktreeId: runInstanceSchema.shape.worktreeId,
      serverId: z.string().min(1).max(2_000),
      runId: runInstanceSchema.shape.id,
      maxChars: z.number().int().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run.stop"),
      runId: runInstanceSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run.reconcile"),
      runs: z.array(workerRunIdentitySchema).max(256),
    })
    .strict(),
  z.object({
    type: z.literal("project.repository-stats"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("project.folder-stats"),
    root: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("external.chat-history.discover"),
    includeArchived: z.boolean().default(false),
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.attachment.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    attachmentId: externalChatAttachmentSchema.shape.sourceAttachmentId,
    targetAttachmentId: externalChatAttachmentSchema.shape.id,
    operationId: z.string().uuid(),
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("external.chat-history.attachments.release"),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  }),
  z.object({ type: z.literal("browser.services.discover") }),
  z
    .object({
      type: z.literal("mcp.configurations.discover"),
      projectRoot: z.string().min(1).max(8_192).nullable().default(null),
    })
    .strict(),
  z.object({
    type: z.literal("project.share.open"),
    shareId: z.string().min(1).max(200),
    protectedRecord: protectedTunnelContentRecordSchema,
  }),
  z.object({
    type: z.literal("project.share.close"),
    shareId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("git.history"),
    cwd: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z
    .object({
      type: z.literal("git.graph.snapshot"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.metrics"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.commit-overlay"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphCommitOverlayRequestSchema.shape),
  z.object({
    type: z.literal("git.file.history"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.file.blame"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  z.object({
    type: z.literal("git.commit.search"),
    cwd: z.string().min(1).max(8_192),
    query: gitCommitSearchQuerySchema,
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.list"),
    cwd: z.string().min(1).max(8_192),
    kind: z.enum(["reflog", "dangling"]),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRecoveryActionSchema,
  }),
  z.object({
    type: z.literal("git.recovery.apply"),
    cwd: z.string().min(1).max(8_192),
    request: gitRecoveryApplySchema,
  }),
  z.object({
    type: z.literal("git.commit.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    parentIndex: z.number().int().nonnegative().default(0),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z.object({
    type: z.literal("git.commit.signature.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  }),
  z.object({
    type: z.literal("git.refs.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.compare"),
    cwd: z.string().min(1).max(8_192),
    left: z.string().regex(/^[0-9a-f]{40,64}$/u),
    right: z.string().regex(/^[0-9a-f]{40,64}$/u),
    mode: gitComparisonModeSchema,
  }),
  z.object({
    type: z.literal("git.revision.diff"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    baseRevision: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.status"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.diff"),
    cwd: z.string().min(1),
    path: gitRelativePathSchema,
    scope: gitDiffScopeSchema,
  }),
  z.object({
    type: z.literal("git.patch.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitPartialPatchRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.patch.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitPartialPatchApplySchema.shape),
  z.object({
    type: z.literal("git.stash.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.stash.create"),
    cwd: z.string().min(1).max(8_192),
    request: gitStashCreateSchema,
  }),
  z.object({
    type: z.literal("git.stash.diff"),
    cwd: z.string().min(1).max(8_192),
    hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.stash.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitStashActionSchema,
  }),
  z
    .object({
      type: z.literal("git.stash.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitStashActionApplySchema.shape),
  z.object({
    type: z.literal("git.branch.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.branch.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitBranchActionSchema,
  }),
  z
    .object({
      type: z.literal("git.branch.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitBranchActionApplySchema.shape),
  z.object({
    type: z.literal("git.remote.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.remote.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRemoteActionSchema,
  }),
  z
    .object({
      type: z.literal("git.remote.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitRemoteActionApplySchema.shape),
  z.object({
    type: z.literal("git.submodule.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.submodule.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitSubmoduleActionSchema,
  }),
  z
    .object({
      type: z.literal("git.submodule.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitSubmoduleActionApplySchema.shape),
  z.object({
    type: z.literal("git.lfs.status"),
    cwd: z.string().min(1).max(8_192),
    refreshLocks: z.boolean(),
  }),
  z.object({
    type: z.literal("git.lfs.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitLfsActionSchema,
  }),
  z
    .object({
      type: z.literal("git.lfs.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitLfsActionApplySchema.shape),
  z.object({
    type: z.literal("git.tag.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.tag.get"),
    cwd: z.string().min(1).max(8_192),
    name: gitTagNameInputSchema,
  }),
  z.object({
    type: z.literal("git.tag.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitTagActionSchema,
  }),
  z
    .object({
      type: z.literal("git.tag.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitTagActionApplySchema.shape),
  z.object({
    type: z.literal("git.commit.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitCommitActionSchema,
  }),
  z
    .object({
      type: z.literal("git.commit.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitCommitActionApplySchema.shape),
  z.object({
    type: z.literal("git.operation.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitManagedOperationActionSchema,
  }),
  z
    .object({
      type: z.literal("git.operation.start"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitManagedOperationStartSchema.shape),
  z.object({
    type: z.literal("git.operation.inspect"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
  }),
  z.object({
    type: z.literal("git.operation.control"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
    action: gitManagedOperationControlSchema.shape.action,
  }),
  z
    .object({
      type: z.literal("git.operation.amend"),
      cwd: z.string().min(1).max(8_192),
      context: gitManagedOperationContextSchema,
    })
    .extend(gitManagedOperationAmendSchema.shape),
  z.object({
    type: z.literal("git.conflicts.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.conflicts.get"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.conflicts.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitConflictResolutionRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.conflicts.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitConflictResolutionApplySchema.shape),
  z.object({
    type: z.literal("git.action"),
    cwd: z.string().min(1),
    action: gitActionSchema,
  }),
  z.object({
    type: z.literal("git.force-push.preview"),
    cwd: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("git.force-push.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitForcePushApplySchema.shape),
  z
    .object({
      type: z.literal("repository.operation"),
      serverId: z.string().min(1).max(2_000),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      cwd: z.string().min(1).max(8_192),
      sourcePath: z.string().min(1).max(8_192),
      repository: workerRepositoryNameSchema.nullable(),
      agentRuntimes: z
        .array(
          z
            .object({
              routeId: z.string().min(1).max(200),
              model: workerRuntimeModelSchema,
              provider: workerRuntimeProviderSchema,
            })
            .strict(),
        )
        .max(20)
        .default([]),
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
    })
    .extend(repositoryOperationWireRequestSchema.shape)
    .strict(),
  z.object({
    type: z.literal("worktree.list"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.reconcile"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.create"),
    sourcePath: z.string().min(1),
    worktreeId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mode: worktreeCreateModeSchema,
  }),
  z.object({
    type: z.literal("worktree.remove"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    force: z.boolean().default(false),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.lock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    reason: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("worktree.unlock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.prune"),
    sourcePath: z.string().min(1),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.status"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.observation.configure"),
    targets: worktreeObservationTargetsSchema,
    codegraphTargets: codeGraphObservationTargetsSchema.optional(),
  }),
  z.object({
    type: z.literal("codegraph.status"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.sync"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.rebuild"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({ type: z.literal("codegraph.update.check") }),
  z
    .object({
      type: z.literal("explorer.operation"),
      explorerId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      root: z.string().min(1),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({ type: z.literal("code.probe") }),
  z.object({
    type: z.literal("code.open"),
    sessionId: z.string().min(1),
    codeTabId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(200).optional(),
    cwd: z.string().min(1),
    profileId: z.string().min(1).max(200),
    initialFile: repositoryRelativePathSchema.optional(),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
    presentation: codePresentationSchema.default("workbench"),
  }),
  z.object({
    type: z.literal("code.status"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.stop"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.endpoint.revoke"),
    tunnelId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("code.saveAll"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.openFile"),
    sessionId: z.string().min(1),
    path: repositoryRelativePathSchema,
  }),
  z.object({
    type: z.literal("code.getDirtyEditors"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.setTheme"),
    sessionId: z.string().min(1),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.prepareAgentTurn"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.agentTurnState"),
    cwd: z.string().min(1),
    phase: z.enum(["started", "completed", "failed"]),
    paths: z.array(z.string().min(1).max(8_192)).max(5_000).default([]),
  }),
  z.object({
    type: z.literal("skills.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("skills.settings.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.write"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.delete"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("customization.inventory.read"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    forceReload: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.preview"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.resource.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill.configure"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill-roots.set"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.start"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.reload"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.apply"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("permission-profiles.list"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.begin"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  }),
  z.object({
    type: z.literal("attachment.upload.chunk"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    chunk: attachmentChunkOpaqueSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.complete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("attachment.read"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["download", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("attachment.delete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.open"),
      terminalId: z.string().min(1),
      managedRunId: z.string().uuid().nullable().optional(),
      attachmentId: z.string().min(1),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
      cols: z.number().int().min(1).max(1_000),
      rows: z.number().int().min(1).max(1_000),
      launch: z.discriminatedUnion("type", [
        z.object({ type: z.literal("shell") }),
        z.object({
          type: z.literal("codex"),
          threadId: z.string().min(1).nullable(),
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
          permissionProfileId: permissionProfileIdSchema.optional(),
          mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
        }),
      ]),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.detach"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.input"),
      terminalId: z.string().min(1),
      serverId: z.string().min(1).max(2_000),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
      complete: z.boolean().default(false),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.close"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.snapshot"),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({
    type: z.literal("terminal.services.reconcile"),
    services: z.array(terminalServiceRuntimeConfigurationSchema).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.service.restart"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.attach"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      projectId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
      preferredTransport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
      viewport: remoteSurfaceViewportSchema,
      desktopStream: desktopStreamSettingsSchema.nullable().default(null),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.detach"),
    surfaceId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.configure"),
      surfaceId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.suspend"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.resume"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.close"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.desktop.probe"),
  }),
  z
    .object({
      type: z.literal("surface.desktop.targets"),
      serverId: z.string().min(1).max(255),
      operationId: z.string().uuid(),
      resourceId: z.string().min(1).max(200),
      limit: z.number().int().nonnegative().max(2_064),
    })
    .strict(),
  z.object({
    type: z.literal("model.provider.test"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.message.protect"),
    message: chatMessageCreateSchema
      .extend({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(200),
      })
      .strict(),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  z.object({
    type: z.literal("chat.messages.protect"),
    messages: z
      .array(
        chatMessageCreateSchema
          .extend({
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  z.object({
    type: z.literal("chat.messages.reprotect"),
    messages: z
      .array(
        z
          .object({
            source: chatMessageOpaqueSummarySchema,
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
  }),
  z.object({
    type: z.literal("chat.turn.protect"),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    text: z.string().trim().min(1).max(100_000),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("chat.turn"),
      chatId: z.string().min(1),
      clientMessageId: z.string().min(1),
      executionLaneId: z.string().min(1),
      worktreeId: z.string().min(1),
      rootKind: projectRootKindSchema.default("git-worktree"),
      cwd: z.string().min(1),
      isPrimary: z.boolean(),
      worktreeMode: z.enum(["agent-managed", "pinned"]),
      worktreePolicy: worktreePolicySchema,
      policyProjectId: z.string().min(1).max(200),
      policies: effectivePolicyWireListSchema.default({ policies: [] }),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().min(1).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      protectedHistory: z
        .array(chatMessageOpaqueSummarySchema)
        .max(100_000)
        .default([]),
      protectedPlan: chatPlanOpaqueStateSchema.nullable().default(null),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      skillNames: z.array(z.string().min(1)).max(64).default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
      subagentDefaults: z
        .object({
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
        })
        .strict()
        .nullable()
        .optional(),
      subagentProtocolVersion: z
        .literal(NATIVE_SUBAGENT_PROTOCOL_VERSION)
        .optional(),
      permissionProfileId: permissionProfileIdSchema,
      planMode: planModeSchema,
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
      automationPaused: z.boolean().default(false),
      resultMode: agentTurnResultModeSchema.default({ kind: "visible" }),
    })
    .superRefine((command, context) => {
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat turns require exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
      if (
        command.protectedPrompt &&
        command.resultMode.kind !== "chat-message-encrypted"
      ) {
        context.addIssue({
          code: "custom",
          message: "Protected chat prompts require protected chat results.",
          path: ["resultMode"],
        });
      }
    }),
  protectedWorkflowNodeExecutionRequestSchema.extend({
    type: z.literal("workflow.node.execute"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  protectedWorkflowGateDecisionRequestSchema.extend({
    type: z.literal("workflow.gate.decide.protected"),
  }),
  protectedWorkflowTriggerPrepareRequestSchema.extend({
    type: z.literal("workflow.trigger.prepare.protected"),
  }),
  z.object({
    type: z.literal("workflow.definition.generate"),
    generationId: z.string().min(1).max(200),
    cwd: z.string().trim().min(1).max(8_192),
    prompt: z.string().trim().min(1).max(100_000),
    developerInstructions: z.string().trim().min(1).max(100_000),
    outputSchema: workflowJsonObjectSchema,
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60 * 1_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("workflow.repository.scan"),
    cwd: z.string().trim().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("workflow.repository.write"),
    cwd: z.string().trim().min(1).max(8_192),
    document: workflowRepositoryDocumentSchema,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("workflow.node.interrupt"),
    workflowRunId: z.string().min(1).max(200),
    runNodeId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.pause.set"),
    chatId: z.string().min(1),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("chat.compact"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.interrupt"),
    chatId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.turn.rollback"),
    chatId: z.string().min(1),
    clientMessageId: z.string().min(1).max(200),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.get"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.create"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    objective: z.union([
      chatGoalCreateSchema.shape.objective,
      taskOperationRelayGoalSchema,
    ]),
    tokenBudget: chatGoalCreateSchema.shape.tokenBudget,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.update"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    status: chatGoalUpdateSchema.shape.status,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.clear"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.thread.ensure"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.begin"),
    chatId: z.string().min(1).max(200),
    snapshotId: z.string().uuid(),
    transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024 * 1_024),
    cwd: z.string().min(1).max(8_192),
    requiredSkillNames: z.array(z.string().min(1).max(200)).max(64).default([]),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.chunk"),
    snapshotId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative(),
    data: z.string().max(400_000),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.complete"),
    snapshotId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("chat.relocation.thread.release"),
    threadId: z.string().min(1).nullable(),
    discard: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.plan.get"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    fallbackMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.set"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    mode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond"),
    requestKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond.protected"),
    requestKey: z.string().min(1).max(200),
    response: interactionResponseOpaqueContentSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cancel"),
    requestKey: z.string().min(1).max(200),
    reason: z.string().min(1).max(4_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z
    .object({
      type: z.literal("chat.steer"),
      chatId: z.string().min(1),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().trim().min(1).max(100_000).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
    })
    .superRefine((command, context) => {
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat steering requires exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
    }),
  z.object({
    type: z.literal("chat.sync"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
]);

export const workerRequestEnvelopeSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  command: workerCommandSchema,
});

export const workerResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ message: z.string().min(1) }),
  }),
]);

const protectedAgentEventTelemetrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    phase: agentMessagePhaseSchema.nullable(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("activity"),
    activityType: z.string().min(1).max(100),
    turnId: z.string().min(1).nullable(),
    agentRuntime: z
      .object({
        agentThreadId: z.string().min(1).max(200),
        isRoot: z.boolean(),
        startedAtMs: agentActivityTimestampSchema.nullable(),
        completedAtMs: agentActivityTimestampSchema.nullable(),
        status: z.enum(["running", "completed", "failed"]),
      })
      .strict()
      .nullable()
      .optional(),
  }),
  z.object({
    kind: z.literal("usage"),
    usage: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("checkpoint"),
    turnId: z.string().min(1),
  }),
]);

export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project.replica.progress"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    progress: projectReplicaJobProgressEventSchema,
  }),
  z.object({
    type: z.literal("agent.activity"),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("agent.message"),
    message: normalizedAgentMessageSchema,
  }),
  z
    .object({
      type: z.literal("agent.protected-message"),
      message: chatMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.protected-task-message"),
      message: taskMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z.object({ type: z.literal("terminal.ready") }),
  z.object({
    type: z.literal("agent.checkpoint"),
    turnId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.plan.updated"),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("agent.plan.question"),
    question: pendingPlanQuestionSchema,
  }),
  z.object({
    type: z.literal("agent.plan.question-resolved"),
    questionId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("agent.plan.protected"),
      turnId: z.string().min(1).nullable(),
      state: chatPlanOpaqueStateSchema,
    })
    .strict(),
  z.object({
    type: z.literal("agent.interaction.requested"),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.requested.protected"),
    request: encryptedAgentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cleared"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("agent.interaction.expired"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("workflow.node.activity"),
    attemptId: z.string().min(1).max(200),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("workflow.node.message"),
    attemptId: z.string().min(1).max(200),
    message: normalizedAgentMessageSchema,
  }),
  z.object({
    type: z.literal("workflow.node.plan.updated"),
    attemptId: z.string().min(1).max(200),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.requested"),
    attemptId: z.string().min(1).max(200),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("workflow.node.interaction.requested.protected"),
    attemptId: z.string().min(1).max(200),
    request: encryptedAgentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("workflow.node.interaction.cleared"),
    attemptId: z.string().min(1).max(200),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.expired"),
    attemptId: z.string().min(1).max(200),
    requestKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.output"),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
    })
    .strict(),
]);

export const workerEventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  requestId: z.string().min(1),
  event: workerEventSchema,
});

export const workerNotificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat.turn.outcome"),
    chatId: z.string().min(1),
    clientMessageId: z.string().min(1),
    executionLaneId: z.string().min(1),
    worktreeId: z.string().min(1),
    outcome: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        result: agentTurnResultSchema,
      }),
      z.object({
        ok: z.literal(false),
        error: z.string().min(1),
      }),
    ]),
  }),
  z
    .object({
      type: z.literal("chat.thread.changed"),
      threadId: z.string().min(1).max(200),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      changes: z
        .array(z.enum(["turn", "goal", "queue", "plan"]))
        .min(1)
        .max(4),
    })
    .strict(),
  workerLogStreamBatchSchema
    .extend({
      type: z.literal("diagnostics.logs.observed"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
    })
    .strict(),
  z.object({
    type: z.literal("worktree.inventory.observed"),
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    inventory: worktreeInventorySchema,
  }),
  z.object({
    type: z.literal("worktree.status.observed"),
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    result: worktreeStatusResultSchema,
  }),
  z
    .object({
      type: z.literal("git.operation.observed"),
      projectId: z.string().uuid(),
      worktreeId: z.string().min(1).max(200),
      operationId: z.string().uuid(),
      sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
      worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
      observedAt: z.string().datetime({ offset: true }),
      state: gitOperationObservationStateSchema,
      conflicts: z
        .object({
          files: z.array(gitConflictSummarySchema).max(2_000),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("codegraph.status.observed"),
      status: codeGraphProjectStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.run.state.observed"),
      run: workerRunSnapshotSchema,
    })
    .strict(),
  providerAuthStatusObservationSchema,
]);

export const workerNotificationEnvelopeSchema = z.object({
  kind: z.literal("notification"),
  notification: workerNotificationSchema,
});

export const workerServerEnvelopeSchema = z.union([
  workerResponseEnvelopeSchema,
  workerEventEnvelopeSchema,
  workerNotificationEnvelopeSchema,
]);

export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;
export type BootstrapMode = z.infer<typeof bootstrapModeSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type AuthenticationState = z.infer<typeof authenticationStateSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type RemoteSurfaceKind = z.infer<typeof remoteSurfaceKindSchema>;
export type RemoteSurfaceTransport = z.infer<
  typeof remoteSurfaceTransportSchema
>;
export type RemoteSurfaceStatus = z.infer<typeof remoteSurfaceStatusSchema>;
export type RemoteSurfaceChannel = z.infer<typeof remoteSurfaceChannelSchema>;
export type RemoteSurfaceCapabilities = z.infer<
  typeof remoteSurfaceCapabilitiesSchema
>;
export type CodeTransport = z.infer<typeof codeTransportSchema>;
export type CodeCapabilities = z.infer<typeof codeCapabilitiesSchema>;
export type UserSummary = z.infer<typeof userSummarySchema>;
export type AccountSessionSummary = z.infer<typeof accountSessionSummarySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventList = z.infer<typeof auditEventListSchema>;
export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;
export type AccountRegistration = z.infer<typeof accountRegistrationSchema>;
export type AccountLicenseWhitelistEntry = z.infer<
  typeof accountLicenseWhitelistEntrySchema
>;
export type AccountLicenseWhitelistCreate = z.infer<
  typeof accountLicenseWhitelistCreateSchema
>;
export type AccountAdminSummary = z.infer<typeof accountAdminSummarySchema>;
export type AuthLogin = z.infer<typeof authLoginSchema>;
export type AuthReauthentication = z.infer<typeof authReauthenticationSchema>;
export type AuthReauthenticationResult = z.infer<
  typeof authReauthenticationResultSchema
>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthSessionState = z.infer<typeof authSessionStateSchema>;
export type MobileSignInGrantCreateResult = z.infer<
  typeof mobileSignInGrantCreateResultSchema
>;
export type MobileSignInGrantExchange = z.infer<
  typeof mobileSignInGrantExchangeSchema
>;
export type MobileSignInQrPayload = z.infer<typeof mobileSignInQrPayloadSchema>;
export type AuthLogoutAllResult = z.infer<typeof authLogoutAllResultSchema>;
export type ServerBootstrap = z.infer<typeof serverBootstrapSchema>;
export type DesktopUpdateActiveWorkSummary = z.infer<
  typeof desktopUpdateActiveWorkSummarySchema
>;
export type CantripVersion = z.infer<typeof cantripVersionSchema>;
export type CodexRuntimeMethodState = z.infer<
  typeof codexRuntimeMethodStateSchema
>;
export type CodexRuntimeFeatureStage = z.infer<
  typeof codexRuntimeFeatureStageSchema
>;
export type CodexRuntimeFeature = z.infer<typeof codexRuntimeFeatureSchema>;
export type NativeSubagentRuntimeCapability = z.infer<
  typeof nativeSubagentRuntimeCapabilitySchema
>;
export type CodexRuntimeReport = z.infer<typeof codexRuntimeReportSchema>;
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
export type WorkerSummary = z.infer<typeof workerSummarySchema>;
export type ProjectReplicaCapabilities = z.infer<
  typeof projectReplicaCapabilitiesSchema
>;
export type ProjectReplicaPlacementMode = z.infer<
  typeof projectReplicaPlacementModeSchema
>;
export type ProjectReplicaPlacementRequest = z.infer<
  typeof projectReplicaPlacementRequestSchema
>;
export type EncryptedProjectReplicaPlacementRequest = z.infer<
  typeof encryptedProjectReplicaPlacementRequestSchema
>;
export type ProjectReplicaMaterialization = z.infer<
  typeof projectReplicaMaterializationSchema
>;
export type ProjectReplicaOwnershipKind = z.infer<
  typeof projectReplicaOwnershipKindSchema
>;
export type ProjectReplicaPlacementResult = z.infer<
  typeof projectReplicaPlacementResultSchema
>;
export type ManagedFolderCapabilities = z.infer<
  typeof managedFolderCapabilitiesSchema
>;
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
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SystemHealth = z.infer<typeof systemHealthSchema>;
export type OperationalProbe = z.infer<typeof operationalProbeSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
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
export type McpServerConfiguration = z.infer<
  typeof mcpServerConfigurationSchema
>;
export type McpServerScope = z.infer<typeof mcpServerScopeSchema>;
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type EncryptedMcpServerCreate = z.infer<
  typeof encryptedMcpServerCreateSchema
>;
export type EncryptedMcpServerUpdate = z.infer<
  typeof encryptedMcpServerUpdateSchema
>;
export type McpServerDiscoverySource = z.infer<
  typeof mcpServerDiscoverySourceSchema
>;
export type McpServerDiscoveryScope = z.infer<
  typeof mcpServerDiscoveryScopeSchema
>;
export type McpServerDiscoveryCandidate = z.infer<
  typeof mcpServerDiscoveryCandidateSchema
>;
export type McpServerDiscoveryIssue = z.infer<
  typeof mcpServerDiscoveryIssueSchema
>;
export type McpServerDiscoveryResult = z.infer<
  typeof mcpServerDiscoveryResultSchema
>;
export type McpServerWireSummary = z.infer<typeof mcpServerWireSummarySchema>;
export type McpServerCopy = z.infer<typeof mcpServerCopySchema>;
export type MobileProjectTabConfigurations = z.infer<
  typeof mobileProjectTabConfigurationsSchema
>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;
export type SettingsBundle = z.infer<typeof settingsBundleSchema>;
export type SettingsBundleWire = z.infer<typeof settingsBundleWireSchema>;
export type ProjectOriginKind = z.infer<typeof projectOriginKindSchema>;
export type ProjectFolderManagement = z.infer<
  typeof projectFolderManagementSchema
>;
export type ProjectSourceKind = z.infer<typeof projectSourceKindSchema>;
export type ProjectRootKind = z.infer<typeof projectRootKindSchema>;
export type ProjectCapabilities = z.infer<typeof projectCapabilitiesSchema>;
export type ProjectCapability = z.infer<typeof projectCapabilitySchema>;
export type ProjectCapabilityUnavailableError = z.infer<
  typeof projectCapabilityUnavailableErrorSchema
>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectWireSummary = z.infer<typeof projectWireSummarySchema>;
export type ProjectPreferredWorkerUpdate = z.infer<
  typeof projectPreferredWorkerUpdateSchema
>;
export type ProjectReplicaSummary = z.infer<typeof projectReplicaSummarySchema>;
export type ProjectReplicaJobKind = z.infer<typeof projectReplicaJobKindSchema>;
export type ProjectReplicaJobState = z.infer<
  typeof projectReplicaJobStateSchema
>;
export type ProjectReplicaJobErrorCode = z.infer<
  typeof projectReplicaJobErrorCodeSchema
>;
export type ProjectReplicaJobError = z.infer<
  typeof projectReplicaJobErrorSchema
>;
export type ProjectReplicaJobProgress = z.infer<
  typeof projectReplicaJobProgressSchema
>;
export type ProjectReplicaJobProgressEvent = z.infer<
  typeof projectReplicaJobProgressEventSchema
>;
export type ProjectReplicaJobSummary = z.infer<
  typeof projectReplicaJobSummarySchema
>;
export type ProjectReplicaProvisionCreate = z.infer<
  typeof projectReplicaProvisionCreateSchema
>;
export type EncryptedProjectReplicaProvisionCreate = z.infer<
  typeof encryptedProjectReplicaProvisionCreateSchema
>;
export type ProjectReplicaSynchronizationPolicy = z.infer<
  typeof projectReplicaSynchronizationPolicySchema
>;
export type ProjectReplicaSynchronizeCreate = z.infer<
  typeof projectReplicaSynchronizeCreateSchema
>;
export type EncryptedProjectReplicaSynchronizeCreate = z.infer<
  typeof encryptedProjectReplicaSynchronizeCreateSchema
>;
export type ProjectReplicaRemoveCreate = z.infer<
  typeof projectReplicaRemoveCreateSchema
>;
export type EncryptedProjectReplicaRemoveCreate = z.infer<
  typeof encryptedProjectReplicaRemoveCreateSchema
>;
export type ProjectReplicaJobRetry = z.infer<
  typeof projectReplicaJobRetrySchema
>;
export type ProjectReplicaJobCancel = z.infer<
  typeof projectReplicaJobCancelSchema
>;
export type ProjectRepositoryStats = z.infer<
  typeof projectRepositoryStatsSchema
>;
export type ProjectGitRepositoryStats = z.infer<
  typeof projectGitRepositoryStatsSchema
>;
export type ProjectFolderStats = z.infer<typeof projectFolderStatsSchema>;
export type ProjectTokenUsageDay = z.infer<typeof projectTokenUsageDaySchema>;
export type ProjectTokenUsageBreakdown = z.infer<
  typeof projectTokenUsageBreakdownSchema
>;
export type ProjectTokenUsage = z.infer<typeof projectTokenUsageSchema>;
export type TelemetryValueStatistics = z.infer<
  typeof telemetryValueStatisticsSchema
>;
export type TelemetryQuotaReading = z.infer<typeof telemetryQuotaReadingSchema>;
export type TelemetryBreakdown = z.infer<typeof telemetryBreakdownSchema>;
export type ModelBehaviorSummary = z.infer<typeof modelBehaviorSummarySchema>;
export type TelemetryChangeMetric = z.infer<typeof telemetryChangeMetricSchema>;
export type TelemetryChangePoint = z.infer<typeof telemetryChangePointSchema>;
export type ProviderTelemetryAnalytics = z.infer<
  typeof providerTelemetryAnalyticsSchema
>;
export type ProviderTelemetryWireAnalytics = z.infer<
  typeof providerTelemetryWireAnalyticsSchema
>;
export type ProviderTelemetryExport = z.infer<
  typeof providerTelemetryExportSchema
>;
export type ProviderTelemetryDeleteResult = z.infer<
  typeof providerTelemetryDeleteResultSchema
>;
export type ProjectWorkspaceCreate = z.infer<
  typeof projectWorkspaceCreateSchema
>;
export type ProjectWorkspaceUpdate = z.infer<
  typeof projectWorkspaceUpdateSchema
>;
export type ProjectWorkspaceSummary = z.infer<
  typeof projectWorkspaceSummarySchema
>;
export type EncryptedProjectWorkspaceName = z.infer<
  typeof encryptedProjectWorkspaceNameSchema
>;
export type ProjectWorkspaceWireSummary = z.infer<
  typeof projectWorkspaceWireSummarySchema
>;
export type ProjectWorkspaceWireList = z.infer<
  typeof projectWorkspaceWireListSchema
>;
export type EncryptedProjectWorkspaceCreate = z.infer<
  typeof encryptedProjectWorkspaceCreateSchema
>;
export type EncryptedProjectWorkspaceUpdate = z.infer<
  typeof encryptedProjectWorkspaceUpdateSchema
>;
export type ExecutionSurfaceKind = z.infer<typeof executionSurfaceKindSchema>;
export type ExecutionPlacement = z.infer<typeof executionPlacementSchema>;
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export type ExecutionPlacementSelection = z.infer<
  typeof executionPlacementSelectionSchema
>;
export type ExecutionPlacementResolveRequest = z.infer<
  typeof executionPlacementResolveRequestSchema
>;
export type ExecutionPlacementResolution = z.infer<
  typeof executionPlacementResolutionSchema
>;
export type ExecutionTargetResourceKind = z.infer<
  typeof executionTargetResourceKindSchema
>;
export type ExecutionTargetAvailability = z.infer<
  typeof executionTargetAvailabilitySchema
>;
export type ExecutionTargetResolution = z.infer<
  typeof executionTargetResolutionSchema
>;
export type ExecutionTargetResolveRequest = z.infer<
  typeof executionTargetResolveRequestSchema
>;
export type ExecutionTargetDescriptor = z.infer<
  typeof executionTargetDescriptorSchema
>;
export type ExecutionTargetWireDescriptor = z.infer<
  typeof executionTargetWireDescriptorSchema
>;
export type ExecutionTargetCatalog = z.infer<
  typeof executionTargetCatalogSchema
>;
export type ExecutionTargetWireCatalog = z.infer<
  typeof executionTargetWireCatalogSchema
>;
export type TunnelOrigin = z.infer<typeof tunnelOriginSchema>;
export type TunnelManagement = z.infer<typeof tunnelManagementSchema>;
export type TunnelProtocolHint = z.infer<typeof tunnelProtocolHintSchema>;
export type TunnelDesiredState = z.infer<typeof tunnelDesiredStateSchema>;
export type TunnelStatus = z.infer<typeof tunnelStatusSchema>;
export type TunnelSourceEndpoint = z.infer<typeof tunnelSourceEndpointSchema>;
export type TunnelDestinationEndpoint = z.infer<
  typeof tunnelDestinationEndpointSchema
>;
export type TunnelManagedResource = z.infer<typeof tunnelManagedResourceSchema>;
export type TunnelUserCreate = z.infer<typeof tunnelUserCreateSchema>;
export type TunnelUserUpdate = z.infer<typeof tunnelUserUpdateSchema>;
export type TunnelUserWireCreate = z.infer<typeof tunnelUserWireCreateSchema>;
export type TunnelUserWireUpdate = z.infer<typeof tunnelUserWireUpdateSchema>;
export type TunnelAttachmentCreate = z.infer<
  typeof tunnelAttachmentCreateSchema
>;
export type TunnelAttachmentCreateResult = z.infer<
  typeof tunnelAttachmentCreateResultSchema
>;
export type TunnelAttachmentInitialize = z.infer<
  typeof tunnelAttachmentInitializeSchema
>;
export type TunnelAttachmentReady = z.infer<typeof tunnelAttachmentReadySchema>;
export type TunnelManagedRegistration = z.infer<
  typeof tunnelManagedRegistrationSchema
>;
export type TunnelAttachmentKind = z.infer<typeof tunnelAttachmentKindSchema>;
export type TunnelAttachmentSummary = z.infer<
  typeof tunnelAttachmentSummarySchema
>;
export type TunnelAttachmentWireSummary = z.infer<
  typeof tunnelAttachmentWireSummarySchema
>;
export type TunnelActionCapabilities = z.infer<
  typeof tunnelActionCapabilitiesSchema
>;
export type TunnelSummary = z.infer<typeof tunnelSummarySchema>;
export type TunnelWireSummary = z.infer<typeof tunnelWireSummarySchema>;
export type WorktreePolicy = z.infer<typeof worktreePolicySchema>;
export type WorktreeOrigin = z.infer<typeof worktreeOriginSchema>;
export type WorktreeLifecycleState = z.infer<
  typeof worktreeLifecycleStateSchema
>;
export type ProjectWorktreeSummary = z.infer<
  typeof projectWorktreeSummarySchema
>;
export type GithubAuthStatus = z.infer<typeof githubAuthStatusSchema>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type GithubRepositoryOwner = z.infer<typeof githubRepositoryOwnerSchema>;
export type GithubRepositoryVisibility = z.infer<
  typeof githubRepositoryVisibilitySchema
>;
export type GithubRepositoryCreate = z.infer<
  typeof githubRepositoryCreateSchema
>;
export type GithubIssueState = z.infer<typeof githubIssueStateSchema>;
export type GithubIssueKind = z.infer<typeof githubIssueKindSchema>;
export type GithubIssueSummary = z.infer<typeof githubIssueSummarySchema>;
export type GithubIssueList = z.infer<typeof githubIssueListSchema>;
export type GithubPullRequestList = z.infer<typeof githubPullRequestListSchema>;
export type GithubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GithubIssueDetail = z.infer<typeof githubIssueDetailSchema>;
export type GithubIssueCreate = z.infer<typeof githubIssueCreateSchema>;
export type GithubPullRequestCreate = z.infer<
  typeof githubPullRequestCreateSchema
>;
export type GithubPullRequestSummary = z.infer<
  typeof githubPullRequestSummarySchema
>;
export type GithubPullRequestCreateResult = z.infer<
  typeof githubPullRequestCreateResultSchema
>;
export type GithubPullRequestCommit = z.infer<
  typeof githubPullRequestCommitSchema
>;
export type GithubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>;
export type GithubPullRequestCheck = z.infer<
  typeof githubPullRequestCheckSchema
>;
export type GithubPullRequestReview = z.infer<
  typeof githubPullRequestReviewSchema
>;
export type GithubPullRequestReviewComment = z.infer<
  typeof githubPullRequestReviewCommentSchema
>;
export type GithubPullRequestReviewThread = z.infer<
  typeof githubPullRequestReviewThreadSchema
>;
export type GithubPullRequestReviewSubmit = z.infer<
  typeof githubPullRequestReviewSubmitSchema
>;
export type GithubPullRequestInlineCommentCreate = z.infer<
  typeof githubPullRequestInlineCommentCreateSchema
>;
export type GithubPullRequestReviewAction = z.infer<
  typeof githubPullRequestReviewActionSchema
>;
export type GithubPullRequestLifecycleAction = z.infer<
  typeof githubPullRequestLifecycleActionSchema
>;
export type GithubPullRequestLifecyclePreview = z.infer<
  typeof githubPullRequestLifecyclePreviewSchema
>;
export type GithubPullRequestLifecycleApply = z.infer<
  typeof githubPullRequestLifecycleApplySchema
>;
export type GithubPullRequestCheckoutPrepared = z.infer<
  typeof githubPullRequestCheckoutPreparedSchema
>;
export type GithubPullRequestCheckoutResult = z.infer<
  typeof githubPullRequestCheckoutResultSchema
>;
export type GithubPullRequestDetail = z.infer<
  typeof githubPullRequestDetailSchema
>;
export type GithubReleaseSummary = z.infer<typeof githubReleaseSummarySchema>;
export type GithubReleaseList = z.infer<typeof githubReleaseListSchema>;
export type GithubReleaseCreate = z.infer<typeof githubReleaseCreateSchema>;
export type GithubWorkerRepository = z.infer<
  typeof githubWorkerRepositorySchema
>;
export type GithubProjectCreate = z.infer<typeof githubProjectCreateSchema>;
export type EncryptedGithubProjectCreate = z.infer<
  typeof encryptedGithubProjectCreateSchema
>;
export type ManagedFolderProjectCreate = z.infer<
  typeof managedFolderProjectCreateSchema
>;
export type EncryptedManagedFolderProjectCreate = z.infer<
  typeof encryptedManagedFolderProjectCreateSchema
>;
export type ProjectCloneResult = z.infer<typeof projectCloneResultSchema>;
export type ManagedFolderMaterializeReady = z.infer<
  typeof managedFolderMaterializeReadySchema
>;
export type ManagedFolderDeleteResult = z.infer<
  typeof managedFolderDeleteResultSchema
>;
export type ProjectFolderSetupJobState = z.infer<
  typeof projectFolderSetupJobStateSchema
>;
export type ProjectFolderSetupJobError = z.infer<
  typeof projectFolderSetupJobErrorSchema
>;
export type ProjectFolderSetupJobSummary = z.infer<
  typeof projectFolderSetupJobSummarySchema
>;
export type ProjectGithubConversionRepository = z.infer<
  typeof projectGithubConversionRepositorySchema
>;
export type ProjectGithubRoutingRepository = z.infer<
  typeof projectGithubRoutingRepositorySchema
>;
export type ProjectGithubConversionError = z.infer<
  typeof projectGithubConversionErrorSchema
>;
export type ProjectGithubConversionJobError = z.infer<
  typeof projectGithubConversionJobErrorSchema
>;
export type ProjectGithubConversionPreflightResult = z.infer<
  typeof projectGithubConversionPreflightResultSchema
>;
export type ProjectGithubConversionPreflightReady = z.infer<
  typeof projectGithubConversionPreflightReadySchema
>;
export type ProjectGithubConversionPreflightRequest = z.infer<
  typeof projectGithubConversionPreflightRequestSchema
>;
export type EncryptedProjectGithubConversionPreflightRequest = z.infer<
  typeof encryptedProjectGithubConversionPreflightRequestSchema
>;
export type ProjectGithubConversionStart = z.infer<
  typeof projectGithubConversionStartSchema
>;
export type EncryptedProjectGithubConversionStart = z.infer<
  typeof encryptedProjectGithubConversionStartSchema
>;
export type ProjectGithubConversionJobState = z.infer<
  typeof projectGithubConversionJobStateSchema
>;
export type ProjectGithubConversionJobSummary = z.infer<
  typeof projectGithubConversionJobSummarySchema
>;
export type ProjectGithubConversionReady = z.infer<
  typeof projectGithubConversionReadySchema
>;
export type ProjectGithubConversionExecutionResult = z.infer<
  typeof projectGithubConversionExecutionResultSchema
>;
export type ProjectReplicaProvisionResult = z.infer<
  typeof projectReplicaProvisionResultSchema
>;
export type ProjectReplicaSynchronizeResult = z.infer<
  typeof projectReplicaSynchronizeResultSchema
>;
export type ProjectReplicaRemoveResult = z.infer<
  typeof projectReplicaRemoveResultSchema
>;
export type ProjectReplicaLinkRepairResult = z.infer<
  typeof projectReplicaLinkRepairResultSchema
>;
export type ProjectRemove = z.infer<typeof projectRemoveSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitFileHistoryEntry = z.infer<typeof gitFileHistoryEntrySchema>;
export type GitFileHistory = z.infer<typeof gitFileHistorySchema>;
export type GitBlameRange = z.infer<typeof gitBlameRangeSchema>;
export type GitBlame = z.infer<typeof gitBlameSchema>;
export type GitGraphNodeKind = z.infer<typeof gitGraphNodeKindSchema>;
export type GitGraphMetricState = z.infer<typeof gitGraphMetricStateSchema>;
export type GitGraphAnalysisState = z.infer<typeof gitGraphAnalysisStateSchema>;
export type GitGraphNode = z.infer<typeof gitGraphNodeSchema>;
export type GitGraphSnapshot = z.infer<typeof gitGraphSnapshotSchema>;
export type GitGraphNodeMetrics = z.infer<typeof gitGraphNodeMetricsSchema>;
export type GitGraphMetrics = z.infer<typeof gitGraphMetricsSchema>;
export type GitGraphRequest = z.infer<typeof gitGraphRequestSchema>;
export type GitGraphCommitOverlayRequest = z.infer<
  typeof gitGraphCommitOverlayRequestSchema
>;
export type GitGraphCommitOverlayNode = z.infer<
  typeof gitGraphCommitOverlayNodeSchema
>;
export type GitGraphCommitOverlay = z.infer<typeof gitGraphCommitOverlaySchema>;
export type GitCommitSearchQuery = z.infer<typeof gitCommitSearchQuerySchema>;
export type GitCommitSearchResult = z.infer<typeof gitCommitSearchResultSchema>;
export type GitRecoveryCandidate = z.infer<typeof gitRecoveryCandidateSchema>;
export type GitRecoveryCandidateList = z.infer<
  typeof gitRecoveryCandidateListSchema
>;
export type GitRecoveryAction = z.infer<typeof gitRecoveryActionSchema>;
export type GitRecoveryPreview = z.infer<typeof gitRecoveryPreviewSchema>;
export type GitRecoveryApply = z.infer<typeof gitRecoveryApplySchema>;
export type GitRecoveryResult = z.infer<typeof gitRecoveryResultSchema>;
export type GitCommitPerson = z.infer<typeof gitCommitPersonSchema>;
export type GitSignature = z.infer<typeof gitSignatureSchema>;
export type GitAgentDraftTask = z.infer<typeof gitAgentDraftTaskSchema>;
export type GitAgentDraftCreate = z.infer<typeof gitAgentDraftCreateSchema>;
export type GitAgentDraftResult = z.infer<typeof gitAgentDraftResultSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;
export type GitRevisionFileDiff = z.infer<typeof gitRevisionFileDiffSchema>;
export type GitRevisionCandidate = z.infer<typeof gitRevisionCandidateSchema>;
export type GitComparisonMode = z.infer<typeof gitComparisonModeSchema>;
export type GitComparisonCommit = z.infer<typeof gitComparisonCommitSchema>;
export type GitComparison = z.infer<typeof gitComparisonSchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiffScope = z.infer<typeof gitDiffScopeSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitPartialPatchOperation = z.infer<
  typeof gitPartialPatchOperationSchema
>;
export type GitPartialPatchRequest = z.infer<
  typeof gitPartialPatchRequestSchema
>;
export type GitPartialPatchPreview = z.infer<
  typeof gitPartialPatchPreviewSchema
>;
export type GitPartialPatchApply = z.infer<typeof gitPartialPatchApplySchema>;
export type GitStashFile = z.infer<typeof gitStashFileSchema>;
export type GitStashSummary = z.infer<typeof gitStashSummarySchema>;
export type GitStashList = z.infer<typeof gitStashListSchema>;
export type GitStashCreate = z.infer<typeof gitStashCreateSchema>;
export type GitStashAction = z.infer<typeof gitStashActionSchema>;
export type GitStashActionPreview = z.infer<typeof gitStashActionPreviewSchema>;
export type GitStashActionApply = z.infer<typeof gitStashActionApplySchema>;
export type GitStashMutationResult = z.infer<
  typeof gitStashMutationResultSchema
>;
export type GitStashFileDiff = z.infer<typeof gitStashFileDiffSchema>;
export type GitBranchCommitSummary = z.infer<
  typeof gitBranchCommitSummarySchema
>;
export type GitManagedBranch = z.infer<typeof gitManagedBranchSchema>;
export type GitPullStrategy = z.infer<typeof gitPullStrategySchema>;
export type GitBranchList = z.infer<typeof gitBranchListSchema>;
export type GitBranchAction = z.infer<typeof gitBranchActionSchema>;
export type GitBranchActionPreview = z.infer<
  typeof gitBranchActionPreviewSchema
>;
export type GitBranchActionApply = z.infer<typeof gitBranchActionApplySchema>;
export type GitBranchMutationResult = z.infer<
  typeof gitBranchMutationResultSchema
>;
export type GitRemoteSummary = z.infer<typeof gitRemoteSummarySchema>;
export type GitRemoteList = z.infer<typeof gitRemoteListSchema>;
export type GitRemoteAction = z.infer<typeof gitRemoteActionSchema>;
export type GitRemoteActionPreview = z.infer<
  typeof gitRemoteActionPreviewSchema
>;
export type GitRemoteActionApply = z.infer<typeof gitRemoteActionApplySchema>;
export type GitRemoteMutationResult = z.infer<
  typeof gitRemoteMutationResultSchema
>;
export type GitSubmoduleSummary = z.infer<typeof gitSubmoduleSummarySchema>;
export type GitSubmoduleList = z.infer<typeof gitSubmoduleListSchema>;
export type GitSubmoduleAction = z.infer<typeof gitSubmoduleActionSchema>;
export type GitSubmoduleActionPreview = z.infer<
  typeof gitSubmoduleActionPreviewSchema
>;
export type GitSubmoduleActionApply = z.infer<
  typeof gitSubmoduleActionApplySchema
>;
export type GitSubmoduleMutationResult = z.infer<
  typeof gitSubmoduleMutationResultSchema
>;
export type GitLfsTrackedPattern = z.infer<typeof gitLfsTrackedPatternSchema>;
export type GitLfsFile = z.infer<typeof gitLfsFileSchema>;
export type GitLfsLock = z.infer<typeof gitLfsLockSchema>;
export type GitLfsStatus = z.infer<typeof gitLfsStatusSchema>;
export type GitLfsAction = z.infer<typeof gitLfsActionSchema>;
export type GitLfsActionPreview = z.infer<typeof gitLfsActionPreviewSchema>;
export type GitLfsActionApply = z.infer<typeof gitLfsActionApplySchema>;
export type GitLfsMutationResult = z.infer<typeof gitLfsMutationResultSchema>;
export type GitTagSummary = z.infer<typeof gitTagSummarySchema>;
export type GitTagDetail = z.infer<typeof gitTagDetailSchema>;
export type GitTagList = z.infer<typeof gitTagListSchema>;
export type GitTagAction = z.infer<typeof gitTagActionSchema>;
export type GitTagActionPreview = z.infer<typeof gitTagActionPreviewSchema>;
export type GitTagActionApply = z.infer<typeof gitTagActionApplySchema>;
export type GitTagMutationResult = z.infer<typeof gitTagMutationResultSchema>;
export type GitCherryPickSelection = z.infer<
  typeof gitCherryPickSelectionSchema
>;
export type GitCommitAction = z.infer<typeof gitCommitActionSchema>;
export type GitOperationSummary = z.infer<typeof gitOperationSummarySchema>;
export type GitManagedOperationType = z.infer<
  typeof gitManagedOperationTypeSchema
>;
export type GitManagedOperationState = z.infer<
  typeof gitManagedOperationStateSchema
>;
export type GitMergeRebaseAction = z.infer<typeof gitMergeRebaseActionSchema>;
export type GitBisectAction = z.infer<typeof gitBisectActionSchema>;
export type GitManagedOperationAction = z.infer<
  typeof gitManagedOperationActionSchema
>;
export type GitInteractiveRebaseTodoAction = z.infer<
  typeof gitInteractiveRebaseTodoActionSchema
>;
export type GitInteractiveRebaseTodoItem = z.infer<
  typeof gitInteractiveRebaseTodoItemSchema
>;
export type GitManagedOperationContext = z.infer<
  typeof gitManagedOperationContextSchema
>;
export type GitManagedOperationWorkerState = z.infer<
  typeof gitManagedOperationWorkerStateSchema
>;
export type GitOperationObservationState = z.infer<
  typeof gitOperationObservationStateSchema
>;
export type GitManagedOperationPreview = z.infer<
  typeof gitManagedOperationPreviewSchema
>;
export type GitManagedOperationStart = z.infer<
  typeof gitManagedOperationStartSchema
>;
export type GitManagedOperationControl = z.infer<
  typeof gitManagedOperationControlSchema
>;
export type GitManagedOperationAmend = z.infer<
  typeof gitManagedOperationAmendSchema
>;
export type GitManagedOperationRecord = z.infer<
  typeof gitManagedOperationRecordSchema
>;
export type GitManagedOperationResponse = z.infer<
  typeof gitManagedOperationResponseSchema
>;
export type GitConflictKind = z.infer<typeof gitConflictKindSchema>;
export type GitConflictStage = z.infer<typeof gitConflictStageSchema>;
export type GitConflictSummary = z.infer<typeof gitConflictSummarySchema>;
export type GitConflictList = z.infer<typeof gitConflictListSchema>;
export type GitConflictDetail = z.infer<typeof gitConflictDetailSchema>;
export type GitConflictResolutionStrategy = z.infer<
  typeof gitConflictResolutionStrategySchema
>;
export type GitConflictResolutionRequest = z.infer<
  typeof gitConflictResolutionRequestSchema
>;
export type GitConflictResolutionPreview = z.infer<
  typeof gitConflictResolutionPreviewSchema
>;
export type GitConflictResolutionApply = z.infer<
  typeof gitConflictResolutionApplySchema
>;
export type GitConflictResolutionResult = z.infer<
  typeof gitConflictResolutionResultSchema
>;
export type GitCommitActionPreview = z.infer<
  typeof gitCommitActionPreviewSchema
>;
export type GitCommitActionApply = z.infer<typeof gitCommitActionApplySchema>;
export type GitCommitActionResult = z.infer<typeof gitCommitActionResultSchema>;
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitForcePushPreview = z.infer<typeof gitForcePushPreviewSchema>;
export type GitForcePushApply = z.infer<typeof gitForcePushApplySchema>;
export type WorkerWorktreeSummary = z.infer<typeof workerWorktreeSummarySchema>;
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>;
export type WorktreeCreateMode = z.infer<typeof worktreeCreateModeSchema>;
export type WorktreeCreateResult = z.infer<typeof worktreeCreateResultSchema>;
export type WorktreeCreateMutationFailure = z.infer<
  typeof worktreeCreateMutationFailureSchema
>;
export type WorktreeCreateMutationOutcome = z.infer<
  typeof worktreeCreateMutationOutcomeSchema
>;
export type WorktreeMutationResult = z.infer<
  typeof worktreeMutationResultSchema
>;
export type WorktreeRemoveResult = z.infer<typeof worktreeRemoveResultSchema>;
export type WorktreePruneResult = z.infer<typeof worktreePruneResultSchema>;
export type WorktreeStatusResult = z.infer<typeof worktreeStatusResultSchema>;
export type WorktreeObservationTarget = z.infer<
  typeof worktreeObservationTargetSchema
>;
export type CodeGraphObservationTarget = z.infer<
  typeof codeGraphObservationTargetSchema
>;
export type ProjectWorktreeCreate = z.infer<typeof projectWorktreeCreateSchema>;
export type ProjectWorktreeLock = z.infer<typeof projectWorktreeLockSchema>;
export type ProjectWorktreeRemove = z.infer<typeof projectWorktreeRemoveSchema>;
export type ProjectWorktreePrune = z.infer<typeof projectWorktreePruneSchema>;
export type ProjectWorktreePolicyUpdate = z.infer<
  typeof projectWorktreePolicyUpdateSchema
>;
export type ChatWorktreeUpdate = z.infer<typeof chatWorktreeUpdateSchema>;
export type WorktreeSelection = z.infer<typeof worktreeSelectionSchema>;
export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type EncryptedChatCreate = z.infer<typeof encryptedChatCreateSchema>;
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type EncryptedTaskCreate = z.infer<typeof encryptedTaskCreateSchema>;
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export type TaskWireCreateResult = z.infer<typeof taskWireCreateResultSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type EncryptedChatUpdate = z.infer<typeof encryptedChatUpdateSchema>;
export type ChatComposerDraft = z.infer<typeof chatComposerDraftSchema>;
export type ChatFork = z.infer<typeof chatForkSchema>;
export type EncryptedChatFork = z.infer<typeof encryptedChatForkSchema>;
export type OrderedIds = z.infer<typeof orderedIdsSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type ChatWireSummary = z.infer<typeof chatWireSummarySchema>;
export type ArchivedChatSummary = z.infer<typeof archivedChatSummarySchema>;
export type ArchivedChatWireSummary = z.infer<
  typeof archivedChatWireSummarySchema
>;
export type ArchivedChatCleanupResult = z.infer<
  typeof archivedChatCleanupResultSchema
>;
export type ChatRelocationState = z.infer<typeof chatRelocationStateSchema>;
export type ChatRelocationErrorCode = z.infer<
  typeof chatRelocationErrorCodeSchema
>;
export type ChatRelocationError = z.infer<typeof chatRelocationErrorSchema>;
export type ChatRelocationJobError = z.infer<
  typeof chatRelocationJobErrorSchema
>;
export type ChatRelocationProgress = z.infer<
  typeof chatRelocationProgressSchema
>;
export type ChatRelocationContextMessage = z.infer<
  typeof chatRelocationContextMessageSchema
>;
export type ChatRelocationAttachmentAvailability = z.infer<
  typeof chatRelocationAttachmentAvailabilitySchema
>;
export type ChatRelocationContextPayload = z.infer<
  typeof chatRelocationContextPayloadSchema
>;
export type ChatRelocationSnapshotSummary = z.infer<
  typeof chatRelocationSnapshotSummarySchema
>;
export type ChatRelocationHydrationBeginResult = z.infer<
  typeof chatRelocationHydrationBeginResultSchema
>;
export type ChatRelocationHydrationResult = z.infer<
  typeof chatRelocationHydrationResultSchema
>;
export type ChatRelocationJobSummary = z.infer<
  typeof chatRelocationJobSummarySchema
>;
export type ChatRelocationCreate = z.infer<typeof chatRelocationCreateSchema>;
export type ChatRelocationJobRetry = z.infer<
  typeof chatRelocationJobRetrySchema
>;
export type ChatRelocationJobCancel = z.infer<
  typeof chatRelocationJobCancelSchema
>;
export type PermissionProfileSummary = z.infer<
  typeof permissionProfileSummarySchema
>;
export type PermissionProfileCapability = z.infer<
  typeof permissionProfileCapabilitySchema
>;
export type ChatPermissionProfileState = z.infer<
  typeof chatPermissionProfileStateSchema
>;
export type ChatPermissionProfileUpdate = z.infer<
  typeof chatPermissionProfileUpdateSchema
>;
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
export type EncryptedTerminalCreate = z.infer<
  typeof encryptedTerminalCreateSchema
>;
export type EncryptedRunTerminalMaterialization = z.infer<
  typeof encryptedRunTerminalMaterializationSchema
>;
export type TerminalUpdate = z.infer<typeof terminalUpdateSchema>;
export type EncryptedTerminalUpdate = z.infer<
  typeof encryptedTerminalUpdateSchema
>;
export type TerminalServiceConfiguration = z.infer<
  typeof terminalServiceConfigurationSchema
>;
export type EncryptedTerminalServiceConfiguration = z.infer<
  typeof encryptedTerminalServiceConfigurationSchema
>;
export type TerminalServiceRuntimeConfiguration = z.infer<
  typeof terminalServiceRuntimeConfigurationSchema
>;
export type TerminalSummary = z.infer<typeof terminalSummarySchema>;
export type TerminalWireSummary = z.infer<typeof terminalWireSummarySchema>;
export type ScriptCommandKind = z.infer<typeof scriptCommandKindSchema>;
export type ScriptCommand = z.infer<typeof scriptCommandSchema>;
export type ExplorerCreate = z.infer<typeof explorerCreateSchema>;
export type EncryptedExplorerCreate = z.infer<
  typeof encryptedExplorerCreateSchema
>;
export type ExplorerUpdate = z.infer<typeof explorerUpdateSchema>;
export type EncryptedExplorerUpdate = z.infer<
  typeof encryptedExplorerUpdateSchema
>;
export type ExplorerFileMode = z.infer<typeof explorerFileModeSchema>;
export type ExplorerViewStateUpdate = z.infer<
  typeof explorerViewStateUpdateSchema
>;
export type EncryptedExplorerViewStateUpdate = z.infer<
  typeof encryptedExplorerViewStateUpdateSchema
>;
export type EncryptedExplorerWorktreeUpdate = z.infer<
  typeof encryptedExplorerWorktreeUpdateSchema
>;
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>;
export type ExplorerWireSummary = z.infer<typeof explorerWireSummarySchema>;
export type CodeThemeMode = z.infer<typeof codeThemeModeSchema>;
export type CodePresentation = z.infer<typeof codePresentationSchema>;
export type CodeAppearance = z.infer<typeof codeAppearanceSchema>;
export type CodeTabStatus = z.infer<typeof codeTabStatusSchema>;
export type CodeSessionStatus = z.infer<typeof codeSessionStatusSchema>;
export type CodeTabCreate = z.infer<typeof codeTabCreateSchema>;
export type EncryptedCodeTabCreate = z.infer<
  typeof encryptedCodeTabCreateSchema
>;
export type CodeTabUpdate = z.infer<typeof codeTabUpdateSchema>;
export type EncryptedCodeTabUpdate = z.infer<
  typeof encryptedCodeTabUpdateSchema
>;
export type CodeTabSummary = z.infer<typeof codeTabSummarySchema>;
export type CodeTabWireSummary = z.infer<typeof codeTabWireSummarySchema>;
export type CodeEditorBuild = z.infer<typeof codeEditorBuildSchema>;
export type CodeProbeResult = z.infer<typeof codeProbeResultSchema>;
export type CodeSessionSummary = z.infer<typeof codeSessionSummarySchema>;
export type CodeDirtyEditor = z.infer<typeof codeDirtyEditorSchema>;
export type CodeSaveBeforeAgentTurn = z.infer<
  typeof codeSaveBeforeAgentTurnSchema
>;
export type CodeWorkbenchState = z.infer<typeof codeWorkbenchStateSchema>;
export type CodeRuntimeStatus = z.infer<typeof codeRuntimeStatusSchema>;
export type CodeSaveAllResult = z.infer<typeof codeSaveAllResultSchema>;
export type CodeAgentTurnPreparationResult = z.infer<
  typeof codeAgentTurnPreparationResultSchema
>;
export type CodeAgentTurnNotificationResult = z.infer<
  typeof codeAgentTurnNotificationResultSchema
>;
export type CodeAttachment = z.infer<typeof codeAttachmentSchema>;
export type CodeAttachmentCreate = z.infer<typeof codeAttachmentCreateSchema>;
export type CodeProtectedAttachmentWire = z.infer<
  typeof codeProtectedAttachmentWireSchema
>;
export type CodeProtectedAttachmentIntent = z.infer<
  typeof codeProtectedAttachmentIntentSchema
>;
export type CodeProtectedAttachmentCreate = z.infer<
  typeof codeProtectedAttachmentCreateSchema
>;
export type ExplorerCodeAttachmentCreate = z.infer<
  typeof explorerCodeAttachmentCreateSchema
>;
export type ExplorerCodeProtectedAttachmentCreate = z.infer<
  typeof explorerCodeProtectedAttachmentCreateSchema
>;
export type CodeOpenFileResult = z.infer<typeof codeOpenFileResultSchema>;
export type CodeOpenFileRequest = z.infer<typeof codeOpenFileRequestSchema>;
export type CodePresentationUpdate = z.infer<
  typeof codePresentationUpdateSchema
>;
export type CodeThemeUpdate = z.infer<typeof codeThemeUpdateSchema>;
export type ProjectShareAttachment = z.infer<
  typeof projectShareAttachmentSchema
>;
export type ProjectShareAttachmentWire = z.infer<
  typeof projectShareAttachmentWireSchema
>;
export type BrowserCreate = z.infer<typeof browserCreateSchema>;
export type EncryptedBrowserCreate = z.infer<
  typeof encryptedBrowserCreateSchema
>;
export type BrowserUpdate = z.infer<typeof browserUpdateSchema>;
export type EncryptedBrowserUpdate = z.infer<
  typeof encryptedBrowserUpdateSchema
>;
export type BrowserSummary = z.infer<typeof browserSummarySchema>;
export type BrowserWireSummary = z.infer<typeof browserWireSummarySchema>;
export type BrowserServiceProtocol = z.infer<
  typeof browserServiceProtocolSchema
>;
export type BrowserService = z.infer<typeof browserServiceSchema>;
export type BrowserFleetService = z.infer<typeof browserFleetServiceSchema>;
export type BrowserServiceDiscoveryWorkerStatus = z.infer<
  typeof browserServiceDiscoveryWorkerStatusSchema
>;
export type BrowserServiceDiscoveryWorkerResult = z.infer<
  typeof browserServiceDiscoveryWorkerResultSchema
>;
export type BrowserServiceFleetDiscovery = z.infer<
  typeof browserServiceFleetDiscoverySchema
>;
export type BrowserTunnelRequest = z.infer<typeof browserTunnelRequestSchema>;
export type BrowserTunnelWireRequest = z.infer<
  typeof browserTunnelWireRequestSchema
>;
export type RemoteDesktopCreate = z.infer<typeof remoteDesktopCreateSchema>;
export type EncryptedRemoteDesktopCreate = z.infer<
  typeof encryptedRemoteDesktopCreateSchema
>;
export type RemoteDesktopTarget = z.infer<typeof remoteDesktopTargetSchema>;
export type RemoteDesktopMonitor = z.infer<typeof remoteDesktopMonitorSchema>;
export type RemoteDesktopWindow = z.infer<typeof remoteDesktopWindowSchema>;
export type RemoteDesktopTargetInventory = z.infer<
  typeof remoteDesktopTargetInventorySchema
>;
export type RemoteDesktopApplicationIcon = z.infer<
  typeof remoteDesktopApplicationIconSchema
>;
export type EncryptedRemoteDesktopUpdate = z.infer<
  typeof encryptedRemoteDesktopUpdateSchema
>;
export type RemoteDesktopSummary = z.infer<typeof remoteDesktopSummarySchema>;
export type RemoteDesktopWireSummary = z.infer<
  typeof remoteDesktopWireSummarySchema
>;
export type RemoteDesktopFleetWorkerStatus = z.infer<
  typeof remoteDesktopFleetWorkerStatusSchema
>;
export type RemoteDesktopFleetWorker = z.infer<
  typeof remoteDesktopFleetWorkerSchema
>;
export type RemoteDesktopProtectedInventory = z.infer<
  typeof remoteDesktopProtectedInventorySchema
>;
export type RemoteDesktopFleetWireWorker = z.infer<
  typeof remoteDesktopFleetWireWorkerSchema
>;
export type RemoteDesktopFleet = z.infer<typeof remoteDesktopFleetSchema>;
export type RemoteDesktopFleetWire = z.infer<
  typeof remoteDesktopFleetWireSchema
>;
export type RemoteSurfaceConfiguration = z.infer<
  typeof remoteSurfaceConfigurationSchema
>;
export type RemoteSurfaceCreate = z.infer<typeof remoteSurfaceCreateSchema>;
export type EncryptedRemoteSurfaceCreate = z.infer<
  typeof encryptedRemoteSurfaceCreateSchema
>;
export type RemoteSurfaceUpdate = z.infer<typeof remoteSurfaceUpdateSchema>;
export type EncryptedRemoteSurfaceUpdate = z.infer<
  typeof encryptedRemoteSurfaceUpdateSchema
>;
export type RemoteSurfaceSummary = z.infer<typeof remoteSurfaceSummarySchema>;
export type RemoteSurfaceWireSummary = z.infer<
  typeof remoteSurfaceWireSummarySchema
>;
export type RemoteSurfaceViewport = z.infer<typeof remoteSurfaceViewportSchema>;
export type DesktopStreamSettings = z.infer<typeof desktopStreamSettingsSchema>;
export type RemoteSurfaceConnectionMessage = z.infer<
  typeof remoteSurfaceConnectionMessageSchema
>;
export type RemoteSurfaceIceServer = z.infer<
  typeof remoteSurfaceIceServerSchema
>;
export type RemoteSurfaceWebRtcConfiguration = z.infer<
  typeof remoteSurfaceWebRtcConfigurationSchema
>;
export type RemoteSurfaceWebRtcSignal = z.infer<
  typeof remoteSurfaceWebRtcSignalSchema
>;
export type RemoteSurfaceAttachResult = z.infer<
  typeof remoteSurfaceAttachResultSchema
>;
export type RemoteSurfaceControl = z.infer<typeof remoteSurfaceControlSchema>;
export type RemoteDesktopProbeResult = z.infer<
  typeof remoteDesktopProbeResultSchema
>;
export type RemoteDesktopClientMessage = z.infer<
  typeof remoteDesktopClientMessageSchema
>;
export type RemoteDesktopServerMessage = z.infer<
  typeof remoteDesktopServerMessageSchema
>;
export type RemoteBrowserClientMessage = z.infer<
  typeof remoteBrowserClientMessageSchema
>;
export type RemoteBrowserServerMessage = z.infer<
  typeof remoteBrowserServerMessageSchema
>;
export type RemoteBrowserCursorMessage = z.infer<
  typeof remoteBrowserCursorMessageSchema
>;
export type RemoteBrowserClipboardMessage = z.infer<
  typeof remoteBrowserClipboardMessageSchema
>;
export type RemoteSurfaceFrameHeader = z.infer<
  typeof remoteSurfaceFrameHeaderSchema
>;
export type ProjectViewKind = z.infer<typeof projectViewKindSchema>;
export type ProjectViewCreate = z.infer<typeof projectViewCreateSchema>;
export type EncryptedProjectViewCreate = z.infer<
  typeof encryptedProjectViewCreateSchema
>;
export type ProjectViewUpdate = z.infer<typeof projectViewUpdateSchema>;
export type EncryptedProjectViewUpdate = z.infer<
  typeof encryptedProjectViewUpdateSchema
>;
export type ProjectViewSummary = z.infer<typeof projectViewSummarySchema>;
export type ProjectViewWireSummary = z.infer<
  typeof projectViewWireSummarySchema
>;
export type ProjectTabKind = z.infer<typeof projectTabKindSchema>;
export type ProjectTabMemberSummary = z.infer<
  typeof projectTabMemberSummarySchema
>;
export type ProjectTabMemberWireSummary = z.infer<
  typeof projectTabMemberWireSummarySchema
>;
export type TabGroupSummary = z.infer<typeof tabGroupSummarySchema>;
export type TabGroupWireSummary = z.infer<typeof tabGroupWireSummarySchema>;
export type TabGroupUpdate = z.infer<typeof tabGroupUpdateSchema>;
export type EncryptedTabGroupUpdate = z.infer<
  typeof encryptedTabGroupUpdateSchema
>;
export type ProjectTabLayoutSummary = z.infer<
  typeof projectTabLayoutSummarySchema
>;
export type ProjectTabLayoutWireSummary = z.infer<
  typeof projectTabLayoutWireSummarySchema
>;
export type TabGroupOrder = z.infer<typeof tabGroupOrderSchema>;
export type TabGroupMemberOrder = z.infer<typeof tabGroupMemberOrderSchema>;
export type TabGroupMemberMove = z.infer<typeof tabGroupMemberMoveSchema>;
export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerEntryName = z.infer<typeof explorerEntryNameSchema>;
export type ExplorerEntryRename = z.infer<typeof explorerEntryRenameSchema>;
export type ExplorerEntryDelete = z.infer<typeof explorerEntryDeleteSchema>;
export type ExplorerEntryMutationResult = z.infer<
  typeof explorerEntryMutationResultSchema
>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerLastCommit = z.infer<typeof explorerLastCommitSchema>;
export type ExplorerDirectoryCommitEntry = z.infer<
  typeof explorerDirectoryCommitEntrySchema
>;
export type ExplorerDirectoryCommits = z.infer<
  typeof explorerDirectoryCommitsSchema
>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type ExplorerMediaKind = z.infer<typeof explorerMediaKindSchema>;
export type ExplorerMediaFile = z.infer<typeof explorerMediaFileSchema>;
export type ExplorerMediaFileChunk = z.infer<
  typeof explorerMediaFileChunkSchema
>;
export type ExplorerFileWrite = z.infer<typeof explorerFileWriteSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type TerminalOpenResult = z.infer<typeof terminalOpenResultSchema>;
export type TerminalSnapshotResult = z.infer<
  typeof terminalSnapshotResultSchema
>;
export type AgentMessagePhase = z.infer<typeof agentMessagePhaseSchema>;
export type CodexEventCorrelation = z.infer<typeof codexEventCorrelationSchema>;
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentCommunicationKind = z.infer<
  typeof agentCommunicationKindSchema
>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessagePageQuery = z.infer<typeof chatMessagePageQuerySchema>;
export type ChatMessagePageInfo = z.infer<typeof chatMessagePageInfoSchema>;
export type ChatMessageWirePage = z.infer<typeof chatMessageWirePageSchema>;
export type EncryptedChatTurnCreate = z.infer<
  typeof encryptedChatTurnCreateSchema
>;
export type EncryptedChatPromptSubmitResult = z.infer<
  typeof encryptedChatPromptSubmitResultSchema
>;
export type EncryptedQueuedPrompt = z.infer<typeof encryptedQueuedPromptSchema>;
export type EncryptedQueuedPromptUpdate = z.infer<
  typeof encryptedQueuedPromptUpdateSchema
>;
export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentSource = z.infer<typeof chatAttachmentSourceSchema>;
export type ChatAttachmentSummary = z.infer<typeof chatAttachmentSummarySchema>;
export type ChatExecutionLaneActor = z.infer<
  typeof chatExecutionLaneActorSchema
>;
export type ChatExecutionLaneState = z.infer<
  typeof chatExecutionLaneStateSchema
>;
export type ChatExecutionLaneSummary = z.infer<
  typeof chatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneRelease = z.infer<
  typeof chatExecutionLaneReleaseSchema
>;
export type AgentInteractionRequestKind = z.infer<
  typeof agentInteractionRequestKindSchema
>;
export type AgentInteractionRequestStatus = z.infer<
  typeof agentInteractionRequestStatusSchema
>;
export type AgentInteractionProvenance = z.infer<
  typeof agentInteractionProvenanceSchema
>;
export type AgentInteractionRequestPayload = z.infer<
  typeof agentInteractionRequestPayloadSchema
>;
export type AgentInteractionResponse = z.infer<
  typeof agentInteractionResponseSchema
>;
export type AgentInteractionRequestCreate = z.infer<
  typeof agentInteractionRequestCreateSchema
>;
export type AgentInteractionResolutionCreate = z.infer<
  typeof agentInteractionResolutionCreateSchema
>;
export type EncryptedAgentInteractionRequestCreate = z.infer<
  typeof encryptedAgentInteractionRequestCreateSchema
>;
export type EncryptedAgentInteractionResolutionCreate = z.infer<
  typeof encryptedAgentInteractionResolutionCreateSchema
>;
export type AgentInteractionRuntimeRequest = z.infer<
  typeof agentInteractionRuntimeRequestSchema
>;
export type EncryptedAgentInteractionRuntimeRequest = z.infer<
  typeof encryptedAgentInteractionRuntimeRequestSchema
>;
export type AgentInteractionAccepted = z.infer<
  typeof agentInteractionAcceptedSchema
>;
export type AgentInteractionRequest = z.infer<
  typeof agentInteractionRequestSchema
>;
export type EncryptedAgentInteractionRequest = z.infer<
  typeof encryptedAgentInteractionRequestSchema
>;
export type AgentInteractionRequestWire = z.infer<
  typeof agentInteractionRequestWireSchema
>;
export type AgentInteractionResolutionWireCreate = z.infer<
  typeof agentInteractionResolutionWireCreateSchema
>;
export type AgentInteractionRequestQuery = z.infer<
  typeof agentInteractionRequestQuerySchema
>;
export type CantripAgentOperationName = z.infer<
  typeof cantripAgentOperationNameSchema
>;
export type CantripAgentOperationRequest = z.infer<
  typeof cantripAgentOperationRequestSchema
>;
export type CantripAgentOperationResult = z.infer<
  typeof cantripAgentOperationResultSchema
>;
export type CantripMcpBinding = z.infer<typeof cantripMcpBindingSchema>;
export type CantripMcpConnectionDocument = z.infer<
  typeof cantripMcpConnectionDocumentSchema
>;
export type CantripMcpBrokerOperationRequest = z.infer<
  typeof cantripMcpBrokerOperationRequestSchema
>;
export type WorkerCantripMcpOperationCall = z.infer<
  typeof workerCantripMcpOperationCallSchema
>;
export type CantripCliCommandName = z.infer<typeof cantripCliCommandNameSchema>;
export type CantripCliContext = z.infer<typeof cantripCliContextSchema>;
export type CantripCliCommandRequest = z.infer<
  typeof cantripCliCommandRequestSchema
>;
export type WorkerCliCommandCall = z.infer<typeof workerCliCommandCallSchema>;
export type CantripCliCommandResult = z.infer<
  typeof cantripCliCommandResultSchema
>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type ChatTurnMode = z.infer<typeof chatTurnModeSchema>;
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
export type QueuedPromptCreate = z.infer<typeof queuedPromptCreateSchema>;
export type QueuedPromptUpdate = z.infer<typeof queuedPromptUpdateSchema>;
export type QueuedPromptOrder = z.infer<typeof queuedPromptOrderSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type ChatModelConfigurationUpdate = z.infer<
  typeof chatModelConfigurationUpdateSchema
>;
export type ChatReasoningOption = z.infer<typeof chatReasoningOptionSchema>;
export type ChatReasoningState = z.infer<typeof chatReasoningStateSchema>;
export type ChatReasoningUpdate = z.infer<typeof chatReasoningUpdateSchema>;
export type ChatCompactAccepted = z.infer<typeof chatCompactAcceptedSchema>;
export type ChatInterruptAccepted = z.infer<typeof chatInterruptAcceptedSchema>;
export type ChatPauseUpdate = z.infer<typeof chatPauseUpdateSchema>;
export type ChatPauseState = z.infer<typeof chatPauseStateSchema>;
export type ThreadGoalStatus = z.infer<typeof threadGoalStatusSchema>;
export type ThreadGoal = z.infer<typeof threadGoalSchema>;
export type ChatGoalResponse = z.infer<typeof chatGoalResponseSchema>;
export type ChatGoalCreate = z.infer<typeof chatGoalCreateSchema>;
export type ChatGoalUpdate = z.infer<typeof chatGoalUpdateSchema>;
export type ChatGoalClear = z.infer<typeof chatGoalClearSchema>;
export type PlanMode = z.infer<typeof planModeSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanQuestionOption = z.infer<typeof planQuestionOptionSchema>;
export type PlanQuestion = z.infer<typeof planQuestionSchema>;
export type PendingPlanQuestion = z.infer<typeof pendingPlanQuestionSchema>;
export type ChatPlanState = z.infer<typeof chatPlanStateSchema>;
export type EncryptedChatPlanWireState = z.infer<
  typeof encryptedChatPlanWireStateSchema
>;
export type ChatPlanUpdate = z.infer<typeof chatPlanUpdateSchema>;
export type ChatPlanAnswer = z.infer<typeof chatPlanAnswerSchema>;
export type ChatPlanAccepted = z.infer<typeof chatPlanAcceptedSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentTurnResultMode = z.infer<typeof agentTurnResultModeSchema>;
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;
export type WorkflowNodeExecutionWorkerResult = z.infer<
  typeof workflowNodeExecutionResultSchema
>;
export type AgentActivityRawEnvelope = z.infer<
  typeof agentActivityRawEnvelopeSchema
>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type NormalizedAgentMessage = z.infer<
  typeof normalizedAgentMessageSchema
>;
export type AgentThreadSync = z.infer<typeof agentThreadSyncSchema>;
export type AgentThreadSyncItem = z.infer<typeof agentThreadSyncItemSchema>;
export type ExternalChatSourceKind = z.infer<
  typeof externalChatSourceKindSchema
>;
export type ExternalChatSourceAvailability = z.infer<
  typeof externalChatSourceAvailabilitySchema
>;
export type ExternalChatThreadStatus = z.infer<
  typeof externalChatThreadStatusSchema
>;
export type ExternalChatImportReference = z.infer<
  typeof externalChatImportReferenceSchema
>;
export type ExternalChatThreadMatch = z.infer<
  typeof externalChatThreadMatchSchema
>;
export type ExternalChatThreadMetadata = z.infer<
  typeof externalChatThreadMetadataSchema
>;
export type ExternalChatSource = z.infer<typeof externalChatSourceSchema>;
export type ExternalChatDiscoveryWorker = z.infer<
  typeof externalChatDiscoveryWorkerSchema
>;
export type ProjectExternalChatDiscovery = z.infer<
  typeof projectExternalChatDiscoverySchema
>;
export type ExternalChatDiscoveryTarget = z.infer<
  typeof externalChatDiscoveryTargetSchema
>;
export type ExternalChatDiscoveryWorkerResult = z.infer<
  typeof externalChatDiscoveryWorkerResultSchema
>;
export type ExternalChatTranscriptMetadata = z.infer<
  typeof externalChatTranscriptMetadataSchema
>;
export type ExternalChatTranscript = z.infer<
  typeof externalChatTranscriptSchema
>;
export type ExternalChatAttachment = z.infer<
  typeof externalChatAttachmentSchema
>;
export type ExternalChatAttachmentReadResult = z.infer<
  typeof externalChatAttachmentReadResultSchema
>;
export type ExternalChatReadWorkerResult = z.infer<
  typeof externalChatReadWorkerResultSchema
>;
export type ChatImportState = z.infer<typeof chatImportStateSchema>;
export type ChatImportError = z.infer<typeof chatImportErrorSchema>;
export type ChatImportJobError = z.infer<typeof chatImportJobErrorSchema>;
export type ChatImportProgress = z.infer<typeof chatImportProgressSchema>;
export type ChatImportJobSummary = z.infer<typeof chatImportJobSummarySchema>;
export type ChatImportSelection = z.infer<typeof chatImportSelectionSchema>;
export type ChatImportCreate = z.infer<typeof chatImportCreateSchema>;
export type WorkerChatAttachment = z.infer<typeof workerChatAttachmentSchema>;
export type CustomizationCapability = z.infer<
  typeof customizationCapabilitySchema
>;
export type CodexCustomizationCapabilities = z.infer<
  typeof codexCustomizationCapabilitiesSchema
>;
export type CodexSkillInventoryItem = z.infer<
  typeof codexSkillInventoryItemSchema
>;
export type CodexHookInventoryItem = z.infer<
  typeof codexHookInventoryItemSchema
>;
export type CodexMcpServer = z.infer<typeof codexMcpServerSchema>;
export type CodexCustomizationInventory = z.infer<
  typeof codexCustomizationInventorySchema
>;
export type CodexExternalImportPreviewItem = z.infer<
  typeof codexExternalImportPreviewItemSchema
>;
export type CodexExternalImportPreview = z.infer<
  typeof codexExternalImportPreviewSchema
>;
export type CodexMcpResourceRead = z.infer<typeof codexMcpResourceReadSchema>;
export type CodexMcpResourceReadRequest = z.infer<
  typeof codexMcpResourceReadRequestSchema
>;
export type CodexSkillConfigUpdate = z.infer<
  typeof codexSkillConfigUpdateSchema
>;
export type CodexSkillConfigResult = z.infer<
  typeof codexSkillConfigResultSchema
>;
export type CodexSkillRootsUpdate = z.infer<typeof codexSkillRootsUpdateSchema>;
export type CodexSkillRootsResult = z.infer<typeof codexSkillRootsResultSchema>;
export type SkillSettingsLocation = z.infer<typeof skillSettingsLocationSchema>;
export type SkillSettingsItem = z.infer<typeof skillSettingsItemSchema>;
export type SkillSettingsInventory = z.infer<
  typeof skillSettingsInventorySchema
>;
export type SkillSettingsFile = z.infer<typeof skillSettingsFileSchema>;
export type SkillSettingsDocument = z.infer<typeof skillSettingsDocumentSchema>;
export type SkillSettingsContext = z.infer<typeof skillSettingsContextSchema>;
export type SkillSettingsFileRequest = z.infer<
  typeof skillSettingsFileRequestSchema
>;
export type SkillSettingsFileUpdate = z.infer<
  typeof skillSettingsFileUpdateSchema
>;
export type SkillSettingsDeleteRequest = z.infer<
  typeof skillSettingsDeleteRequestSchema
>;
export type SkillSettingsMutationResult = z.infer<
  typeof skillSettingsMutationResultSchema
>;
export type CodexMcpOauthStart = z.infer<typeof codexMcpOauthStartSchema>;
export type CodexMcpOauthStartResult = z.infer<
  typeof codexMcpOauthStartResultSchema
>;
export type CodexMcpOauthStatus = z.infer<typeof codexMcpOauthStatusSchema>;
export type CodexMcpReloadResult = z.infer<typeof codexMcpReloadResultSchema>;
export type CodexExternalImportApply = z.infer<
  typeof codexExternalImportApplySchema
>;
export type CodexExternalImportTypeResult = z.infer<
  typeof codexExternalImportTypeResultSchema
>;
export type CodexExternalImportStatus = z.infer<
  typeof codexExternalImportStatusSchema
>;
export type WorkerAttachmentUploadResult = z.infer<
  typeof workerAttachmentUploadResultSchema
>;
export type WorkerAttachmentReadResult = z.infer<
  typeof workerAttachmentReadResultSchema
>;
export type WorkerProjectShareOpenResult = z.infer<
  typeof workerProjectShareOpenResultSchema
>;
export type WorkerProjectShareDescriptor = z.infer<
  typeof workerProjectShareDescriptorSchema
>;
export type OllamaModelInventoryItem = z.infer<
  typeof ollamaModelInventoryItemSchema
>;
export type OllamaModelInventory = z.infer<typeof ollamaModelInventorySchema>;
export type ChatGptModelInventoryItem = z.infer<
  typeof chatGptModelInventoryItemSchema
>;
export type ChatGptModelInventory = z.infer<typeof chatGptModelInventorySchema>;
export type ProviderQuotaSnapshot = z.infer<typeof providerQuotaSnapshotSchema>;
export type ProviderQuotaWindowObservation = z.infer<
  typeof providerQuotaWindowObservationSchema
>;
export type ProviderRateLimitResetCredit = z.infer<
  typeof providerRateLimitResetCreditSchema
>;
export type ProviderRateLimitResetCreditsSummary = z.infer<
  typeof providerRateLimitResetCreditsSummarySchema
>;
export type ProviderRateLimitResetConsumeInput = z.infer<
  typeof providerRateLimitResetConsumeInputSchema
>;
export type ProviderRateLimitResetConsumeRequest = z.infer<
  typeof providerRateLimitResetConsumeRequestSchema
>;
export type ProviderRateLimitResetConsumeOutcome = z.infer<
  typeof providerRateLimitResetConsumeOutcomeSchema
>;
export type ProviderRateLimitResetConsumeResult = z.infer<
  typeof providerRateLimitResetConsumeResultSchema
>;
export type GrokModelInventoryItem = z.infer<
  typeof grokModelInventoryItemSchema
>;
export type GrokModelInventory = z.infer<typeof grokModelInventorySchema>;
export type ServiceLogLevel = z.infer<typeof serviceLogLevelSchema>;
export type ServiceLogRecord = z.infer<typeof serviceLogRecordSchema>;
export type ServiceLogReadResult = z.infer<typeof serviceLogReadResultSchema>;
export type WorkerLogReadQuery = z.infer<typeof workerLogReadQuerySchema>;
export type WorkerLogStreamBatch = z.infer<typeof workerLogStreamBatchSchema>;
export type WorkerLogStreamServerMessage = z.infer<
  typeof workerLogStreamServerMessageSchema
>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type CodeGraphWorkerStatus = z.infer<typeof codeGraphWorkerStatusSchema>;
export type CodeGraphProjectStatus = z.infer<
  typeof codeGraphProjectStatusSchema
>;
export type CodeGraphActionAcknowledgement = z.infer<
  typeof codeGraphActionAcknowledgementSchema
>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
export type WorkerNotification = z.infer<typeof workerNotificationSchema>;
export type WorkerNotificationEnvelope = z.infer<
  typeof workerNotificationEnvelopeSchema
>;
export type WorkerServerEnvelope = z.infer<typeof workerServerEnvelopeSchema>;

export function decodeWorkerRequestEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerRequestEnvelope> {
  return decodeJsonMessage(encoded, workerRequestEnvelopeSchema);
}

export function decodeWorkerServerEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerServerEnvelope> {
  return decodeJsonMessage(encoded, workerServerEnvelopeSchema);
}

export function encodeWorkerRequestEnvelope(
  envelope: WorkerRequestEnvelope,
): string {
  return encodeJsonMessage(envelope, workerRequestEnvelopeSchema);
}

export function encodeWorkerServerEnvelope(
  envelope: WorkerServerEnvelope,
): string {
  return encodeJsonMessage(envelope, workerServerEnvelopeSchema);
}
