import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encryptedChatComposerDraftWireStateSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-composer-draft-api-"),
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
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "draft-worker",
    name: "Draft Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.149.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "draft-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "A".repeat(43),
    repositoryId: "draft-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "draft-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const chat = await database.repository.createChat(LOCAL_USER_ID, project.id, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create composer draft test chat.");
  chatId = chat.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("chat composer draft API", () => {
  it("persists and clears an opaque composer draft with its chat", async () => {
    const state = {
      protectedContent: {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    const update = await app.inject({
      method: "PUT",
      url: `/api/chats/${chatId}/composer-draft`,
      payload: { state },
    });
    expect(update.statusCode).toBe(200);
    expect(
      encryptedChatComposerDraftWireStateSchema.parse(update.json()),
    ).toMatchObject({ chatId, state });

    const restored = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/composer-draft`,
    });
    expect(restored.statusCode).toBe(200);
    expect(
      encryptedChatComposerDraftWireStateSchema.parse(restored.json()),
    ).toMatchObject({ chatId, state });

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/chats/${chatId}/composer-draft`,
      payload: { state: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      encryptedChatComposerDraftWireStateSchema.parse(cleared.json()),
    ).toMatchObject({ chatId, state: null });
  });
});
