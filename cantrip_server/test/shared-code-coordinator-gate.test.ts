import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
} from "../src/coordination/relay-coordinator.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-shared-code-coordinator-gate-"),
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

const request = vi.fn(async () => ({ available: true }));
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected: () => true,
  request,
  sendSurfaceFrame: () => false,
  subscribeSurfaceFrames: () => () => undefined,
  subscribeWorkerDisconnect: () => () => undefined,
};

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  database = await connectDatabase(config);
  const coordinator = new InMemoryRelayCoordinator(
    "shared-code-gate-instance",
    createInMemoryRelayCoordinatorBackend(),
  );
  await coordinator.start();
  app = await buildApp({
    config,
    coordinator,
    database,
    logger: false,
    workerBridge,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { force: true, recursive: true });
});

describe("shared Code coordinated-server rollout gate", () => {
  it("rejects v2 creation before worker or tunnel side effects", async () => {
    const attachmentId = randomUUID();
    const sessionId = randomUUID();
    const transportId = randomUUID();
    const registerManagedTunnel = vi.spyOn(
      database.repository,
      "registerManagedTunnel",
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/explorers/${randomUUID()}/code-session-attachments`,
      payload: {
        appearance: "dark",
        attachmentId,
        expectedWorkerId: "worker-1",
        expectedWorktreeId: randomUUID(),
        formatVersion: 2,
        path: "src/index.ts",
        sessionId,
        transport: {
          formatVersion: 2,
          protectedRecord: {
            operationId: transportId,
            protectedContent: {
              domain: "tunnel-content",
              envelope: {
                algorithm: "AES-256-GCM",
                ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
                keyRevision: 1,
                nonce: "AAAAAAAAAAAAAAAA",
                version: 1,
              },
              formatVersion: 1,
              keyRevision: 1,
            },
            revision: 1,
          },
          transportId,
        },
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "shared-code-transport-requires-single-server",
    });
    expect(request).not.toHaveBeenCalled();
    expect(registerManagedTunnel).not.toHaveBeenCalled();
  });
});
