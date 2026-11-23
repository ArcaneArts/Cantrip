import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encryptedChatTurnCreateSchema,
  unprobedCodexRuntimeReport,
  type WorkerEvent,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { DEFAULT_MODEL_ID } from "../src/db/repository.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

import { settingsEnvelope } from "./native-settings-repository-fixture.js";

// Database-backed cases include cold PGlite initialization (up to 12.6 s in CI).
// Their 30-second fixture budget leaves behavioral polling deadlines unchanged.
const origin = "https://app.cantrip.test";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected a session cookie.");
  return cookie.split(";", 1)[0]!;
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-hosted-chat-owner-context-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: "unused-public-registration-token-32-chars",
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 50,
    bootstrapMode: "pnpm-dev",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: true,
    secretEncryption: {
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "hosted-chat-owner-context-worker-token",
  };
}

afterEach(async () => {
  await Promise.all(
    dataDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("hosted chat owner context", () => {
  it("persists worker events delivered after the request context has ended", async () => {
    let pendingTurn:
      | {
          onEvent: NonNullable<WorkerRequestOptions["onEvent"]>;
          resultMode: Extract<
            WorkerCommand,
            { type: "chat.turn" }
          >["resultMode"];
          resolve(result: unknown): void;
        }
      | undefined;
    const terminals = new Map<string, () => void>();
    const workerBridge: WorkerCommandBus = {
      attach() {},
      close() {},
      isConnected() {
        return true;
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
      async request(_workerId, command, options) {
        if (command.type === "chat.thread.ensure")
          return { threadId: command.threadId ?? "hosted-thread" };
        if (command.type === "terminal.prepare-state")
          return protectedTerminalFields(command.terminalId);
        if (command.type === "terminal.open") {
          const completed = new Promise((resolve) =>
            terminals.set(command.attachmentId, () =>
              resolve({ status: "detached" }),
            ),
          );
          await options?.onEvent?.({ type: "terminal.ready" });
          return completed;
        }
        if (command.type === "terminal.detach") {
          terminals.get(command.attachmentId)?.();
          return { status: "detached" };
        }
        if (command.type === "chat.turn") {
          if (!options?.onEvent) {
            throw new Error("Expected the chat turn event callback.");
          }
          return new Promise((resolve) => {
            pendingTurn = {
              onEvent: options.onEvent!,
              resultMode: command.resultMode,
              resolve,
            };
          });
        }
        throw new Error(`Unexpected worker command ${command.type}.`);
      },
    };

    const config = await createConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({
      config,
      database,
      logger: false,
      workerBridge,
    });
    try {
      const registration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Hosted account",
          email: "hosted@example.com",
          password,
        },
      });
      expect(registration.statusCode).toBe(201);
      const ownerId = registration.json().currentUser.id as string;
      await database.repository.ensureDefaultModelConfiguration(
        ownerId,
        config.agentModel,
        config.ollamaBaseUrl,
      );
      const authHeaders = {
        cookie: sessionCookie(registration),
        origin,
        "x-cantrip-csrf": registration.json().csrfToken as string,
      };
      const workerId = "hosted-owner-context-worker";
      await database.repository.recordWorker(ownerId, {
        workerId,
        name: "Hosted owner context worker",
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
      const project = await database.repository.createGithubProject(ownerId, {
        workerId,
        ...protectedProjectFields(),
        repositoryBlindIndex: "R".repeat(43),
        repositoryId: "hosted-owner-context-repository",
        nameWithOwner: "ArcaneArts/HostedOwnerContext",
        url: "https://github.com/ArcaneArts/HostedOwnerContext",
      });
      await database.repository.completeGithubProjectSetup(
        ownerId,
        project.id,
        workerId,
        {
          path: path.join(config.dataDirectory, "HostedOwnerContext"),
          displayPath: "ArcaneArts/HostedOwnerContext",
          reused: false,
          updated: false,
          warning: null,
        },
      );

      const chatResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/chats`,
        headers: authHeaders,
        payload: protectedChatFields(),
      });
      expect(chatResponse.statusCode, chatResponse.body).toBe(201);
      const chatId = chatResponse.json().id as string;
      const modelResponse = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chatId}/model`,
        headers: authHeaders,
        payload: { modelId: DEFAULT_MODEL_ID },
      });
      expect(modelResponse.statusCode, modelResponse.body).toBe(200);

      const message = {
        id: randomUUID(),
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: settingsEnvelope,
        },
        reasoningEffort: null,
        idempotencyKey: "delayed-hosted-turn",
      };
      const turnResponse = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/turns`,
        headers: authHeaders,
        payload: encryptedChatTurnCreateSchema.parse({
          message,
          modelId: DEFAULT_MODEL_ID,
          queuedPrompt: {
            id: randomUUID(),
            classification: { mode: "default", attachmentIds: [] },
            protectedContent: message.protectedContent,
            modelId: DEFAULT_MODEL_ID,
            reasoningEffort: null,
            worktreeId: null,
            frozen: false,
            idempotencyKey: message.idempotencyKey,
            pendingMessage: message,
          },
        }),
      });
      expect(turnResponse.statusCode, turnResponse.body).toBe(202);
      await expect.poll(() => pendingTurn).toBeDefined();

      expect(pendingTurn!.resultMode.kind).toBe("chat-message-encrypted");
      if (pendingTurn!.resultMode.kind !== "chat-message-encrypted")
        throw new Error("Expected protected reply");
      const event: WorkerEvent = {
        type: "agent.protected-message",
        message: {
          ...message,
          id: pendingTurn!.resultMode.messageId,
          classification: {
            role: "assistant",
            mode: "default",
            attachmentIds: [],
          },
          idempotencyKey: pendingTurn!.resultMode.idempotencyKey,
        },
        telemetry: {
          kind: "message",
          phase: "final_answer",
          turnId: "hosted-turn",
        },
      };
      await expect(pendingTurn!.onEvent(event)).resolves.toBeUndefined();
      pendingTurn!.resolve({
        threadId: "hosted-thread",
        turnId: "hosted-turn",
        text: "",
        structuredResult: { message: event.message },
        status: "completed",
      });

      await expect
        .poll(async () => {
          const messages = await database.repository.listEncryptedMessages(
            ownerId,
            chatId,
          );
          return messages.find((stored) => stored.id === event.message.id)
            ?.protectedContent;
        })
        .toEqual(event.message.protectedContent);
      await expect
        .poll(async () => {
          const context = await database.repository.getChatExecutionContext(
            ownerId,
            chatId,
          );
          return context?.status;
        })
        .toBe("idle");
    } finally {
      await app.close();
    }
  }, 30_000);
});
