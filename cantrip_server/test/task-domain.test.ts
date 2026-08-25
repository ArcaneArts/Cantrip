import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  taskWorkerCreateSchema,
  projectTaskWorkloadOpaqueSchema,
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
import { DEFAULT_MODEL_ID, LOCAL_USER_ID } from "../src/db/repository.js";
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
  state:
    "draft" | "planning" | "review" | "implementing" | "complete" | "failed",
  planningRound: number,
  operationKind: "direct" | "initial-plan" | null,
): TaskOpaqueContent {
  return {
    classification: {
      state,
      stableStateBeforeFailure:
        state === "planning" || state === "implementing" || state === "failed"
          ? "draft"
          : null,
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
              operationKind: operationKind ?? "initial-plan",
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
  mode: "default" | "plan" = "plan",
) {
  return {
    id,
    classification: { role, mode, attachmentIds: [] },
    protectedContent: encrypted,
    reasoningEffort: null,
    idempotencyKey,
  };
}

function operation(
  chatId: string,
  rowVersion: number,
  kind: "direct" | "initial-plan" = "initial-plan",
  operationId = randomUUID(),
) {
  const request: TaskOperationRelayRequest = {
    chatId,
    operationId,
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    classification: {
      ordinal: 1,
      kind,
      status: "running",
      hasOutputPlan: false,
      hasOutputQuestions: false,
      hasOutputGoalPrompt: false,
      error: null,
    },
    protectedInput: encrypted,
    task: taskContent(kind === "direct" ? "implementing" : "planning", 1, kind),
    userMessage: taskMessage(
      "user",
      randomUUID(),
      `task-operation:${operationId}`,
      kind === "direct" ? "default" : "plan",
    ),
  };
  const error = {
    code: "task-operation-failed",
    operationKind: kind,
    occurredAt: "2026-08-19T12:00:00.000Z",
  };
  return taskEncryptedOperationStartSchema.parse({
    rowVersion,
    operation: request,
    failure: {
      task: {
        ...taskContent("failed", 1, kind),
        classification: {
          ...taskContent("failed", 1, kind).classification,
          activeOperationKind: null,
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
let preparedAgentTurns = 0;
const observedWorkerCommandTypes: string[] = [];
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
    observedWorkerCommandTypes.push(command.type);
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
    if (command.type === "code.prepareAgentTurn") {
      preparedAgentTurns += 1;
      return { prepared: true, sessions: [] };
    }
    if (command.type === "task.operation.prepare") {
      return operation(
        command.task.chatId,
        command.task.rowVersion,
        command.operationKind,
        command.operationId,
      );
    }
    if (command.type === "chat.turn") {
      observedTurn = command;
      if (command.resultMode.kind !== "task-encrypted") {
        throw new Error("Expected the encrypted Task relay.");
      }
      const request = command.resultMode.operation;
      const direct = request.classification.kind === "direct";
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
            hasOutputPlan: !direct,
          },
          protectedResult: encrypted,
          task: taskContent(direct ? "complete" : "review", 1, null),
          assistantMessage: taskMessage(
            "assistant",
            randomUUID(),
            `task-result:${request.operationId}`,
            direct ? "default" : "plan",
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
    codexVersion: "0.149.0",
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: { create: true, convertToGithub: true, remove: true },
    encryption: {
      supported: true,
      state: "ready",
      principalId: randomUUID(),
      grants: [{ component: "task-content", keyRevision: 1 }],
      lastSyncedAt: new Date().toISOString(),
      error: null,
    },
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.taskScheduling.createTaskWorker(
    LOCAL_USER_ID,
    taskWorkerCreateSchema.parse({
      name: "Task tests",
      modelConfiguration: { modelId: DEFAULT_MODEL_ID },
      allowsPlanGoal: true,
      continuityFamilyOverride: "ollama",
    }),
  );
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "task-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "A".repeat(43),
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
  it("deletes only unqueued Task drafts", async () => {
    const draftChatId = randomUUID();
    const createdDraftResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId: draftChatId,
        titleProtection: protectedChatFields(draftChatId).titleProtection,
        task: taskContent("draft", 0, null),
      },
    });
    expect(createdDraftResponse.statusCode).toBe(201);

    const deletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${draftChatId}`,
    });
    expect(deletedResponse.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/tasks/${draftChatId}`,
        })
      ).statusCode,
    ).toBe(404);

    const pauseState =
      await database.repository.taskScheduling.getProjectTaskPauseState(
        LOCAL_USER_ID,
        projectId,
      );
    if (!pauseState) throw new Error("Expected a Project Task pause state.");
    const paused =
      await database.repository.taskScheduling.setProjectTaskPauseState(
        LOCAL_USER_ID,
        projectId,
        { paused: true, rowVersion: pauseState.rowVersion },
      );
    if (!paused) throw new Error("Expected the Project Tasks to pause.");

    const queuedChatId = randomUUID();
    try {
      const createdQueuedResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/tasks`,
        payload: {
          chatId: queuedChatId,
          titleProtection: protectedChatFields(queuedChatId).titleProtection,
          task: taskContent("draft", 0, null),
        },
      });
      const queuedTask = taskWireCreateResultSchema.parse(
        createdQueuedResponse.json(),
      ).task;
      await database.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        queuedChatId,
        randomUUID(),
        "direct",
        queuedTask.rowVersion,
      );

      const rejectedResponse = await app.inject({
        method: "DELETE",
        url: `/api/tasks/${queuedChatId}`,
      });
      expect(rejectedResponse.statusCode).toBe(409);
      expect(rejectedResponse.json()).toMatchObject({
        code: "operation-active",
        error: "Only an unqueued Task draft can be deleted.",
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/tasks/${queuedChatId}`,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await database.repository.deleteChat(LOCAL_USER_ID, queuedChatId);
      await database.repository.taskScheduling.setProjectTaskPauseState(
        LOCAL_USER_ID,
        projectId,
        { paused: false, rowVersion: paused.rowVersion },
      );
    }
  });

  it("creates, updates, executes, and retries without storing Task prose", async () => {
    const chatId = randomUUID();
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        planGoalEnabled: true,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: taskContent("draft", 0, null),
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createdResponse.json());
    expect(created.task).toMatchObject({
      chatId,
      planGoalEnabled: true,
      state: "draft",
      rowVersion: 1,
    });
    const tabLayout = await database.repository.tabLayouts.get(
      LOCAL_USER_ID,
      projectId,
    );
    expect(
      tabLayout?.groups.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).not.toContain(`chat:${chatId}`);

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
      payload: {
        operationId: start.operation.operationId,
        rowVersion: start.rowVersion,
      },
    });
    expect(startResponse.statusCode, JSON.stringify(startResponse.json())).toBe(
      202,
    );
    const reviewed = await waitForState(chatId, "review");
    expect(reviewed).toMatchObject({ planningRound: 1, hasPlan: true });
    expect(observedTurn?.resultMode.kind).toBe("task-encrypted");
    expect(preparedAgentTurns).toBe(0);
    expect(JSON.stringify(observedTurn)).not.toContain(sentinel);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: {
        operationId: start.operation.operationId,
        rowVersion: start.rowVersion,
      },
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

    const workloadResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tasks/workload`,
    });
    expect(workloadResponse.statusCode).toBe(200);
    const workload = projectTaskWorkloadOpaqueSchema.parse(
      workloadResponse.json(),
    );
    const workloadItem = workload.items.find(
      (item) => item.task.chatId === chatId,
    );
    expect(workloadItem?.messages).toHaveLength(2);
    expect(workloadItem?.plan.chatId).toBe(chatId);
    expect(JSON.stringify(workload)).not.toContain(sentinel);
  });

  it("defaults new Tasks to one direct non-Goal turn", async () => {
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
    expect(created.task.planGoalEnabled).toBe(false);

    const start = operation(chatId, created.task.rowVersion, "direct");
    const startResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/start`,
      payload: {
        operationId: start.operation.operationId,
        rowVersion: start.rowVersion,
      },
    });
    expect(startResponse.statusCode, JSON.stringify(startResponse.json())).toBe(
      202,
    );
    expect(preparedAgentTurns).toBe(1);
    const completed = await waitForState(chatId, "complete");
    expect(completed).toMatchObject({
      planGoalEnabled: false,
      planningRound: 1,
      hasPlan: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
    });
    expect(completed.implementationStartedAt).not.toBeNull();
    expect(observedTurn?.resultMode).toMatchObject({
      kind: "task-encrypted",
      operation: { classification: { kind: "direct" } },
    });
    expect(observedWorkerCommandTypes).not.toContain("chat.goal.create");

    const storedRounds = await database.repository.tasks.listRounds(
      LOCAL_USER_ID,
      chatId,
    );
    const storedMessages = await database.repository.listTaskMessages(
      LOCAL_USER_ID,
      chatId,
    );
    expect(storedRounds).toMatchObject([
      { kind: "direct", status: "completed" },
    ]);
    expect(storedMessages.map((message) => message.mode)).toEqual([
      "default",
      "default",
    ]);
  });

  it("requeues a failed operation without bypassing a paused scheduler", async () => {
    const pauseState =
      await database.repository.taskScheduling.getProjectTaskPauseState(
        LOCAL_USER_ID,
        projectId,
      );
    if (!pauseState) throw new Error("Expected a Project Task pause state.");
    const paused =
      await database.repository.taskScheduling.setProjectTaskPauseState(
        LOCAL_USER_ID,
        projectId,
        { paused: true, rowVersion: pauseState.rowVersion },
      );
    if (!paused) throw new Error("Expected the Project Tasks to pause.");

    const chatId = randomUUID();
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        planGoalEnabled: true,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: taskContent("draft", 0, null),
      },
    });
    const created = taskWireCreateResultSchema.parse(createdResponse.json());
    const failedOperation = operation(chatId, created.task.rowVersion);
    await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      chatId,
      failedOperation,
    );
    const failedContext = await database.repository.tasks.failOperation(
      LOCAL_USER_ID,
      chatId,
      failedOperation.operation.operationId,
    );
    if (!failedContext) throw new Error("Expected a failed Task operation.");
    const commandsBeforeRetry = observedWorkerCommandTypes.length;
    const retryOperationId = randomUUID();

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/retry`,
      payload: {
        operationId: retryOperationId,
        rowVersion: failedContext.task.rowVersion,
      },
    });
    expect(retryResponse.statusCode, JSON.stringify(retryResponse.json())).toBe(
      202,
    );
    const dispatch = (
      await database.repository.taskDispatch.list(LOCAL_USER_ID)
    ).find((cycle) => cycle.operationId === retryOperationId);
    expect(dispatch).toMatchObject({
      chatId,
      operationKind: "initial-plan",
      state: "queued",
    });
    expect(observedWorkerCommandTypes).toHaveLength(commandsBeforeRetry);

    await database.repository.taskScheduling.setProjectTaskPauseState(
      LOCAL_USER_ID,
      projectId,
      { paused: false, rowVersion: paused.rowVersion },
    );
  });

  it("keeps ordinary agent messages on the encrypted API shape", async () => {
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
    expect(response.json()).toEqual({ kind: "chat-encrypted", messages: [] });
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
