import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  workerCredentialListSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
  workerEnrollmentResultSchema,
  workerManagementListSchema,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { hashSecret } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { WorkerBridge } from "../src/workers/bridge.js";

const origin = "https://app.cantrip.test";
const bootstrapToken = "worker-enrollment-bootstrap-token-123456";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  if (typeof header !== "string") throw new Error("Expected session cookie.");
  return header.split(";", 1)[0]!;
}

function heartbeat(workerId: string): WorkerHeartbeat {
  return {
    workerId,
    name: "Remote Mac",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: true,
      desktop: true,
      transports: ["websocket"],
      maxSessions: 4,
    },
    code: unavailableCodeCapabilities,
    startedAt: new Date().toISOString(),
  };
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-worker-enrollment-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: bootstrapToken,
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 20,
    bootstrapMode: "hosted",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "0.0.0.0",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: false,
    secretEncryption: {
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 8) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "legacy-token-must-not-work",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("per-worker enrollment credentials", () => {
  it("pairs once, binds identity, rotates, and revokes without legacy fallback", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const bridge = new WorkerBridge();
    const disconnect = vi.spyOn(bridge, "disconnect");
    const isConnected = vi.spyOn(bridge, "isConnected").mockReturnValue(false);
    const commandRequest = vi
      .spyOn(bridge, "request")
      .mockResolvedValue({ accepted: true });
    const app = await buildApp({
      config,
      database,
      logger: false,
      workerBridge: bridge,
    });

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": bootstrapToken },
        payload: {
          displayName: "Worker Owner",
          email: "owner@example.com",
          password,
        },
      });
      expect(registered.statusCode).toBe(201);
      const authHeaders = {
        cookie: sessionCookie(registered),
        origin,
        "x-cantrip-csrf": registered.json().csrfToken as string,
      };
      const expiredCode = `ctwl_${"z".repeat(32)}`;
      await database.repository.createWorkerEnrollmentCode({
        codeHash: hashSecret(expiredCode),
        createdBySessionId: null,
        expiresAt: new Date(Date.now() - 1_000),
        label: null,
        ownerId: registered.json().currentUser.id as string,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/enroll",
            payload: {
              code: expiredCode,
              heartbeat: heartbeat("expired-worker"),
            },
          })
        ).statusCode,
      ).toBe(409);

      const createdCode = await app.inject({
        method: "POST",
        url: "/api/workers/enrollment-codes",
        headers: authHeaders,
        payload: { label: "Desk Mac", expiresInSeconds: 300 },
      });
      expect(createdCode.statusCode).toBe(201);
      const link = workerEnrollmentCodeResultSchema.parse(createdCode.json());
      expect(link.code).toMatch(/^ctwl_/u);
      expect(
        workerEnrollmentCodeStatusSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/workers/enrollment-codes/${link.id}`,
              headers: authHeaders,
            })
          ).json(),
        ).status,
      ).toBe("pending");

      const enrolledResponse = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: { code: link.code, heartbeat: heartbeat("worker-one") },
      });
      expect(enrolledResponse.statusCode).toBe(201);
      const enrolled = workerEnrollmentResultSchema.parse(
        enrolledResponse.json(),
      );
      expect(enrolled.credential).toMatch(/^ctwk_/u);
      expect(enrolled.credentialSummary).toMatchObject({
        active: true,
        label: "Desk Mac",
        workerId: "worker-one",
      });
      expect(enrolledResponse.body).not.toContain("secretHash");
      expect(
        workerEnrollmentCodeStatusSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/workers/enrollment-codes/${link.id}`,
              headers: authHeaders,
            })
          ).json(),
        ).status,
      ).toBe("paired");

      const replay = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: { code: link.code, heartbeat: heartbeat("worker-two") },
      });
      expect(replay.statusCode).toBe(409);

      const legacy = await app.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: heartbeat("worker-one"),
      });
      expect(legacy.statusCode).toBe(401);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: `Bearer ${enrolled.credential}` },
        payload: heartbeat("worker-one"),
      });
      expect(accepted.statusCode).toBe(202);
      const managed = workerManagementListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/workers/management",
            headers: authHeaders,
          })
        ).json(),
      );
      expect(managed).toEqual([
        expect.objectContaining({
          workerId: "worker-one",
          internal: false,
          editable: true,
          removable: true,
          credentialCount: 1,
          activeCredentialCount: 1,
          sources: [],
        }),
      ]);
      const renamed = await app.inject({
        method: "PATCH",
        url: "/api/workers/worker-one",
        headers: authHeaders,
        payload: { name: "Studio Mac" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().name).toBe("Studio Mac");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: { authorization: `Bearer ${enrolled.credential}` },
            payload: heartbeat("worker-one"),
          })
        ).json().name,
      ).toBe("Studio Mac");
      const impersonation = await app.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: `Bearer ${enrolled.credential}` },
        payload: heartbeat("worker-two"),
      });
      expect(impersonation.statusCode).toBe(401);

      const listed = await app.inject({
        method: "GET",
        url: "/api/workers/worker-one/credentials",
        headers: authHeaders,
      });
      expect(listed.statusCode).toBe(200);
      const credentials = workerCredentialListSchema.parse(listed.json());
      expect(credentials).toHaveLength(1);
      expect(credentials[0]?.lastUsedAt).not.toBeNull();
      expect(listed.body).not.toContain(enrolled.credential);
      expect(listed.body).not.toContain("secretHash");

      isConnected.mockReturnValue(true);
      const rotatedResponse = await app.inject({
        method: "POST",
        url: "/api/workers/worker-one/credentials/rotate",
        headers: authHeaders,
        payload: { label: "Desk Mac rotated" },
      });
      expect(rotatedResponse.statusCode).toBe(200);
      const rotated = rotatedResponse.json() as {
        credential: string;
        credentialSummary: { id: string };
        delivered: boolean;
      };
      expect(rotated.delivered).toBe(true);
      expect(commandRequest).toHaveBeenCalledWith(
        "worker-one",
        expect.objectContaining({
          type: "worker.credential.rotate",
          credential: rotated.credential,
        }),
        { timeoutMs: 10_000 },
      );
      expect(rotated.credential).toMatch(/^ctwk_/u);
      expect(rotated.credential).not.toBe(enrolled.credential);
      expect(disconnect).toHaveBeenCalledWith(
        "worker-one",
        "Worker credential was rotated",
        1012,
      );

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: { authorization: `Bearer ${enrolled.credential}` },
            payload: heartbeat("worker-one"),
          })
        ).statusCode,
      ).toBe(401);

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: { authorization: `Bearer ${rotated.credential}` },
            payload: heartbeat("worker-one"),
          })
        ).statusCode,
      ).toBe(202);

      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/workers/worker-one/credentials/${rotated.credentialSummary.id}`,
        headers: authHeaders,
      });
      expect(revoked.statusCode).toBe(204);
      expect(disconnect).toHaveBeenCalledWith(
        "worker-one",
        "Worker credential was revoked",
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: { authorization: `Bearer ${rotated.credential}` },
            payload: heartbeat("worker-one"),
          })
        ).statusCode,
      ).toBe(401);

      const unlinked = await app.inject({
        method: "DELETE",
        url: "/api/workers/worker-one",
        headers: authHeaders,
      });
      expect(unlinked.statusCode).toBe(204);
      expect(
        workerManagementListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/workers/management",
              headers: authHeaders,
            })
          ).json(),
        ),
      ).toEqual([]);

      const relinkCode = workerEnrollmentCodeResultSchema.parse(
        (
          await app.inject({
            method: "POST",
            url: "/api/workers/enrollment-codes",
            headers: authHeaders,
            payload: { label: "Studio Mac", expiresInSeconds: 300 },
          })
        ).json(),
      );
      const relinked = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: {
          code: relinkCode.code,
          heartbeat: heartbeat("worker-one"),
        },
      });
      expect(relinked.statusCode).toBe(201);
      expect(
        workerManagementListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/workers/management",
              headers: authHeaders,
            })
          ).json(),
        )[0],
      ).toMatchObject({ name: "Studio Mac", internal: false });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("protects the internal development worker from account management actions", async () => {
    const hostedConfig = await createConfig();
    const config: ServerConfig = {
      ...hostedConfig,
      adminBootstrapToken: undefined,
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      cookieSameSite: "lax",
      cookieSecure: false,
      deploymentMode: "local",
      host: "127.0.0.1",
      publicRegistration: false,
      workerToken: "local-development-token",
    };
    const database = await connectDatabase(config);
    await database.repository.recordWorker(
      "00000000-0000-0000-0000-000000000001",
      heartbeat("local-worker"),
    );
    const app = await buildApp({ config, database, logger: false });
    try {
      const managed = workerManagementListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/workers/management",
          })
        ).json(),
      );
      expect(managed[0]).toMatchObject({
        workerId: "local-worker",
        internal: true,
        editable: false,
        removable: false,
      });
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/workers/local-worker",
            payload: { name: "Renamed" },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/workers/local-worker",
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
});
