import { projectSurfaceWireFixtures } from "./project-surface-wire-fixtures.mjs";
import * as p from "../../packages/protocol/dist/index.js";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import workerCommands from "./worker-command-fixtures.json" with { type: "json" };
import commandRefinements from "./worker-command-refinement-fixtures.json" with { type: "json" };
import { usageWireFixtures } from "./usage-wire-fixtures.mjs";
import { policyWireFixtures } from "./policy-wire-fixtures.mjs";
import { settingsWireFixtures } from "./settings-wire-fixtures.mjs";
import { placementWireFixtures } from "./placement-wire-fixtures.mjs";
import { folderWireFixtures } from "./folder-wire-fixtures.mjs";
import { standaloneChatWireFixtures } from "./standalone-chat-wire-fixtures.mjs";
import { nativeCommandWireFixtures } from "./native-command-wire-fixtures.mjs";
import { nativeHistoryWireFixtures } from "./native-history-wire-fixtures.mjs";
import { nativeSettingsWireFixtures } from "./native-settings-fixtures.mjs";
import { settlementWireFixtures } from "./native-settlement-fixtures.mjs";
import { deferredAttachment } from "./native-settlement-fixtures.mjs";
import { managedQueueWireFixtures } from "./managed-queue-wire-fixtures.mjs";
import { eventPlan } from "./native-event-fixtures.mjs";
import { nativeSettingsHttpWireFixtures } from "./native-settings-http-wire-fixtures.mjs";
import { nativeModelInventoryWireFixtures } from "./native-model-inventory-fixtures.mjs";
import { nativeEventWireFixtures } from "./native-event-http-wire-fixtures.mjs";
import { agentInteractionWireFixtures } from "./agent-interaction-fixtures.mjs";
import { terminalWireFixtures } from "./terminal-wire-fixtures.mjs";
import { browserWireFixtures } from "./browser-wire-fixtures.mjs";
import { projectShareWireFixtures } from "./project-share-wire-fixtures.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { tunnelWireFixtures } from "./tunnel-wire-fixtures.mjs";
import { workspaceWireFixtures } from "./workspace-wire-fixtures.mjs";
import { workspaceLayoutWireFixtures } from "./workspace-layout-wire-fixtures.mjs";
import { paneWireFixtures } from "./pane-wire-fixtures.mjs";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { runWireFixtures } from "./run-wire-fixtures.mjs";
import { worktreeWireFixtures } from "./worktree-wire-fixtures.mjs";
import { provisioningWireFixtures } from "./provisioning-wire-fixtures.mjs";

export const owner = "11111111-1111-4111-8111-111111111111";
export const clientId = "22222222-2222-4222-8222-222222222222";
export const workerPrincipalId = "33333333-3333-4333-8333-333333333333";
export const grantId = "44444444-4444-4444-8444-444444444444";
export const timestamp = "2026-10-25T00:00:00.000Z";
const provenance = {
  chatId: null,
  threadId: "fixture-thread",
  turnId: null,
  itemId: null,
  executionLaneId: null,
  workerId: "fixture-worker",
};
export const password = "isolated fixture password only";
const bytes = (n) => Buffer.alloc(n, 0).toString("base64url");
export const publicKey = {
  version: 1,
  algorithm: "P-256",
  format: "raw",
  value: bytes(65),
};
export const hpke = {
  version: 1,
  algorithm: "HPKE-RFC9180",
  suite: {
    mode: "base",
    kem: "DHKEM(P-256,HKDF-SHA256)",
    kdf: "HKDF-SHA256",
    aead: "AES-256-GCM",
  },
  encapsulatedKey: bytes(65),
  ciphertext: bytes(48),
};
export const kdf = {
  algorithm: "Argon2id",
  version: 19,
  context: "cantrip:e2ee:password-kek:v1",
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  outputBytes: 32,
  salt: bytes(32),
};
export const passwordWrapper = {
  version: 1,
  purpose: "password-wrapped-account-master-key",
  masterKeyRevision: 1,
  kdf,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: bytes(12),
    ciphertext: bytes(48),
  },
};
export function clientWrapper(id = clientId) {
  return {
    version: 1,
    purpose: "client-account-master-key",
    clientId: id,
    masterKeyRevision: 1,
    envelope: structuredClone(hpke),
  };
}
export function workerWrapper(id = "fixture-worker") {
  return {
    version: 1,
    purpose: "worker-component-key",
    workerId: id,
    component: "chat-content",
    keyRevision: 1,
    envelope: structuredClone(hpke),
  };
}
export function initialization(id = clientId, protectedProfile = true) {
  return {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: 1,
      passwordKdf: protectedProfile ? structuredClone(kdf) : null,
      passwordWrappedMasterKey: protectedProfile
        ? structuredClone(passwordWrapper)
        : null,
      payloadMigrationStatus: "pending",
    },
    initialClient: {
      id,
      label: "Fixture client",
      publicKey: structuredClone(publicKey),
      wrappedMasterKey: clientWrapper(id),
    },
  };
}

const initializedProfile = {
  ownerId: owner,
  ...initialization().profile,
  initializationStatus: "initialized",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const principal = {
  id: clientId,
  ownerId: owner,
  kind: "client",
  workerId: null,
  label: "Fixture client",
  publicKey,
  state: "approved",
  revision: 1,
  approvedAt: timestamp,
  revokedAt: null,
  revokedReason: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workerPrincipal = {
  ...principal,
  id: workerPrincipalId,
  kind: "worker",
  workerId: "fixture-worker",
};
const grant = {
  id: grantId,
  ownerId: owner,
  principalId: clientId,
  component: "account-master-key",
  keyRevision: 1,
  wrappedKey: clientWrapper(),
  state: "active",
  revision: 1,
  revokedAt: null,
  revokedReason: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workerGrant = {
  ...grant,
  principalId: workerPrincipalId,
  component: "chat-content",
  wrappedKey: workerWrapper(),
};
export const heartbeat = p.workerHeartbeatSchema.parse({
  workerId: "fixture-worker",
  name: "Fixture worker",
  platform: "darwin",
  architecture: "arm64",
  codexVersion: null,
  startedAt: timestamp,
});
const worker = { ...heartbeat, online: true, lastSeenAt: timestamp };
const credentialSummary = {
  id: grantId,
  workerId: heartbeat.workerId,
  label: null,
  scopes: [...p.workerCredentialScopes],
  createdAt: timestamp,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedReason: null,
  active: true,
};
const credential = `ctwk_${"A".repeat(43)}`;
const code = `ctwl_${"A".repeat(32)}`;
export const projectLabel = {
  classification: { recordKind: "project" },
  protectedLabel: {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: bytes(12),
      ciphertext: bytes(32),
    },
  },
};
export const projectReplica = {
  id: "source-one",
  projectId: "project-one",
  sourceKind: "git",
  workerId: "fixture-worker",
  workerName: "Fixture worker",
  workerOnline: true,
  path: "/fixture/project",
  displayPath: "/fixture/project",
  placementMode: "managed",
  ownershipKind: "cantrip",
  requestedPath: null,
  linkPath: null,
  repositoryFingerprint: null,
  primaryWorktreeId: "worktree-one",
  branch: "main",
  head: "abcdef",
  dirty: false,
  ready: true,
  worktreeCount: 1,
  lastObservedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const projectWire = {
  id: "project-one",
  nameProtection: projectLabel,
  position: 0,
  originKind: "github",
  folderManagement: null,
  capabilities: {
    git: true,
    github: true,
    worktrees: true,
    replicas: true,
    relocation: true,
  },
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  preferredWorkerId: null,
  github: null,
  source: null,
  replicas: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const securityFixtures = {
  ...nativeEventWireFixtures(),
  ...nativeModelInventoryWireFixtures(),
  ...agentInteractionWireFixtures(),
  ...nativeSettingsHttpWireFixtures(),
  chatPlanOpaqueStateSchema: [eventPlan],
  chatAttachmentOpaqueSummarySchema: [deferredAttachment()],
  modelConfigurationSchema: [
    { modelId: null },
    {
      modelId: "fixture-model",
      reasoningEffort: "medium",
      customSubagentModel: true,
      subagentModelId: "fixture-subagent",
      subagentReasoningEffort: "high",
    },
  ],
  projectWireSummarySchema: [
    projectWire,
    {
      ...projectWire,
      github: {
        repositoryId: "repository",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
      source: projectReplica,
      replicas: [projectReplica],
    },
    {
      ...projectWire,
      originKind: "managed-folder",
      folderManagement: "external",
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
    },
    {
      ...projectWire,
      originKind: "managed-folder",
      folderManagement: "managed",
      capabilities: {
        git: true,
        github: false,
        worktrees: false,
        replicas: true,
        relocation: true,
      },
    },
  ],
  projectWireListSchema: [[], [projectWire]],
  appLiveEventPayloadSchema: [
    {},
    { nested: { values: [null, true, 42, "🦀\udfff"] } },
  ],
  clientControlRequestSchema: [
    {
      correlationId: clientId,
      issuedAt: timestamp,
      expiresAt: "2026-10-25T00:00:10.000Z",
      command: { kind: "focus-project", projectId: "project" },
    },
    {
      correlationId: clientId,
      issuedAt: timestamp,
      expiresAt: "2026-10-25T00:00:00.001Z",
      command: {
        kind: "notify",
        projectId: "project",
        workerId: "worker",
        operationId: owner,
        protectedContent: {
          formatVersion: 1,
          domain: "client-control-content",
          keyRevision: 1,
          envelope: passwordWrapper.envelope,
        },
      },
    },
  ],
  appLiveClientMessageSchema: [
    {
      type: "initialize",
      protocolVersion: 1,
      client: {
        id: "client",
        name: "Browser",
        version: "1",
        controlCapabilities: [
          "notify",
          "focus-project",
          "focus-surface",
          "show-interaction",
        ],
      },
    },
    {
      type: "initialize",
      protocolVersion: 1,
      client: { id: "client", name: "Browser", version: "1" },
      resume: { serverEpoch: "epoch", cursor: 0 },
    },
    {
      type: "subscribe",
      requestId: "subscribe",
      scopes: [
        { kind: "current-user" },
        { kind: "project", projectId: "project" },
        { kind: "chat", chatId: "chat" },
      ],
    },
    {
      type: "unsubscribe",
      requestId: "unsubscribe",
      scopes: [{ kind: "current-user" }],
    },
    { type: "ping", nonce: "nonce" },
    {
      type: "resync-ack",
      requestId: "resync",
      cursor: 1,
      scopes: [{ kind: "current-user" }],
    },
    { type: "client-control-ack", correlationId: clientId, status: "applied" },
  ],
  appLiveServerMessageSchema: [
    {
      type: "ready",
      protocolVersion: 1,
      serverEpoch: "epoch",
      connectionId: "connection",
      currentCursor: 0,
      heartbeatIntervalMs: 30000,
      resume: "not-requested",
    },
    {
      type: "subscribed",
      requestId: "subscribe",
      scopes: [{ kind: "current-user" }],
      cursor: 0,
    },
    {
      type: "unsubscribed",
      requestId: "unsubscribe",
      scopes: [{ kind: "project", projectId: "project" }],
      cursor: 1,
    },
    {
      type: "event",
      cursor: 1,
      scope: { kind: "current-user" },
      resource: "worker",
      action: "invalidated",
      entityId: null,
      revision: null,
      payload: { nested: [null, false, 1, "text"] },
      occurredAt: timestamp,
    },
    { type: "caught-up", cursor: 1, replayedCount: 1 },
    { type: "pong", cursor: 1, nonce: "nonce" },
    {
      type: "resync-required",
      cursor: 1,
      reason: "server-epoch-changed",
      scopes: [],
    },
    {
      type: "client-control-request",
      correlationId: clientId,
      issuedAt: timestamp,
      expiresAt: "2026-10-25T00:00:00.001Z",
      command: {
        kind: "show-interaction",
        projectId: "project",
        chatId: "chat",
        interactionId: "interaction",
      },
    },
    {
      type: "error",
      requestId: null,
      code: "invalid-message",
      message: "Invalid message",
      retryable: false,
    },
  ],
  workerListSchema: [[worker]],
  workerConnectionEnvelopeSchema: [
    {
      kind: "connection",
      state: "pending",
      protocolVersion: 1,
      connectionGeneration: owner,
    },
    {
      kind: "connection",
      state: "ready",
      protocolVersion: 2,
      connectionGeneration: owner,
      serverControlPlaneGeneration: clientId,
    },
  ],
  workerResponseEnvelopeSchema: [
    {
      kind: "response",
      requestId: "fixture-request",
      ok: true,
      result: { opaque: "fixture result" },
    },
    {
      kind: "response",
      requestId: "fixture-request",
      ok: false,
      error: { message: "Fixture command failed", code: "fixture-error" },
    },
  ],
  accountRegistrationSchema: [
    {
      displayName: "  Fixture 🦀  ",
      email: "fixture@example.invalid",
      password,
    },
  ],
  authLoginSchema: [
    { email: "fixture@example.invalid", password },
    { password },
  ],
  authReauthenticationSchema: [{ password }],
  mobileSignInGrantExchangeSchema: [{ code: `ctms_${"A".repeat(32)}` }],
  accountEncryptionProfileStateSchema: [
    { status: "uninitialized", profile: null },
    { status: "initialized", profile: initializedProfile },
  ],
  accountEncryptionProfileSchema: [initializedProfile],
  accountEncryptionProfileInitializeSchema: [
    initialization(),
    initialization(clientId, false),
  ],
  accountEncryptionProfileInitializeResultSchema: [
    { created: true, profile: initializedProfile, principal, grant },
    { created: false, profile: initializedProfile },
  ],
  encryptionProfileMigrationUpdateSchema: [
    { expectedRevision: 1, payloadMigrationStatus: "in-progress" },
  ],
  accountPasswordEncryptionChangeSchema: [
    {
      currentPassword: password,
      newPassword: "changed fixture password",
      expectedProfileRevision: 1,
      passwordKdf: kdf,
      passwordWrappedMasterKey: passwordWrapper,
    },
  ],
  encryptionPrincipalCreateSchema: [
    { id: clientId, kind: "client", publicKey },
    {
      id: workerPrincipalId,
      kind: "worker",
      workerId: heartbeat.workerId,
      publicKey,
    },
  ],
  encryptionPrincipalApprovalSchema: [{ expectedRevision: 1 }],
  encryptionRevocationSchema: [
    { expectedRevision: 1, reason: "  fixture revoke  " },
  ],
  encryptionPrincipalSchema: [principal, workerPrincipal],
  encryptionPrincipalListSchema: [[principal, workerPrincipal]],
  encryptionKeyGrantCreateSchema: [
    {
      component: grant.component,
      keyRevision: 1,
      wrappedKey: grant.wrappedKey,
    },
    {
      component: workerGrant.component,
      keyRevision: 1,
      wrappedKey: workerGrant.wrappedKey,
    },
  ],
  encryptionKeyGrantSchema: [grant, workerGrant],
  encryptionKeyGrantListSchema: [[grant, workerGrant]],
  workerEncryptionBootstrapRequestSchema: [
    { principalId: workerPrincipalId, publicKey },
  ],
  workerEncryptionBootstrapResultSchema: [
    {
      serverId: owner,
      ownerId: owner,
      principal: workerPrincipal,
      grants: [workerGrant],
    },
  ],
  workerEncryptionRefreshRequestSchema:
    p.workerEncryptionComponentScopeSchema.options.map((component) => ({
      component,
      keyRevision: 1,
    })),
  workerEncryptionRefreshResultSchema:
    p.workerEncryptionComponentScopeSchema.options.flatMap((component) => [
      {
        component,
        keyRevision: 1,
        status: p.unavailableWorkerEncryptionStatus,
      },
      {
        component,
        keyRevision: 2,
        status: {
          supported: true,
          state: "ready",
          principalId: workerPrincipalId,
          grants: [{ component, keyRevision: 2 }],
          lastSyncedAt: timestamp,
          error: null,
        },
      },
    ]),
  workerEnrollmentCodeCreateSchema: [
    {},
    {
      label: "  Fixture code  ",
      expiresInSeconds: 60,
      candidateWorkerIds: ["fixture-worker"],
    },
  ],
  workerEnrollmentCodeResultSchema: [
    { id: grantId, code, label: null, expiresAt: timestamp, workerId: null },
  ],
  workerEnrollmentCodeStatusSchema: [
    { id: grantId, label: null, expiresAt: timestamp, status: "pending" },
  ],
  workerEnrollmentExchangeSchema: [
    { code, heartbeat },
    {
      code,
      heartbeat,
      replacement: { workerId: heartbeat.workerId, credential },
    },
  ],
  workerEnrollmentResultSchema: [{ credential, credentialSummary, worker }],
  workerCredentialRotateSchema: [{}, { label: "  rotated fixture  " }],
  workerCredentialRotateResultSchema: [
    { credential, credentialSummary, delivered: false },
  ],
  workerCredentialListSchema: [[credentialSummary]],
  workerHeartbeatSchema: [heartbeat],
  workerSummarySchema: [worker],
  accountSessionListSchema: [
    [
      {
        id: clientId,
        authMethod: "account-password",
        label: null,
        current: true,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        expiresAt: timestamp,
      },
    ],
  ],
  accountLicenseWhitelistCreateSchema: [{ email: "fixture@example.invalid" }],
  accountLicenseWhitelistEntrySchema: [
    {
      id: grantId,
      email: "fixture@example.invalid",
      registered: false,
      createdAt: timestamp,
    },
  ],
  accountAdminSummarySchema: [
    {
      userCount: 1,
      licenseWhitelist: {
        enabled: true,
        adminEmail: "fixture@example.invalid",
        entries: [],
      },
    },
  ],
  auditEventQuerySchema: [{}, { before: "100", limit: "20" }],
  auditEventListSchema: [
    {
      items: [
        {
          id: 1,
          ownerId: owner,
          actor: { userId: owner, sessionId: null },
          action: "fixture.operation",
          result: "succeeded",
          resource: { type: "fixture", id: null },
          requestId: null,
          occurredAt: timestamp,
        },
      ],
      nextCursor: null,
    },
  ],
  agentInteractionProvenanceSchema: [
    provenance,
    { ...provenance, owner: "codex" },
    {
      ...provenance,
      owner: "computer-use",
      chatId: "fixture-chat",
      threadId: null,
    },
  ],
  workerServerEnvelopeSchema: workerIngressFixtures,
  ...usageWireFixtures,
  ...policyWireFixtures,
  ...settingsWireFixtures,
  ...placementWireFixtures(projectLabel),
  ...folderWireFixtures(projectLabel),
  ...standaloneChatWireFixtures(timestamp),
  ...nativeCommandWireFixtures(timestamp),
  ...nativeHistoryWireFixtures(timestamp),
  ...nativeSettingsWireFixtures(),
  ...settlementWireFixtures(timestamp),
  ...managedQueueWireFixtures(timestamp),
  ...terminalWireFixtures(projectLabel),
  ...browserWireFixtures(projectLabel),
  ...projectSurfaceWireFixtures(projectLabel),
  ...projectShareWireFixtures(),
  ...fileDocumentWireFixtures(),
  ...tunnelWireFixtures,
  ...workspaceWireFixtures(),
  ...workspaceLayoutWireFixtures(projectLabel),
  ...paneWireFixtures(projectLabel),
  ...workerLinkWireFixtures,
  ...directAttachmentWireFixtures,
  ...discoveryWireFixtures(projectLabel),
  ...runWireFixtures(projectLabel.protectedLabel),
  ...worktreeWireFixtures(),
  ...provisioningWireFixtures(projectLabel),
  workerRequestEnvelopeSchema: [
    ...workerCommands.commands.map((item) => item.input),
    ...commandRefinements.cases.map((item) => item.input),
  ],
};
