import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decodeWorkerConnectionEnvelope,
  unprobedCodexRuntimeReport,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_SUBPROTOCOLS,
  workerListSchema,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  LOCAL_USER_ID,
  WORKER_ONLINE_WINDOW_MS,
} from "../src/db/repository.js";
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
let attachedContinuityIdentity: Parameters<WorkerCommandBus["attach"]>[3];
let attachedProtocol: string | undefined;
let connectionLifecycle: string[] | null = null;
const workerBridge: WorkerCommandBus = {
  attach(_workerId, socket, _ownerId, continuityIdentity) {
    subscribedBeforeAttach = notificationSubscribed;
    attachedContinuityIdentity = continuityIdentity;
    attachedProtocol = socket.protocol;
    connectionLifecycle?.push("attach");
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
  it("subscribes before attachment and trusts the live command connection", async () => {
    const workerProcessGeneration = "11111111-1111-4111-8111-111111111111";
    const lifecycle: string[] = [];
    connectionLifecycle = lifecycle;
    const socket = await app.injectWS(
      `/api/internal/workers/connect?workerId=notification-order-worker&connectionGeneration=${workerProcessGeneration}`,
      {
        headers: {
          authorization: "Bearer test-worker-token",
          "sec-websocket-protocol": WORKER_WEBSOCKET_SUBPROTOCOLS.join(", "),
        },
      },
      {
        onInit(client) {
          client.on("message", (data) => {
            const envelope = decodeWorkerConnectionEnvelope(data.toString());
            if (envelope.success) lifecycle.push(envelope.data.state);
          });
        },
      },
    );

    await expect.poll(() => subscribedBeforeAttach).toBe(true);
    await expect.poll(() => lifecycle.includes("ready")).toBe(true);
    expect(lifecycle.indexOf("pending")).toBeLessThan(
      lifecycle.indexOf("ready"),
    );
    expect(lifecycle.indexOf("attach")).toBeLessThan(
      lifecycle.indexOf("ready"),
    );
    expect(attachedContinuityIdentity).toEqual({
      credentialId: "development-bootstrap",
      ownerId: LOCAL_USER_ID,
      workerProcessGeneration,
    });
    expect(attachedProtocol).toBe(WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL);
    const worker = await database.repository.getWorker(
      LOCAL_USER_ID,
      "notification-order-worker",
    );
    if (!worker) throw new Error("Notification order worker was not found.");
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        new Date(worker.lastSeenAt).getTime() + WORKER_ONLINE_WINDOW_MS + 1,
      );
    try {
      const workers = workerListSchema.parse(
        (await app.inject({ method: "GET", url: "/api/workers" })).json(),
      );
      expect(
        workers.find(
          ({ workerId }) => workerId === "notification-order-worker",
        ),
      ).toMatchObject({ online: true });
    } finally {
      connectionLifecycle = null;
      now.mockRestore();
      socket.terminate();
    }
  });

  it("preserves a legacy worker connection without ready envelopes", async () => {
    const workerProcessGeneration = "22222222-2222-4222-8222-222222222222";
    const lifecycle: string[] = [];
    attachedProtocol = undefined;
    connectionLifecycle = lifecycle;
    const socket = await app.injectWS(
      `/api/internal/workers/connect?workerId=notification-order-worker&connectionGeneration=${workerProcessGeneration}`,
      {
        headers: {
          authorization: "Bearer test-worker-token",
          "sec-websocket-protocol": WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
        },
      },
      {
        onInit(client) {
          client.on("message", (data) => {
            const envelope = decodeWorkerConnectionEnvelope(data.toString());
            if (envelope.success) lifecycle.push(envelope.data.state);
          });
        },
      },
    );

    try {
      await expect
        .poll(() => attachedProtocol)
        .toBe(WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lifecycle).toEqual(["attach"]);
    } finally {
      connectionLifecycle = null;
      socket.terminate();
    }
  });

  it("keeps auth-ready-v1 envelopes byte-compatible for older workers", async () => {
    const workerProcessGeneration = "33333333-3333-4333-8333-333333333333";
    const envelopes: Array<{
      protocolVersion: number;
      serverControlPlaneGeneration?: string;
      state: string;
    }> = [];
    attachedProtocol = undefined;
    const socket = await app.injectWS(
      `/api/internal/workers/connect?workerId=notification-order-worker&connectionGeneration=${workerProcessGeneration}`,
      {
        headers: {
          authorization: "Bearer test-worker-token",
          "sec-websocket-protocol": WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
        },
      },
      {
        onInit(client) {
          client.on("message", (data) => {
            const envelope = decodeWorkerConnectionEnvelope(data.toString());
            if (envelope.success) envelopes.push(envelope.data);
          });
        },
      },
    );

    try {
      await expect
        .poll(() => attachedProtocol)
        .toBe(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL);
      await expect
        .poll(() => envelopes.map(({ state }) => state))
        .toEqual(["pending", "ready"]);
      expect(envelopes).toEqual([
        {
          connectionGeneration: workerProcessGeneration,
          kind: "connection",
          protocolVersion: 1,
          state: "pending",
        },
        {
          connectionGeneration: workerProcessGeneration,
          kind: "connection",
          protocolVersion: 1,
          state: "ready",
        },
      ]);
    } finally {
      socket.terminate();
    }
  });
});
