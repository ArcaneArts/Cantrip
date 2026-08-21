import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appLiveServerMessageSchema,
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  workerEnrollmentResultSchema,
  workerListSchema,
  type AppLiveServerMessage,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import { hashSecret } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { WORKER_ONLINE_WINDOW_MS } from "../src/db/repository.js";

const origin = "https://app.cantrip.test";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected a session cookie.");
  return cookie.split(";", 1)[0]!;
}

function heartbeat(workerId: string, name: string): WorkerHeartbeat {
  return {
    workerId,
    name,
    platform: "win32",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    code: unavailableCodeCapabilities,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  };
}

async function config(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-hosted-worker-presence-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 20,
    bootstrapMode: "pnpm-dev",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: true,
    secretEncryption: {
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 9) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "unused-hosted-worker-token",
  };
}

afterEach(async () => {
  await Promise.all(
    dataDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("hosted worker presence", () => {
  it("keeps account live state synchronized with the command connection", async () => {
    const serverConfig = await config();
    const database = await connectDatabase(serverConfig);
    const app = await buildApp({
      config: serverConfig,
      database,
      logger: false,
    });
    let liveSocket: Awaited<ReturnType<typeof app.injectWS>> | null = null;
    let workerSocket: Awaited<ReturnType<typeof app.injectWS>> | null = null;
    try {
      const registration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Worker owner",
          email: "worker-owner@example.com",
          password,
        },
      });
      expect(registration.statusCode).toBe(201);
      const ownerId = registration.json().currentUser.id as string;
      const cookie = sessionCookie(registration);
      const enrollmentCode = `ctwl_${"p".repeat(32)}`;
      await database.repository.createWorkerEnrollmentCode({
        codeHash: hashSecret(enrollmentCode),
        createdBySessionId: null,
        expiresAt: new Date(Date.now() + 60_000),
        label: "Windows worker",
        ownerId,
      });
      const enrollment = await app.inject({
        method: "POST",
        url: "/api/internal/workers/enroll",
        payload: {
          code: enrollmentCode,
          heartbeat: heartbeat("windows-worker", "Windows worker starting"),
          replacement: null,
        },
      });
      expect(enrollment.statusCode).toBe(201);
      const credential = workerEnrollmentResultSchema.parse(
        enrollment.json(),
      ).credential;

      const messages: AppLiveServerMessage[] = [];
      let liveClient: WebSocket | null = null;
      liveSocket = await app.injectWS(
        "/api/live",
        { headers: { cookie, origin } },
        {
          onInit(client) {
            liveClient = client;
            client.on("message", (data) => {
              messages.push(
                appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
              );
            });
          },
        },
      );
      if (!liveClient) throw new Error("Account live socket did not open.");
      liveClient.send(
        JSON.stringify({
          type: "initialize",
          protocolVersion: 1,
          client: { id: "worker-presence-test", name: "Test", version: "1" },
          resume: null,
        }),
      );
      await vi.waitFor(() =>
        expect(messages.at(-1)).toMatchObject({ type: "ready" }),
      );
      liveClient.send(
        JSON.stringify({
          type: "subscribe",
          requestId: "worker-presence",
          scopes: [{ kind: "current-user" }],
        }),
      );
      await vi.waitFor(() =>
        expect(messages.at(-1)).toMatchObject({
          type: "subscribed",
          requestId: "worker-presence",
        }),
      );

      const heartbeatEventStart = messages.length;
      const heartbeatResponse = await app.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: `Bearer ${credential}` },
        payload: heartbeat("windows-worker", "Windows worker online"),
      });
      expect(heartbeatResponse.statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(
          messages.slice(heartbeatEventStart).some(isWorkerPresenceEvent),
        ).toBe(true),
      );

      const connectionEventStart = messages.length;
      workerSocket = await app.injectWS(
        "/api/internal/workers/connect?workerId=windows-worker",
        { headers: { authorization: `Bearer ${credential}` } },
      );
      await vi.waitFor(() =>
        expect(
          messages.slice(connectionEventStart).some(isWorkerPresenceEvent),
        ).toBe(true),
      );

      const worker = await database.repository.getWorker(
        ownerId,
        "windows-worker",
      );
      if (!worker) throw new Error("Windows worker was not found.");
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValue(
          new Date(worker.lastSeenAt).getTime() + WORKER_ONLINE_WINDOW_MS + 1,
        );
      try {
        const workers = workerListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/workers",
              headers: { cookie },
            })
          ).json(),
        );
        expect(
          workers.find(({ workerId }) => workerId === "windows-worker"),
        ).toMatchObject({ online: true });
      } finally {
        now.mockRestore();
      }
    } finally {
      workerSocket?.terminate();
      liveSocket?.terminate();
      await app.close();
    }
  });
});

function isWorkerPresenceEvent(message: AppLiveServerMessage): boolean {
  return (
    message.type === "event" &&
    message.resource === "worker" &&
    message.scope.kind === "current-user"
  );
}
