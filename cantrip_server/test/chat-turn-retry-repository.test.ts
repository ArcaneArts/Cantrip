import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-turn-retry-repository-"),
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

function opaqueMessage(role: "assistant" | "user", id = randomUUID()) {
  return {
    id,
    classification: {
      role,
      mode: "default" as const,
      attachmentIds: [],
    },
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
    reasoningEffort: null,
    idempotencyKey: `message:${id}`,
  };
}

let database: DatabaseConnection;
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  const workerId = "chat-turn-retry-worker";
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name: "Chat turn retry worker",
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
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "R".repeat(43),
    repositoryId: "chat-turn-retry-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    workerId,
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
  if (!chat) throw new Error("Could not create retry repository test chat.");
  chatId = chat.id;
});

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("latest encrypted chat turn trimming", () => {
  it("reconciles a recovered protected child event into one opaque row", async () => {
    const recovered = opaqueMessage("assistant");
    recovered.idempotencyKey = "activity:root-turn:child-thread:child-item";
    await database.repository.appendEncryptedMessage(
      LOCAL_USER_ID,
      chatId,
      recovered,
    );
    await database.repository.upsertEncryptedMessage(LOCAL_USER_ID, chatId, {
      ...recovered,
      protectedContent: {
        ...recovered.protectedContent,
        envelope: {
          ...recovered.protectedContent.envelope,
            nonce: "AQEBAQEBAQEBAQEB",
            ciphertext: "AQEBAQEBAQEBAQEBAQEBAQ",
        },
      },
    });

    const matching = (
      await database.repository.listEncryptedMessages(LOCAL_USER_ID, chatId)
    ).filter(
      ({ idempotencyKey }) => idempotencyKey === recovered.idempotencyKey,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      id: recovered.id,
      protectedContent: {
        envelope: { ciphertext: "AQEBAQEBAQEBAQEBAQEBAQ" },
      },
    });
  });

  it("removes only the exact latest user turn and everything after it", async () => {
    const firstUser = opaqueMessage("user");
    const firstAssistant = opaqueMessage("assistant");
    const latestUser = opaqueMessage("user");
    const interruptedMarker = opaqueMessage("assistant");
    for (const message of [
      firstUser,
      firstAssistant,
      latestUser,
      interruptedMarker,
    ]) {
      await database.repository.appendEncryptedMessage(
        LOCAL_USER_ID,
        chatId,
        message,
      );
    }

    await expect(
      database.repository.getLatestEncryptedUserMessage(LOCAL_USER_ID, chatId),
    ).resolves.toMatchObject({ id: latestUser.id });
    await expect(
      database.repository.trimLatestEncryptedTurn(
        LOCAL_USER_ID,
        chatId,
        firstUser.id,
      ),
    ).resolves.toBe(false);
    await expect(
      database.repository.trimLatestEncryptedTurn(
        LOCAL_USER_ID,
        chatId,
        latestUser.id,
      ),
    ).resolves.toBe(true);

    const remaining = await database.repository.listEncryptedMessages(
      LOCAL_USER_ID,
      chatId,
    );
    expect(remaining.map(({ id }) => id)).toEqual(
      expect.arrayContaining([firstUser.id, firstAssistant.id]),
    );
    expect(remaining.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([latestUser.id, interruptedMarker.id]),
    );
  });
});
