import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  providerAccessTokenLeaseSchema,
  workerCredentialListSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
  workerEnrollmentResultSchema,
  workerManagementListSchema,
  workerRestartResultSchema,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { hashPassword, hashSecret } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { WorkerBridge, WorkerUnavailableError } from "../src/workers/bridge.js";

const origin = "https://app.cantrip.test";
const bootstrapToken = "worker-enrollment-bootstrap-token-123456";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected session cookie.");
  return cookie.split(";", 1)[0]!;
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
  it("reassigns a desktop worker only with its old credential and revokes the prior account", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const bridge = new WorkerBridge();
    const disconnect = vi.spyOn(bridge, "disconnect");
    const app = await buildApp({
      config,
      database,
      logger: false,
      workerBridge: bridge,
    });
    try {
      const passwordHash = await hashPassword(password);
      const ownerA = await database.repository.createAccount({
        displayName: "Owner A",
        email: "a@example.com",
        normalizedEmail: "a@example.com",
        passwordHash,
        role: "member",
      });
      const ownerB = await database.repository.createAccount({
        displayName: "Owner B",
        email: "b@example.com",
        normalizedEmail: "b@example.com",
        passwordHash,
        role: "member",
      });
      const codeA = `ctwl_${"a".repeat(32)}`;
      await database.repository.createWorkerEnrollmentCode({
        codeHash: hashSecret(codeA),
        createdBySessionId: null,
        expiresAt: new Date(Date.now() + 60_000),
        label: "Desktop A",
        ownerId: ownerA.id,
      });
      const firstResponse = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: {
          code: codeA,
          heartbeat: heartbeat("desktop-old"),
          replacement: null,
        },
      });
      expect(firstResponse.statusCode).toBe(201);
      const first = workerEnrollmentResultSchema.parse(firstResponse.json());

      const codeB = `ctwl_${"b".repeat(32)}`;
      await database.repository.createWorkerEnrollmentCode({
        codeHash: hashSecret(codeB),
        createdBySessionId: null,
        expiresAt: new Date(Date.now() + 60_000),
        label: "Desktop B",
        ownerId: ownerB.id,
      });
      const reassignedResponse = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: {
          code: codeB,
          heartbeat: heartbeat("desktop-new"),
          replacement: {
            workerId: "desktop-old",
            credential: first.credential,
          },
        },
      });
      expect(reassignedResponse.statusCode).toBe(201);
      expect(
        await database.repository.listWorkerManagement(ownerA.id),
      ).toHaveLength(0);
      expect(await database.repository.listWorkerManagement(ownerB.id)).toEqual(
        [
          expect.objectContaining({
            worker: expect.objectContaining({ workerId: "desktop-new" }),
          }),
        ],
      );
      expect(disconnect).toHaveBeenCalledWith(
        "desktop-old",
        "Worker was reassigned to another account",
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: { authorization: `Bearer ${first.credential}` },
            payload: heartbeat("desktop-old"),
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("pairs once, binds identity, rotates, and revokes without legacy fallback", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const bridge = new WorkerBridge();
    const disconnect = vi.spyOn(bridge, "disconnect");
    const isConnected = vi.spyOn(bridge, "isConnected").mockReturnValue(false);
    const commandRequest = vi
      .spyOn(bridge, "request")
      .mockImplementation(async (_workerId, command) =>
        command.type === "worker.restart"
          ? { restarting: true }
          : { accepted: true },
      );
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
      expect(link.workerId).toBeNull();
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
      const ownerId = registered.json().currentUser.id as string;
      const provider = await database.repository.createModelProvider(ownerId, {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        kind: "chatgpt",
        name: "ChatGPT",
      });
      const providerAccountId = provider.accounts[0]!.id;
      await database.repository.storeModelProviderAccountCredential(
        ownerId,
        provider.id,
        providerAccountId,
        {
          accessToken: "leased-worker-access-token",
          accountId: "upstream-account",
          email: "owner@example.com",
          expiresAt: Date.now() + 60 * 60_000,
          idToken: "server-only-identity-token",
          kind: "chatgpt",
          planType: "pro",
          refreshToken: "server-only-refresh-token",
          userId: "upstream-user",
          version: 1,
        },
        0,
      );
      const leaseUrl = `/api/internal/workers/providers/${provider.id}/accounts/${providerAccountId}/access-lease`;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${leaseUrl}?workerId=worker-one`,
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${leaseUrl}?workerId=worker-two`,
            headers: {
              authorization: `Bearer ${enrolled.credential}`,
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      const leaseResponse = await app.inject({
        method: "POST",
        url: `${leaseUrl}?workerId=worker-one`,
        headers: { authorization: `Bearer ${enrolled.credential}` },
        payload: {},
      });
      expect(leaseResponse.statusCode).toBe(200);
      expect(
        providerAccessTokenLeaseSchema.parse(leaseResponse.json()),
      ).toMatchObject({
        accessToken: "leased-worker-access-token",
        providerAccountId,
        providerId: provider.id,
        providerKind: "chatgpt",
      });
      expect(leaseResponse.body).not.toContain("server-only");
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
      commandRequest.mockRejectedValueOnce(
        new WorkerUnavailableError("Worker worker-one is offline."),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/workers/worker-one/restart",
            headers: authHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/workers/not-this-owners-worker/restart",
            headers: authHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      const restarted = await app.inject({
        method: "POST",
        url: "/api/workers/worker-one/restart",
        headers: authHeaders,
        payload: {},
      });
      expect(restarted.statusCode).toBe(202);
      expect(workerRestartResultSchema.parse(restarted.json())).toEqual({
        workerId: "worker-one",
        status: "restarting",
      });
      expect(commandRequest).toHaveBeenLastCalledWith(
        "worker-one",
        { type: "worker.restart" },
        expect.objectContaining({
          ownerId: registered.json().currentUser.id,
          timeoutMs: 10_000,
        }),
      );
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
        expect.objectContaining({ timeoutMs: 10_000 }),
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

      const project = await database.repository.createGithubProject(
        registered.json().currentUser.id as string,
        {
          workerId: "worker-one",
          repositoryId: "worker-reenrollment-project",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        },
      );
      await database.repository.completeGithubProjectSetup(
        registered.json().currentUser.id as string,
        project.id,
        "worker-one",
        {
          path: path.join(config.dataDirectory, "worker-one", "Cantrip"),
          displayPath: "ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        },
      );

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
            payload: {
              label: "Studio Mac",
              expiresInSeconds: 300,
              candidateWorkerIds: [
                "worker-owned-by-someone-else",
                "worker-one",
              ],
            },
          })
        ).json(),
      );
      expect(relinkCode.workerId).toBe("worker-one");
      const relinked = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: {
          code: relinkCode.code,
          heartbeat: heartbeat(relinkCode.workerId!),
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
