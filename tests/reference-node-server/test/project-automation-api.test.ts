import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encryptedChatTurnCreateSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  encryptedProjectAutomationCreateSchema,
  encryptedProjectAutomationUpdateSchema,
  projectAutomationDispatchResultSchema,
  projectAutomationWireListSchema,
  projectAutomationWireSchema,
} from "@cantrip/protocol/automations";
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

function bytes(seed: string, count: number): string {
  return createHash("sha256")
    .update(seed)
    .digest()
    .subarray(0, count)
    .toString("base64url");
}

function protectedEnvelope(seed: string) {
  return {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: bytes(`${seed}:nonce`, 12),
      ciphertext: bytes(`${seed}:ciphertext`, 32),
    },
  };
}

function protectedTurn(
  command: Extract<WorkerCommand, { type: "automation.dispatch.protect" }>,
) {
  const classification = {
    role: "user" as const,
    mode: command.mode,
    attachmentIds: [],
  };
  const message = {
    id: command.messageId,
    classification,
    protectedContent: protectedEnvelope("automation-message"),
    reasoningEffort: command.reasoningEffort,
    idempotencyKey: command.idempotencyKey,
  };
  return encryptedChatTurnCreateSchema.parse({
    message,
    queuedPrompt: {
      id: command.promptId,
      classification: { mode: command.mode, attachmentIds: [] },
      protectedContent: protectedEnvelope("automation-prompt"),
      modelId: command.modelId,
      reasoningEffort: command.reasoningEffort,
      worktreeId: null,
      frozen: false,
      idempotencyKey: command.idempotencyKey,
      pendingMessage: message,
    },
    modelId: command.modelId,
  });
}

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-automation-api-"),
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
const dispatchRequests: Extract<
  WorkerCommand,
  { type: "automation.dispatch.protect" }
>[] = [];
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
  async request(_workerId, command) {
    if (command.type === "automation.dispatch.protect") {
      dispatchRequests.push(command);
      return { allowed: true, protectedTurn: protectedTurn(command) };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "automation-worker",
    name: "Automation Worker",
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
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "automation-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: bytes("automation-repository-blind-index", 32),
    repositoryId: "automation-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "automation-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create automation target chat.");
  chatId = chat.id;
  await database.repository.setChatAutomationPaused(
    LOCAL_USER_ID,
    chatId,
    true,
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("protected project automation API", () => {
  it("stores opaque content and lets an authorized worker seal the scheduled turn", async () => {
    const id = randomUUID();
    const startsAt = new Date(Date.now() + 10_000).toISOString();
    const input = encryptedProjectAutomationCreateSchema.parse({
      id,
      chatId,
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minute",
        startsAt,
      },
      enabled: true,
      content: {
        protectedName: protectedEnvelope("private-name"),
        protectedPrompt: protectedEnvelope("private-prompt"),
        protectedCondition: protectedEnvelope("private-condition"),
      },
    });
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/automations`,
      payload: input,
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = projectAutomationWireSchema.parse(createdResponse.json());
    expect(created.id).toBe(id);
    expect(created).not.toHaveProperty("name");
    expect(created).not.toHaveProperty("prompt");
    expect(created).not.toHaveProperty("condition");
    expect(JSON.stringify(created)).toBe(
      JSON.stringify(created).replace(/SENTINEL/gu, ""),
    );

    const workerList = projectAutomationWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/internal/workers/automations?workerId=automation-worker",
          headers: { authorization: "Bearer test-worker-token" },
        })
      ).json(),
    );
    expect(workerList).toEqual([created]);

    const dispatched = await app.inject({
      method: "POST",
      url: `/api/internal/workers/automations/${id}/dispatch?workerId=automation-worker`,
      headers: { authorization: "Bearer test-worker-token" },
      payload: { revision: created.revision, scheduledFor: created.nextRunAt },
    });
    expect(dispatched.statusCode).toBe(202);
    expect(
      projectAutomationDispatchResultSchema.parse(dispatched.json()),
    ).toMatchObject({
      accepted: true,
      status: "queued",
    });
    expect(dispatchRequests).toHaveLength(1);
    expect(dispatchRequests[0]).toMatchObject({
      automationId: id,
      content: input.content,
      cwd: path.join(dataDirectory, "repository"),
    });
    const queued = await database.repository.listEncryptedQueuedPrompts(
      LOCAL_USER_ID,
      chatId,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.protectedContent).toBeDefined();

    const updated = encryptedProjectAutomationUpdateSchema.parse({
      enabled: false,
      content: { protectedName: protectedEnvelope("updated-private-name") },
    });
    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/automations/${id}`,
      payload: updated,
    });
    expect(updatedResponse.statusCode).toBe(200);
    expect(
      projectAutomationWireSchema.parse(updatedResponse.json()),
    ).toMatchObject({
      enabled: false,
      nextRunAt: null,
      content: { protectedName: updated.content!.protectedName },
    });
  });

  it("rejects the removed plaintext create contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/automations`,
      payload: {
        name: "SENTINEL visible name",
        chatId,
        prompt: "SENTINEL visible prompt",
        schedule: {
          kind: "interval",
          every: 1,
          unit: "day",
          startsAt: new Date(Date.now() + 60_000).toISOString(),
        },
        condition: null,
        enabled: true,
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
