import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  serviceLogReadResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const origin = "https://app.cantrip.test";
const password = "correct horse battery staple";
const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-logs-api-"),
);
const config: ServerConfig = {
  adminBootstrapToken: "unused-public-registration-token-32-chars",
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  allowInsecureRemote: false,
  appOrigins: [origin],
  authMode: "accounts",
  authRateLimit: 50,
  bootstrapMode: "hosted",
  cookieSameSite: "none",
  cookieSecure: true,
  dataDirectory,
  deploymentMode: "hosted",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  publicOrigin: "https://server.cantrip.test",
  publicRegistration: true,
  secretEncryption: {
    activeKeyId: "test",
    keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
  },
  sessionTtlSeconds: 3_600,
  workerToken: "worker-logs-api-token",
};

let connected = true;
const commands: WorkerCommand[] = [];
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connected && workerId === "first-worker";
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
  async request(_workerId, command) {
    commands.push(command);
    return {
      records: [
        {
          cursor: 8,
          timestamp: "2026-08-16T12:00:00.000Z",
          system: "worker",
          level: "info",
          message: "Command channel connected",
        },
      ],
      nextCursor: 8,
      oldestCursor: 2,
      latestCursor: 8,
      hasMore: false,
      truncated: false,
    };
  },
};

type Account = { cookie: string; userId: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let first: Account;
let second: Account;

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected session cookie.");
  return cookie.split(";", 1)[0]!;
}

beforeAll(async () => {
  database = await connectDatabase(config);
  app = await buildApp({ config, database, logger: false, workerBridge });
  const register = async (email: string, displayName: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { host: "server.cantrip.test", origin },
      payload: { displayName, email, password },
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      cookie: sessionCookie(response),
      userId: response.json().currentUser.id as string,
    };
  };
  first = await register("logs-first@example.com", "Logs first");
  second = await register("logs-second@example.com", "Logs second");
  await database.repository.recordWorker(first.userId, {
    workerId: "first-worker",
    name: "First worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.148.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("worker logs API", () => {
  it("routes bounded cursor reads to an owned online worker", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/workers/first-worker/logs?afterCursor=7&limit=50&minimumLevel=info",
      headers: { cookie: first.cookie, host: "server.cantrip.test", origin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(serviceLogReadResultSchema.parse(response.json())).toMatchObject({
      nextCursor: 8,
      records: [{ cursor: 8, message: "Command channel connected" }],
    });
    expect(commands).toContainEqual({
      type: "diagnostics.logs.read",
      afterCursor: 7,
      limit: 50,
      minimumLevel: "info",
    });
  });

  it("makes foreign and unknown worker identifiers indistinguishable", async () => {
    const before = commands.length;
    for (const workerId of ["first-worker", "unknown-worker"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/workers/${workerId}/logs`,
        headers: {
          cookie: second.cookie,
          host: "server.cantrip.test",
          origin,
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Worker not found." });
    }
    expect(commands).toHaveLength(before);
  });

  it("rejects malformed queries before contacting the worker", async () => {
    const before = commands.length;
    const response = await app.inject({
      method: "GET",
      url: "/api/workers/first-worker/logs?limit=501",
      headers: { cookie: first.cookie, host: "server.cantrip.test", origin },
    });
    expect(response.statusCode).toBe(400);
    expect(commands).toHaveLength(before);
  });

  it("reports an owned worker as offline without issuing a command", async () => {
    connected = false;
    const before = commands.length;
    const response = await app.inject({
      method: "GET",
      url: "/api/workers/first-worker/logs",
      headers: { cookie: first.cookie, host: "server.cantrip.test", origin },
    });
    connected = true;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Worker is offline." });
    expect(commands).toHaveLength(before);
  });
});
