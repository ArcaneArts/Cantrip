import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-notification-order-"),
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
  workerToken: "test-worker-token",
};

let notificationSubscribed = false;
let subscribedBeforeAttach: boolean | null = null;
const workerBridge: WorkerCommandBus = {
  attach() {
    subscribedBeforeAttach = notificationSubscribed;
  },
  close() {},
  isConnected() {
    return true;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeNotifications() {
    notificationSubscribed = true;
    return () => {
      notificationSubscribed = false;
    };
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "notification-order-worker",
    name: "Notification Order Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("worker notification connection order", () => {
  it("subscribes to durable outcomes before the reconnecting worker can flush them", async () => {
    const socket = await app.injectWS(
      "/api/internal/workers/connect?workerId=notification-order-worker",
      { headers: { authorization: "Bearer test-worker-token" } },
    );

    await expect.poll(() => subscribedBeforeAttach).toBe(true);
    socket.terminate();
  });
});
