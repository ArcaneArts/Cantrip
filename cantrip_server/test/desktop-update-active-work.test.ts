import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  desktopUpdateActiveWorkSummarySchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { DEFAULT_MODEL_ID, LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-desktop-update-active-work-"),
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
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected() {
    return false;
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
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "desktop-update-worker",
    name: "Desktop Update Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "desktop-update-worker",
    repositoryId: "desktop-update-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "desktop-update-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("desktop update active-work API", () => {
  it("starts with an empty local-work summary", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/desktop-update/active-work",
    });

    expect(response.statusCode).toBe(200);
    expect(desktopUpdateActiveWorkSummarySchema.parse(response.json())).toEqual(
      {
        activeChats: 0,
        queuedPrompts: 0,
        terminalServices: 0,
        backgroundJobs: 0,
      },
    );
  });

  it("counts active chats, buffered prompts, and terminal services", async () => {
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      { title: "Updating agent", worktreeMode: "agent-managed" },
    );
    if (!chat) throw new Error("Could not create update test chat.");
    await database.repository.setChatStatus(chat.id, "running");
    await database.repository.createQueuedPrompt(
      LOCAL_USER_ID,
      chat.id,
      {
        attachmentIds: [],
        frozen: false,
        idempotencyKey: "desktop-update-prompt",
        mode: "default",
        reasoningEffort: null,
        text: "Finish before updating.",
        worktreeId: null,
      },
      DEFAULT_MODEL_ID,
    );
    const terminal = await database.repository.createTerminal(
      LOCAL_USER_ID,
      projectId,
      { title: "Local service" },
    );
    if (!terminal) throw new Error("Could not create update test terminal.");
    await database.repository.updateTerminalService(
      LOCAL_USER_ID,
      terminal.id,
      { enabled: true, command: "pnpm dev" },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/desktop-update/active-work",
    });

    expect(response.statusCode).toBe(200);
    expect(desktopUpdateActiveWorkSummarySchema.parse(response.json())).toEqual(
      {
        activeChats: 1,
        queuedPrompts: 1,
        terminalServices: 1,
        backgroundJobs: 0,
      },
    );
  });
});
