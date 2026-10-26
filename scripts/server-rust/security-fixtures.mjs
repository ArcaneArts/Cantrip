import * as p from "../../packages/protocol/dist/index.js";

export const owner = "11111111-1111-4111-8111-111111111111";
export const clientId = "22222222-2222-4222-8222-222222222222";
export const workerPrincipalId = "33333333-3333-4333-8333-333333333333";
export const grantId = "44444444-4444-4444-8444-444444444444";
export const timestamp = "2026-10-25T00:00:00.000Z";
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
export const securityFixtures = {
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
};
