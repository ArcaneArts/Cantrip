import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  taskWireCreateResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  taskEncryptedOperationStartSchema,
  taskOpaqueSummarySchema,
  type TaskOpaqueContent,
  type TaskOperationRelayRequest,
} from "@cantrip/protocol/tasks";
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

const sentinel = "SENTINEL private Task prose";
const encrypted = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

function taskContent(
  state: "draft" | "planning" | "review" | "failed",
  planningRound: number,
  operationKind: "initial-plan" | null,
): TaskOpaqueContent {
  return {
    classification: {
      state,
      stableStateBeforeFailure:
        state === "planning" || state === "failed" ? "draft" : null,
      activeOperationKind: operationKind,
      planAuthorship: "agent",
      planningRound,
      hasPlan: state === "review",
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError:
        state === "failed"
          ? {
              code: "task-operation-failed",
              operationKind: "initial-plan",
              occurredAt: "2026-08-19T12:00:00.000Z",
            }
          : null,
    },
    protectedContent: encrypted,
  };
}

function taskMessage(
  role: "assistant" | "user",
  id: string,
  idempotencyKey: string,
) {
  return {
    id,
    classification: { role, mode: "plan" as const, attachmentIds: [] },
    protectedContent: encrypted,
    reasoningEffort: null,
    idempotencyKey,
  };
}

function operation(chatId: string, rowVersion: number) {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const request: TaskOperationRelayRequest = {
    chatId,
    operationId,
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    classification: {
      ordinal: 1,
      kind: "initial-plan",
      status: "running",
      hasOutputPlan: false,
      hasOutputQuestions: false,
      hasOutputGoalPrompt: false,
      error: null,
    },
    protectedInput: encrypted,
    task: taskContent("planning", 1, "initial-plan"),
    userMessage: taskMessage(
      "user",
      "22222222-2222-4222-8222-222222222222",
      `task-operation:${operationId}`,
    ),
  };
  const error = {
    code: "task-operation-failed",
    operationKind: "initial-plan" as const,
    occurredAt: "2026-08-19T12:00:00.000Z",
  };
  return taskEncryptedOperationStartSchema.parse({
    rowVersion,
    operation: request,
    failure: {
      task: {
        ...taskContent("failed", 1, null),
        classification: {
          ...taskContent("failed", 1, null).classification,
          lastError: error,
        },
      },
      round: {
        classification: {
          ...request.classification,
          status: "failed",
          error,
        },
        protectedContent: encrypted,
      },
    },
  });
}

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-task-e2ee-"));
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

let observedTurn: Extract<WorkerCommand, { type: "chat.turn" }> | null = null;
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "task-worker";
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
    if (command.type === "project.folder.materialize") {
      return {
        status: "ready",
        jobId: command.jobId,
        attempt: command.attempt,
        path: path.join(dataDirectory, "managed-folders", command.projectId),
        displayPath: `managed-folders/${command.projectId}`,
        reused: false,
      };
    }
    if (command.type === "code.agentTurnState") {
      return { notifiedSessions: 0, refreshed: [], conflicts: [] };
    }
    if (command.type === "chat.turn") {
      observedTurn = command;
      if (command.resultMode.kind !== "task-encrypted") {
        throw new Error("Expected the encrypted Task relay.");
      }
      const request = command.resultMode.operation;
      return {
        threadId: "thread-task-e2ee",
        turnId: "turn-task-e2ee",
        text: "",
        structuredResult: {
          chatId: request.chatId,
          operationId: request.operationId,
          fingerprint: request.fingerprint,
          classification: {
            ...request.classification,
            status: "completed",
            hasOutputPlan: true,
          },
          protectedResult: encrypted,
          task: taskContent("review", 1, null),
          assistantMessage: taskMessage(
            "assistant",
            "33333333-3333-4333-8333-333333333333",
            `task-result:${request.operationId}`,
          ),
          goal: null,
        },
        status: "completed",
      };
    }
    throw new Error(`Unexpected encrypted Task command ${command.type}.`);
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
    workerId: "task-worker",
    name: "Task Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.148.0",
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: { create: true, convertToGithub: true, remove: true },
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "task-worker",
    ...protectedProjectFields(),
    repositoryId: "task-e2ee",
    nameWithOwner: "ArcaneArts/TaskE2EE",
    url: "https://github.com/ArcaneArts/TaskE2EE",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "task-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/TaskE2EE",
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

async function waitForState(chatId: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${chatId}`,
    });
    const task = taskOpaqueSummarySchema.parse(response.json());
    if (task.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task did not reach ${state}.`);
}

describe.sequential("opaque encrypted Task persistence", () => {
  it("creates, updates, executes, and retries without storing Task prose", async () => {
    const chatId = randomUUID();
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: taskContent("draft", 0, null),
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createdResponse.json());
    expect(created.task).toMatchObject({
      chatId,
      state: "draft",
      rowVersion: 1,
    });

    const draftResponse = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${chatId}/draft`,
      payload: {
        rowVersion: 1,
        task: taskContent("draft", 0, null),
        draftAttachmentIds: [],
      },
    });
    expect(draftResponse.statusCode).toBe(200);
    const draft = taskOpaqueSummarySchema.parse(draftResponse.json());

    const start = operation(chatId, draft.rowVersion);
    const startResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: start,
    });
    expect(startResponse.statusCode).toBe(202);
    const reviewed = await waitForState(chatId, "review");
    expect(reviewed).toMatchObject({ planningRound: 1, hasPlan: true });
    expect(observedTurn?.resultMode.kind).toBe("task-encrypted");
    expect(JSON.stringify(observedTurn)).not.toContain(sentinel);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: start,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(taskOpaqueSummarySchema.parse(duplicate.json()).rowVersion).toBe(
      reviewed.rowVersion,
    );

    const stored = {
      task: await database.repository.tasks.get(LOCAL_USER_ID, chatId),
      rounds: await database.repository.tasks.listRounds(LOCAL_USER_ID, chatId),
      messages: await database.repository.listTaskMessages(
        LOCAL_USER_ID,
        chatId,
      ),
    };
    expect(JSON.stringify(stored)).not.toContain(sentinel);
    expect(JSON.stringify(stored)).not.toContain("private Task prose");
    expect(stored.rounds).toHaveLength(1);
    expect(stored.rounds[0]).toMatchObject({ status: "completed" });
    expect(stored.messages).toHaveLength(2);
    expect(
      stored.messages.every((message) => "protectedContent" in message),
    ).toBe(true);
  });

  it("keeps ordinary agent messages on the existing visible API shape", async () => {
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
      () => true,
    );
    if (!chat) throw new Error("Expected an ordinary chat.");
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "user",
      content: [{ type: "text", text: "Visible ordinary chat message" }],
      idempotencyKey: "visible-agent-message",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/chats/${chat.id}/messages`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        chatId: chat.id,
        content: [{ type: "text", text: "Visible ordinary chat message" }],
      },
    ]);
  });

  it("keeps the destructive reset narrowly scoped to Task chats", async () => {
    const migration = await readFile(
      new URL("../drizzle/0103_foamy_wolf_cub.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      `DELETE FROM "chats" WHERE "experience" = 'task'`,
    );
    expect(migration).not.toMatch(
      /DELETE FROM "users"|DELETE FROM "projects"/u,
    );
    expect(migration).not.toContain('brief_markdown" text');
    const messageMigration = await readFile(
      new URL("../drizzle/0104_short_mole_man.sql", import.meta.url),
      "utf8",
    );
    expect(messageMigration).toContain(
      `DELETE FROM "chats" WHERE "experience" = 'task'`,
    );
    expect(messageMigration).toContain("chat_messages_content_shape_check");
    expect(messageMigration).not.toMatch(
      /DELETE FROM "users"|DELETE FROM "projects"/u,
    );
  });
});
