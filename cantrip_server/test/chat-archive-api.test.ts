import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archivedChatWireListSchema,
  chatWireListSchema,
  chatWireSummarySchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  ARCHIVED_CHAT_RETENTION_MS,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-archive-api-"),
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

async function createChat(_title: string) {
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create archive test chat.");
  return chat;
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "archive-worker",
    name: "Archive Worker",
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
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "archive-worker",
    ...protectedProjectFields(),
    repositoryId: "archive-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "archive-worker",
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

describe.sequential("chat archive API", () => {
  it("routes opaque rename and fork labels without synthesizing plaintext", async () => {
    const source = await createChat("Source title");
    const renamed = protectedChatFields(source.id).titleProtection;
    const renameResponse = await app.inject({
      method: "PATCH",
      url: `/api/chats/${source.id}`,
      payload: { titleProtection: renamed },
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(chatWireSummarySchema.parse(renameResponse.json())).toMatchObject({
      id: source.id,
      titleProtection: renamed,
    });

    await database.repository.appendMessage(LOCAL_USER_ID, source.id, {
      role: "user",
      content: [{ type: "text", text: "Fork from this message" }],
      idempotencyKey: "opaque-title-fork-source",
    });
    const forkFields = protectedChatFields();
    const forkResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${source.id}/fork`,
      payload: forkFields,
    });
    expect(forkResponse.statusCode).toBe(201);
    expect(chatWireSummarySchema.parse(forkResponse.json())).toMatchObject({
      id: forkFields.id,
      titleProtection: forkFields.titleProtection,
    });
  });

  it("archives populated chats and restores them with their history", async () => {
    const chat = await createChat("Keep this work");
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "user",
      content: [{ type: "text", text: "Important conversation" }],
      idempotencyKey: "archive-message",
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      chatWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/chats`,
          })
        ).json(),
      ),
    ).not.toContainEqual(expect.objectContaining({ id: chat.id }));

    const archived = archivedChatWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/archived-chats`,
        })
      ).json(),
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: chat.id,
      messageCount: 1,
      titleProtection: chat.titleProtection,
    });
    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).toBeNull();

    const restoredResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/restore`,
    });
    expect(restoredResponse.statusCode).toBe(200);
    expect(chatWireSummarySchema.parse(restoredResponse.json()).id).toBe(
      chat.id,
    );
    expect(
      await database.repository.listMessages(LOCAL_USER_ID, chat.id),
    ).toHaveLength(1);
  });

  it("hard-deletes empty chats and blocks removal during active work", async () => {
    const empty = await createChat("Empty agent");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/chats/${empty.id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${empty.id}/restore`,
        })
      ).statusCode,
    ).toBe(404);

    const running = await createChat("Busy agent");
    await database.repository.setChatStatus(running.id, "running");
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/chats/${running.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Stop the running chat first." });
    await database.repository.setChatStatus(running.id, "idle");
  });

  it("permanently removes archived chats after explicit deletion or expiry", async () => {
    const explicit = await createChat("Delete forever");
    await database.repository.appendMessage(LOCAL_USER_ID, explicit.id, {
      role: "user",
      content: [{ type: "text", text: "Disposable" }],
      idempotencyKey: "archive-explicit",
    });
    await app.inject({ method: "DELETE", url: `/api/chats/${explicit.id}` });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${explicit.id}/permanent`,
        })
      ).statusCode,
    ).toBe(204);

    const expired = await createChat("Expired agent");
    await database.repository.appendMessage(LOCAL_USER_ID, expired.id, {
      role: "user",
      content: [{ type: "text", text: "Old work" }],
      idempotencyKey: "archive-expired",
    });
    await app.inject({ method: "DELETE", url: `/api/chats/${expired.id}` });
    expect(
      await database.repository.purgeExpiredArchivedChats(
        LOCAL_USER_ID,
        new Date(Date.now() + ARCHIVED_CHAT_RETENTION_MS + 1),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      archivedChatWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/archived-chats`,
          })
        ).json(),
      ),
    ).toHaveLength(0);
  });
});
