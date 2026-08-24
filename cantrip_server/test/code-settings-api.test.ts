import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import {
  codeSettingsPublicStatusSchema,
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  type CodeSettingsUpload,
} from "@cantrip/protocol/code-settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

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
const unauthorizedWorkerId = "code-settings-api-worker-without-grant";

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

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(workerId, true),
  );
  await database.repository.recordWorker(
    LOCAL_USER_ID,
    heartbeat(unauthorizedWorkerId, false),
  );
  app = await buildApp({ config, database, logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

const internalUrl = `/api/internal/workers/${workerId}/code-settings/profiles/default`;
const authorization = { authorization: `Bearer ${config.workerToken}` };

describe.sequential("global Code settings API", () => {
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
        payload: upload(null, 2),
      }),
    ).toMatchObject({ statusCode: 403 });
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
