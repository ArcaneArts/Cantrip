import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  browserServiceListSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-browser-services-api-"),
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

const services = browserServiceListSchema.parse([
  {
    host: "127.0.0.1",
    port: 5173,
    protocol: "http",
    url: "http://127.0.0.1:5173/",
    title: "Cantrip Dev",
    processName: "Vite",
    statusCode: 200,
  },
]);
const commands: WorkerCommand[] = [];
let connected = true;
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connected && workerId === "test-worker";
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
    if (command.type === "browser.services.discover") return services;
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let browserId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: true,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    repositoryId: "browser-services-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "test-worker",
    {
      path: path.join(dataDirectory, "project"),
      displayPath: path.join(dataDirectory, "project"),
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const browser = await database.repository.createBrowser(
    LOCAL_USER_ID,
    project.id,
    { title: "Browser" },
  );
  if (!browser) throw new Error("Expected test browser creation to succeed.");
  browserId = browser.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("browser service discovery API", () => {
  it("routes discovery through the browser's owning worker", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/browsers/${browserId}/services`,
    });

    expect(response.statusCode).toBe(200);
    expect(browserServiceListSchema.parse(response.json())).toEqual(services);
    expect(commands.at(-1)).toEqual({ type: "browser.services.discover" });
  });

  it("reports an offline project worker", async () => {
    connected = false;
    const response = await app.inject({
      method: "GET",
      url: `/api/browsers/${browserId}/services`,
    });
    connected = true;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Project worker is offline." });
  });

  it("does not expose another or missing browser", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/browsers/missing/services",
    });
    expect(response.statusCode).toBe(404);
  });
});
