import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import {
  codeSettingsPublicStatusSchema,
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  type CodeSettingsUpload,
} from "@cantrip/protocol/code-settings";
import type {
  AccountEncryptionProfileInitialize,
  EncryptionPublicKey,
  WorkerComponentKeyGrant,
} from "@cantrip/protocol/encryption";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-code-settings-api-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "code-settings-worker-token",
};
const workerId = "code-settings-api-worker";
const peerWorkerId = "code-settings-api-peer-worker";
const currentPeerWorkerId = "code-settings-api-current-peer-worker";
const unauthorizedWorkerId = "code-settings-api-worker-without-grant";
const crossAccountWorkerId = "code-settings-api-cross-account-worker";
const workerCommands: Array<{ command: WorkerCommand; workerId: string }> = [];
const zero48 = Buffer.alloc(48).toString("base64url");
const zero65 = Buffer.alloc(65).toString("base64url");
const publicKey: EncryptionPublicKey = {
  version: 1,
  algorithm: "P-256",
  format: "raw",
  value: zero65,
};
const connectedWorkers = new Set([
  workerId,
  peerWorkerId,
  currentPeerWorkerId,
  unauthorizedWorkerId,
  crossAccountWorkerId,
]);

const workerStatus = {
  profileId: "default" as const,
  state: "ready" as const,
  revision: 7,
  conflictCount: 0,
  initializedFromWorker: false,
  backupCreated: true,
  lastSynchronizedAt: "2026-08-23T12:00:00.000Z",
  error: null,
};

const bridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(id) {
    return connectedWorkers.has(id);
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(id, command) {
    workerCommands.push({ command, workerId: id });
    if (
      command.type === "code.settings.status" ||
      command.type === "code.settings.synchronize" ||
      command.type === "code.settings.resolve"
    ) {
      return workerStatus;
    }
    if (command.type === "code.settings.invalidate") return undefined;
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

function heartbeat(id: string, authorized: boolean): WorkerHeartbeat {
  return {
    workerId: id,
    name: "Code settings API worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 4,
    },
    code: unavailableCodeCapabilities,
    encryption: {
      supported: true,
      state: "ready",
      principalId: randomUUID(),
      grants: authorized
        ? [{ component: "customization-content", keyRevision: 1 }]
        : [],
      lastSyncedAt: new Date().toISOString(),
      error: null,
    },
    startedAt: new Date().toISOString(),
  };
}

function upload(
  expectedRevision: number | null,
  keyRevision = 1,
): CodeSettingsUpload {
  const revision = expectedRevision === null ? 1 : expectedRevision + 1;
  return {
    expectedRevision,
    record: {
      operationId: randomUUID(),
      revision,
      protectedContent: {
        formatVersion: 1,
        domain: "customization-content",
        keyRevision,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision,
          nonce: randomBytes(12).toString("base64url"),
          ciphertext: randomBytes(32).toString("base64url"),
        },
      },
    },
  };
}

function initialProfile(clientId: string): AccountEncryptionProfileInitialize {
  return {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: 1,
      passwordKdf: null,
      passwordWrappedMasterKey: null,
      payloadMigrationStatus: "complete",
    },
    initialClient: {
      id: clientId,
      label: "Code settings test client",
      publicKey,
      wrappedMasterKey: {
        version: 1,
        purpose: "client-account-master-key",
        clientId,
        masterKeyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "HPKE-RFC9180",
          suite: {
            mode: "base",
            kem: "DHKEM(P-256,HKDF-SHA256)",
            kdf: "HKDF-SHA256",
            aead: "AES-256-GCM",
          },
          encapsulatedKey: zero65,
          ciphertext: zero48,
        },
      },
    },
  };
}

function customizationGrant(
  workerId: string,
  keyRevision = 1,
): WorkerComponentKeyGrant {
  return {
    version: 1,
    purpose: "worker-component-key",
    workerId,
    component: "customization-content",
    keyRevision,
    envelope: {
      version: 1,
      algorithm: "HPKE-RFC9180",
      suite: {
        mode: "base",
        kem: "DHKEM(P-256,HKDF-SHA256)",
        kdf: "HKDF-SHA256",
        aead: "AES-256-GCM",
      },
      encapsulatedKey: zero65,
      ciphertext: zero48,
    },
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(workerId, false),
  );
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(unauthorizedWorkerId, true),
  );
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(peerWorkerId, false),
  );
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(currentPeerWorkerId, false),
  );
  const crossAccount = await database.repository.createAccount({
    displayName: "Other Code settings account",
    email: "other-code-settings-account@example.com",
    normalizedEmail: "other-code-settings-account@example.com",
    passwordHash: "unused-code-settings-test-password-hash",
    role: "owner",
  });
  await database.repository.recordWorker(
    crossAccount.id,
    heartbeat(crossAccountWorkerId, true),
  );
  app = await buildApp({
    config,
    database,
    logger: false,
    workerBridge: bridge,
  });
  const profile = await app.inject({
    method: "POST",
    url: "/api/encryption/profile/initialize",
    payload: initialProfile("11111111-1111-4111-8111-111111111111"),
  });
  if (profile.statusCode !== 201) {
    throw new Error(`Encryption profile setup failed: ${profile.body}`);
  }
  for (const [authorizedWorkerId, principalId, keyRevisions] of [
    [workerId, "22222222-2222-4222-8222-222222222222", [1, 2]],
    [peerWorkerId, "33333333-3333-4333-8333-333333333333", [1]],
    [currentPeerWorkerId, "44444444-4444-4444-8444-444444444444", [2]],
  ] as const) {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/internal/workers/encryption/bootstrap",
      headers: {
        authorization: `Bearer ${config.workerToken}`,
        "x-cantrip-worker-id": authorizedWorkerId,
      },
      payload: { principalId, publicKey },
    });
    if (bootstrap.statusCode !== 200) {
      throw new Error(`Worker principal setup failed: ${bootstrap.body}`);
    }
    const approve = await app.inject({
      method: "POST",
      url: `/api/encryption/principals/${principalId}/approve`,
      payload: { expectedRevision: 1 },
    });
    if (approve.statusCode !== 200) {
      throw new Error(`Worker principal approval failed: ${approve.body}`);
    }
    for (const keyRevision of keyRevisions) {
      const grant = await app.inject({
        method: "POST",
        url: `/api/encryption/principals/${principalId}/grants`,
        payload: {
          component: "customization-content",
          keyRevision,
          wrappedKey: customizationGrant(authorizedWorkerId, keyRevision),
        },
      });
      if (grant.statusCode !== 201) {
        throw new Error(`Worker grant setup failed: ${grant.body}`);
      }
    }
  }
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

const internalUrl = `/api/internal/workers/${workerId}/code-settings/profiles/default`;
const authorization = { authorization: `Bearer ${config.workerToken}` };

describe.sequential("global Code settings API", () => {
  it("serves encryption initialization preflights before principal hooks", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/encryption/profile/initialize",
      headers: {
        origin: config.appOrigins[0]!,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-cantrip-csrf",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      config.appOrigins[0],
    );
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("dispatches metadata-only worker status, synchronization, and resolution commands", async () => {
    workerCommands.length = 0;

    const status = await app.inject({
      method: "GET",
      url: `/api/settings/code/workers/${workerId}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toEqual(workerStatus);

    const synchronize = await app.inject({
      method: "POST",
      url: `/api/settings/code/workers/${workerId}/synchronize`,
      payload: {},
    });
    expect(synchronize.statusCode).toBe(200);
    expect(synchronize.json()).toEqual(workerStatus);

    const resolve = await app.inject({
      method: "POST",
      url: `/api/settings/code/workers/${workerId}/resolve`,
      payload: { resolution: "publish-local" },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toEqual(workerStatus);

    expect(workerCommands).toEqual([
      { workerId, command: { type: "code.settings.status" } },
      {
        workerId,
        command: {
          type: "code.settings.synchronize",
          initializeIfMissing: false,
        },
      },
      {
        workerId,
        command: {
          type: "code.settings.resolve",
          resolution: "publish-local",
        },
      },
    ]);
    for (const response of [status, synchronize, resolve]) {
      expect(response.body).not.toContain("record");
      expect(response.body).not.toContain("protectedContent");
      expect(response.body).not.toContain("ciphertext");
    }
  });

  it("rejects extra or invalid worker action input without dispatching it", async () => {
    workerCommands.length = 0;
    const sentinel = "GLOBAL_CODE_SETTINGS_ROUTE_PLAINTEXT_SENTINEL";

    const synchronize = await app.inject({
      method: "POST",
      url: `/api/settings/code/workers/${workerId}/synchronize`,
      payload: { initializeIfMissing: false, settings: sentinel },
    });
    expect(synchronize.statusCode).toBe(400);
    expect(synchronize.body).not.toContain(sentinel);

    const resolve = await app.inject({
      method: "POST",
      url: `/api/settings/code/workers/${workerId}/resolve`,
      payload: { resolution: "merge" },
    });
    expect(resolve.statusCode).toBe(400);
    expect(workerCommands).toEqual([]);
  });

  it("does not dispatch settings actions to unknown or offline workers", async () => {
    workerCommands.length = 0;
    const unknown = await app.inject({
      method: "GET",
      url: "/api/settings/code/workers/unknown-worker/status",
    });
    expect(unknown.statusCode).toBe(404);

    connectedWorkers.delete(workerId);
    try {
      const offline = await app.inject({
        method: "POST",
        url: `/api/settings/code/workers/${workerId}/synchronize`,
        payload: { initializeIfMissing: false },
      });
      expect(offline.statusCode).toBe(503);
    } finally {
      connectedWorkers.add(workerId);
    }
    expect(workerCommands).toEqual([]);
  });

  it("requires worker authentication and the customization-content grant", async () => {
    expect(await app.inject({ method: "GET", url: internalUrl })).toMatchObject(
      { statusCode: 401 },
    );

    expect(
      await app.inject({
        method: "GET",
        url: `/api/internal/workers/${unauthorizedWorkerId}/code-settings/profiles/default`,
        headers: authorization,
      }),
    ).toMatchObject({ statusCode: 403 });

    expect(
      await app.inject({
        method: "PUT",
        url: internalUrl,
        headers: authorization,
        payload: upload(null, 3),
      }),
    ).toMatchObject({ statusCode: 403 });
  });

  it("uses authoritative grants while the worker heartbeat is stale", async () => {
    const worker = await database.repository.getWorker(LOCAL_USER_ID, workerId);
    expect(worker?.encryption.grants).toEqual([]);

    const response = await app.inject({
      method: "GET",
      url: internalUrl,
      headers: authorization,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Global Code settings are not initialized.",
    });
  });

  it("relays opaque settings with CAS while public routes expose metadata only", async () => {
    const before = codeSettingsPublicStatusSchema.parse(
      (
        await app.inject({ method: "GET", url: "/api/settings/code/default" })
      ).json(),
    );
    expect(before).toMatchObject({ initialized: false, revision: null });

    const initialUpload = upload(null);
    const create = await app.inject({
      method: "PUT",
      url: internalUrl,
      headers: authorization,
      payload: initialUpload,
    });
    expect(create.statusCode).toBe(201);
    expect(codeSettingsStoredProfileSchema.parse(create.json()).record).toEqual(
      initialUpload.record,
    );

    const loaded = await app.inject({
      method: "GET",
      url: internalUrl,
      headers: authorization,
    });
    expect(loaded.statusCode).toBe(200);
    expect(codeSettingsStoredProfileSchema.parse(loaded.json()).record).toEqual(
      initialUpload.record,
    );
    expect(loaded.headers["cache-control"]).toBe("no-store");

    const publicStatus = await app.inject({
      method: "GET",
      url: "/api/settings/code/default",
    });
    expect(publicStatus.statusCode).toBe(200);
    expect(
      codeSettingsPublicStatusSchema.parse(publicStatus.json()),
    ).toMatchObject({
      initialized: true,
      revision: 1,
      updatedByWorkerId: workerId,
    });
    expect(publicStatus.body).not.toContain("protectedContent");
    expect(publicStatus.body).not.toContain("ciphertext");

    const stale = await app.inject({
      method: "PUT",
      url: internalUrl,
      headers: authorization,
      payload: upload(null),
    });
    expect(stale.statusCode).toBe(409);
    expect(
      codeSettingsRevisionConflictSchema.parse(stale.json()),
    ).toMatchObject({ code: "revision-conflict", currentRevision: 1 });
    expect(stale.body).not.toContain("protectedContent");
    expect(stale.body).not.toContain("ciphertext");
  });

  it("reads and invalidates only workers authorized for the stored key revision", async () => {
    await vi.waitFor(() =>
      expect(workerCommands).toContainEqual({
        workerId: peerWorkerId,
        command: {
          type: "code.settings.invalidate",
          profileId: "default",
          revision: 1,
        },
      }),
    );
    workerCommands.length = 0;

    const updatedUpload = upload(1, 2);
    const update = await app.inject({
      method: "PUT",
      url: internalUrl,
      headers: authorization,
      payload: updatedUpload,
    });
    expect(update.statusCode).toBe(200);

    await vi.waitFor(() =>
      expect(workerCommands).toEqual([
        {
          workerId: currentPeerWorkerId,
          command: {
            type: "code.settings.invalidate",
            profileId: "default",
            revision: 2,
          },
        },
      ]),
    );
    expect(workerCommands).not.toContainEqual(
      expect.objectContaining({ workerId }),
    );
    expect(workerCommands).not.toContainEqual(
      expect.objectContaining({ workerId: unauthorizedWorkerId }),
    );
    expect(workerCommands).not.toContainEqual(
      expect.objectContaining({ workerId: peerWorkerId }),
    );
    expect(workerCommands).not.toContainEqual(
      expect.objectContaining({ workerId: crossAccountWorkerId }),
    );

    const stalePeerRead = await app.inject({
      method: "GET",
      url: `/api/internal/workers/${peerWorkerId}/code-settings/profiles/default`,
      headers: authorization,
    });
    expect(stalePeerRead.statusCode).toBe(403);

    const currentPeerRead = await app.inject({
      method: "GET",
      url: `/api/internal/workers/${currentPeerWorkerId}/code-settings/profiles/default`,
      headers: authorization,
    });
    expect(currentPeerRead.statusCode).toBe(200);
    expect(
      codeSettingsStoredProfileSchema.parse(currentPeerRead.json()).record
        .protectedContent.keyRevision,
    ).toBe(2);
  });

  it("rejects plaintext and malformed profile input without reflecting it", async () => {
    const sentinel = "GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL";
    const response = await app.inject({
      method: "PUT",
      url: internalUrl,
      headers: authorization,
      payload: {
        ...upload(1),
        settings: { "editor.fontFamily": sentinel },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(sentinel);

    expect(
      await app.inject({
        method: "GET",
        url: `/api/internal/workers/${workerId}/code-settings/profiles/other`,
        headers: authorization,
      }),
    ).toMatchObject({ statusCode: 400 });
  });
});
