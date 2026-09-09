import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeCommandAdmissionSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import type { ServerConfig } from "../src/config.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import { resolveSecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

export const settingsEnvelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
};

/** Real migrations and durable database, isolated from any user's worker or app. */
export async function createNativeSettingsFixture() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-settings-state-"),
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
    port: 4310,
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    workerToken: "test-worker-token",
  };
  const vault = await resolveSecretVault(config);
  const location = path.join(dataDirectory, "database");
  let client = new PGlite(location);
  let db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  let repository = new ServerRepository(db, vault);
  const workerId = "settings-worker";
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );

  await repository.recordWorker(LOCAL_USER_ID, {
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
  const project = await repository.createGithubProject(LOCAL_USER_ID, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "R".repeat(43),
    repositoryId: "chat-turn-retry-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await repository.completeGithubProjectSetup(
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
  const chat = await repository.createChat(LOCAL_USER_ID, project.id, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create retry repository test chat.");
  const chatId = chat.id;
  const boot = await repository.startChatExecutionLane(
    LOCAL_USER_ID,
    chatId,
    "user",
    "Fixture native session",
  );
  if (!boot?.executionLaneId) throw new Error("Missing fixture lane");
  await repository.updateChatExecutionLaneRuntime(
    chatId,
    boot.executionLaneId,
    "native-thread",
    "ready",
  );
  await repository.finishChatExecutionLane(
    chatId,
    boot.executionLaneId,
    "idle",
  );
  return {
    config,
    get repository() {
      return repository;
    },
    chatId,
    workerId,
    get client() {
      return client;
    },
    get db() {
      return db;
    },
    get commands() {
      return repository.nativeCommands;
    },
    async input(origin: "gui" | "terminal" = "terminal") {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      if (!context) throw new Error("Missing settings fixture context");
      return nativeCommandAdmissionSchema.parse({
        workerId,
        operationId: randomUUID(),
        origin,
        method: "thread/settings/update",
        session: {
          chatId,
          threadId: context.threadId,
          contextKind: context.contextKind,
          projectId: context.projectId,
          placementId: context.worktreeId ?? context.scratchRootId,
          modelRouteId: context.modelRouteId,
          providerAccountId: context.providerAccountId,
          runtimeGeneration: "runtime-one",
          connectionId: "view-one",
        },
        payloadDigest: "a".repeat(64),
        protectedPayload: settingsEnvelope,
        expectedActivationGeneration: null,
        intent: {
          scope: "thread",
          settingKeys: ["model"],
          nativeSettingsOperationId: randomUUID(),
          expectedTurnId: null,
        },
      });
    },
    async restart() {
      await client.close();
      client = new PGlite(location);
      db = drizzle(client, { schema });
      await migrate(db, {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      repository = new ServerRepository(db, vault);
    },
    async close() {
      await client.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}
