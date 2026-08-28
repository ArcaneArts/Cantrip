import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  taskWorkerCreateSchema,
  taskWireCreateResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  taskDetailSchema,
  taskEncryptedOperationStartSchema,
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskOpaqueSummarySchema,
  type TaskDetail,
  type TaskFailureOperationKind,
  type TaskOpaqueSummary,
  type TaskOperationKind,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedClassification,
  type TaskProtectedContent,
  type TaskQuestionAnswer,
} from "@cantrip/protocol/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executeEncryptedTaskOperation,
  encryptTaskTurnResult,
  openEncryptedTaskGoalObjective,
  prepareEncryptedTaskOperation,
  protectTaskGoalResult,
} from "../../cantrip_worker/src/task-operation.js";
import {
  createTaskOperationRelayRequest,
  decryptTaskGoalObjective,
  decryptTaskProtectedContent,
  deriveComponentKey,
  encryptTaskMessageProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
  encryptTaskProtectedContent,
  generateAccountMasterKey,
  taskOperationRunningClassification,
} from "../../packages/crypto/src/index.js";
import { buildApp } from "../src/app.js";
import { TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS } from "../src/app/shared/constants.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { DEFAULT_MODEL_ID, LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const ownerId = LOCAL_USER_ID;
const workerId = "task-lifecycle-worker";
const threadId = "thread-task-e2ee-lifecycle";
const sentinel = "TASK-E2EE-SENTINEL-closure-audit";
const questionId = "scope-question";
const optionId = "full-scope";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-e2ee-lifecycle-"),
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
  port: 4311,
  workerToken: "test-worker-token",
};

let workerTaskKey = new Uint8Array();
let goalObjective = `${sentinel} goal not initialized`;
let goalCompleted = false;
let continuedPromptSawAnswer = false;
let pauseTestEnabled = false;
let pauseTestTurnStarted = false;
let resumePauseTestTurn: (() => void) | null = null;
let rejectNextAgentTurnPreparation = false;
let holdNextAgentTurnPreparation = false;
let heldAgentTurnPreparationStarted = false;
let releaseHeldAgentTurnPreparation: (() => void) | null = null;
const pauseCommands: boolean[] = [];
const serverObservedPayloads: string[] = [];
const workerErrors: string[] = [];
const taskOperationPrepareTimeouts: Array<number | null | undefined> = [];
const codeAgentPrepareTimeouts: Array<number | null | undefined> = [];

function workerComponentKey() {
  return { key: new Uint8Array(workerTaskKey), keyRevision: 1 };
}

const errorMetadata = (error: {
  code: string;
  occurredAt: string;
  operationKind: TaskFailureOperationKind;
}) => ({
  code: error.code,
  occurredAt: error.occurredAt,
  operationKind: error.operationKind,
});

async function sealTask(chatId: string, content: TaskProtectedContent) {
  return {
    classification: content.classification,
    protectedContent: await encryptTaskProtectedContent({
      ownerId,
      chatId,
      keyRevision: 1,
      componentKey: workerTaskKey,
      content,
    }),
  };
}

async function openTask(task: TaskOpaqueSummary): Promise<TaskDetail> {
  const classification: TaskProtectedClassification = {
    state: task.state,
    stableStateBeforeFailure: task.stableStateBeforeFailure,
    activeOperationKind: task.activeOperationKind,
    planAuthorship: task.planAuthorship,
    planningRound: task.planningRound,
    hasPlan: task.hasPlan,
    hasQuestions: task.hasQuestions,
    hasFinalPlan: task.hasFinalPlan,
    hasGoalPrompt: task.hasGoalPrompt,
    lastError: task.lastError,
  };
  const content = await decryptTaskProtectedContent({
    ownerId,
    chatId: task.chatId,
    keyRevision: 1,
    componentKey: workerTaskKey,
    encrypted: task.protectedContent,
    publicClassification: classification,
  });
  return taskDetailSchema.parse({
    ...task,
    briefMarkdown: content.briefMarkdown,
    planMarkdown: content.planMarkdown,
    currentQuestions: content.currentQuestions,
    currentAnswers: content.currentAnswers,
    additionalDirection: content.additionalDirection,
    finalPlanMarkdown: content.finalPlanMarkdown,
    goalPrompt: content.goalPrompt,
    lastError: content.lastError,
  });
}

function contentFromTask(task: TaskDetail): TaskProtectedContent {
  return {
    version: 1,
    classification: {
      state: task.state,
      stableStateBeforeFailure: task.stableStateBeforeFailure,
      activeOperationKind: task.activeOperationKind,
      planAuthorship: task.planAuthorship,
      planningRound: task.planningRound,
      hasPlan: task.planMarkdown !== null,
      hasQuestions: task.currentQuestions.length > 0,
      hasFinalPlan: task.finalPlanMarkdown !== null,
      hasGoalPrompt: task.goalPrompt !== null,
      lastError: task.lastError ? errorMetadata(task.lastError) : null,
    },
    briefMarkdown: task.briefMarkdown,
    planMarkdown: task.planMarkdown,
    currentQuestions: task.currentQuestions,
    currentAnswers: task.currentAnswers,
    additionalDirection: task.additionalDirection,
    finalPlanMarkdown: task.finalPlanMarkdown,
    goalPrompt: task.goalPrompt,
    lastError: task.lastError,
  };
}

async function prepareOperation(
  task: TaskDetail,
  input: {
    additionalDirection?: string;
    answers?: TaskQuestionAnswer[];
    kind: TaskOperationKind;
    operationId: string;
  },
) {
  const ordinal = task.planningRound + 1;
  const roundClassification = taskOperationRunningClassification({
    kind: input.kind,
    ordinal,
  });
  const taskClassification: TaskProtectedClassification = {
    state: input.kind === "finalize" ? "finalizing" : "planning",
    stableStateBeforeFailure:
      input.kind === "initial-plan" ? "draft" : "review",
    activeOperationKind: input.kind,
    planAuthorship: task.planAuthorship,
    planningRound: ordinal,
    hasPlan: task.planMarkdown !== null,
    hasQuestions: task.currentQuestions.length > 0,
    hasFinalPlan: false,
    hasGoalPrompt: false,
    lastError: null,
  };
  const taskContent: TaskProtectedContent = {
    ...contentFromTask(task),
    classification: taskClassification,
    currentAnswers: input.answers ?? task.currentAnswers,
    additionalDirection: input.additionalDirection ?? task.additionalDirection,
    lastError: null,
  };
  const round: TaskPlanningRoundProtectedContent = {
    version: 1,
    classification: roundClassification,
    inputBriefMarkdown: task.briefMarkdown,
    inputPlanMarkdown: task.planMarkdown,
    inputQuestions: task.currentQuestions,
    inputAnswers: input.answers ?? task.currentAnswers,
    additionalDirection: input.additionalDirection ?? task.additionalDirection,
    outputPlanMarkdown: null,
    outputQuestions: [],
    outputGoalPrompt: null,
    error: null,
  };
  const messageId = randomUUID();
  const messageClassification = {
    role: "user" as const,
    mode: "plan" as const,
    attachmentIds: task.draftAttachmentIds,
  };
  const userMessage = {
    id: messageId,
    classification: messageClassification,
    protectedContent: await encryptTaskMessageProtectedContent({
      ownerId,
      messageId,
      keyRevision: 1,
      componentKey: workerTaskKey,
      content: {
        version: 1,
        classification: messageClassification,
        content: [
          {
            type: "text" as const,
            text: `${sentinel} ${input.kind} request`,
          },
        ],
      },
    }),
    reasoningEffort: null,
    idempotencyKey: `task-operation:${input.operationId}`,
  };
  const operation = await createTaskOperationRelayRequest({
    ownerId,
    chatId: task.chatId,
    operationId: input.operationId,
    keyRevision: 1,
    componentKey: workerTaskKey,
    content: round,
    taskContent,
    userMessage,
  });
  const error = {
    code: "task-operation-failed",
    message: `${sentinel} trusted client failure`,
    operationKind: input.kind,
    occurredAt: new Date().toISOString(),
  };
  const failedClassification: TaskProtectedClassification = {
    ...taskClassification,
    state: "failed",
    activeOperationKind: null,
    lastError: errorMetadata(error),
  };
  const failedTask: TaskProtectedContent = {
    ...taskContent,
    classification: failedClassification,
    lastError: error,
  };
  const failedRoundClassification = {
    ...roundClassification,
    status: "failed" as const,
    error: errorMetadata(error),
  };
  const failedRound: TaskPlanningRoundProtectedContent = {
    ...round,
    classification: failedRoundClassification,
    error,
  };
  return taskEncryptedOperationStartSchema.parse({
    rowVersion: task.rowVersion,
    operation,
    failure: {
      task: await sealTask(task.chatId, failedTask),
      round: {
        classification: failedRoundClassification,
        protectedContent: await encryptTaskPlanningRoundProtectedContent({
          ownerId,
          roundId: input.operationId,
          keyRevision: 1,
          componentKey: workerTaskKey,
          content: failedRound,
        }),
      },
    },
  });
}

async function encryptedTaskTurn(
  command: Extract<WorkerCommand, { type: "chat.turn" }>,
) {
  serverObservedPayloads.push(JSON.stringify(command));
  if (command.resultMode.kind === "task-encrypted") {
    return executeEncryptedTaskOperation({
      getComponentKey: workerComponentKey,
      ownerId,
      request: command.resultMode.operation,
      async run({ prompt }) {
        expect(prompt).toContain(sentinel);
        const kind = command.resultMode.operation.classification.kind;
        if (kind === "direct" && pauseTestEnabled) {
          pauseTestTurnStarted = true;
          await new Promise<void>((resolve) => {
            resumePauseTestTurn = resolve;
          });
        }
        if (kind === "continue-plan") {
          continuedPromptSawAnswer =
            prompt.includes("complete all milestones") &&
            prompt.includes("preserve the security boundary");
        }
        const structuredResult =
          kind === "initial-plan"
            ? {
                planMarkdown: `# ${sentinel} initial plan`,
                questions: [
                  {
                    id: questionId,
                    header: `${sentinel} scope`,
                    question: `${sentinel}: implement the complete scope?`,
                    options: [
                      {
                        id: optionId,
                        label: `${sentinel} complete`,
                        description: `${sentinel} complete description`,
                      },
                    ],
                    recommendedOptionId: optionId,
                    allowFreeform: true,
                    required: true,
                  },
                ],
              }
            : kind === "continue-plan"
              ? {
                  planMarkdown: `# ${sentinel} continued plan`,
                  questions: [],
                }
              : {
                  finalPlanMarkdown: `# ${sentinel} final plan`,
                  goalPrompt: `${sentinel} implementation direction`,
                };
        return {
          threadId,
          turnId: `turn-${kind}`,
          text: `${sentinel} raw worker output`,
          structuredResult,
          status: "completed" as const,
        };
      },
    });
  }
  if (command.resultMode.kind === "task-message-encrypted") {
    const result = await encryptTaskTurnResult({
      getComponentKey: workerComponentKey,
      idempotencyKey: command.resultMode.idempotencyKey,
      messageId: command.resultMode.messageId,
      ownerId,
      result: {
        threadId,
        turnId: "turn-goal-implementation",
        text: `${sentinel} implementation complete`,
        status: "completed",
      },
    });
    goalCompleted = true;
    return result;
  }
  throw new Error("The Task lifecycle used a visible worker turn.");
}

const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(candidate) {
    return candidate === workerId;
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
      codeAgentPrepareTimeouts.push(options?.timeoutMs);
      if (holdNextAgentTurnPreparation) {
        holdNextAgentTurnPreparation = false;
        heldAgentTurnPreparationStarted = true;
        await new Promise<void>((resolve) => {
          releaseHeldAgentTurnPreparation = resolve;
        });
      }
      if (rejectNextAgentTurnPreparation) {
        rejectNextAgentTurnPreparation = false;
        return {
          prepared: false,
          sessions: [
            {
              sessionId: "blocked-code-session",
              bridgeConnected: false,
              allowed: false,
              policy: null,
              dirtyEditors: [
                {
                  uri: "file:///repository/src/unsaved.ts",
                  relativePath: "src/unsaved.ts",
                },
              ],
              saved: [],
              failed: [],
              reason:
                "Cantrip Code has unsaved editors, but its workbench bridge is not connected.",
            },
          ],
        };
      }
      return { prepared: true, sessions: [] };
    }
    if (command.type === "task.operation.prepare") {
      taskOperationPrepareTimeouts.push(options?.timeoutMs);
      try {
        return await prepareEncryptedTaskOperation({
          getComponentKey: workerComponentKey,
          ownerId,
          request: {
            operationId: command.operationId,
            operationKind: command.operationKind,
            task: command.task,
          },
        });
      } catch (error) {
        workerErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
    if (command.type === "chat.turn") {
      try {
        return await encryptedTaskTurn(command);
      } catch (error) {
        workerErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
    if (command.type === "chat.goal.create") {
      try {
        if (typeof command.objective === "string" || !command.taskContext) {
          throw new Error("The Task Goal crossed the server in plaintext.");
        }
        serverObservedPayloads.push(JSON.stringify(command));
        goalObjective = await openEncryptedTaskGoalObjective({
          chatId: command.chatId,
          getComponentKey: workerComponentKey,
          goal: command.objective,
          ownerId,
          threadId: command.threadId,
        });
        expect(goalObjective).toContain(sentinel);
        return await protectTaskGoalResult({
          chatId: command.chatId,
          context: command.taskContext,
          getComponentKey: workerComponentKey,
          ownerId,
          rawResult: {
            goal: {
              threadId,
              objective: goalObjective,
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        });
      } catch (error) {
        workerErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
    if (command.type === "chat.goal.get") {
      if (!command.taskContext) {
        throw new Error("Expected an encrypted Task Goal context.");
      }
      serverObservedPayloads.push(JSON.stringify(command));
      return protectTaskGoalResult({
        chatId: command.chatId,
        context: command.taskContext,
        getComponentKey: workerComponentKey,
        ownerId,
        rawResult: {
          goal: {
            threadId,
            objective: goalObjective,
            status: goalCompleted ? "complete" : "active",
            tokenBudget: null,
            tokensUsed: 3,
            timeUsedSeconds: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      });
    }
    if (command.type === "chat.pause.set") {
      pauseCommands.push(command.paused);
      if (!command.paused) resumePauseTestTurn?.();
      return {
        paused: command.paused,
        active: pauseTestTurnStarted
          ? { threadId, turnId: "turn-direct" }
          : null,
      };
    }
    const error = `Unexpected Task lifecycle command ${command.type}.`;
    workerErrors.push(error);
    throw new Error(error);
  },
};

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let database: DatabaseConnection;
let projectId: string;

async function taskSummary(chatId: string): Promise<TaskOpaqueSummary> {
  const response = await app!.inject({
    method: "GET",
    url: `/api/tasks/${chatId}`,
  });
  expect(response.statusCode).toBe(200);
  return taskOpaqueSummarySchema.parse(response.json());
}

async function waitForTask(
  chatId: string,
  state: TaskOpaqueSummary["state"],
): Promise<TaskOpaqueSummary> {
  let latest: TaskOpaqueSummary | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await taskSummary(chatId);
    latest = task;
    if (task.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const messages = await database.repository.listTaskMessages(ownerId, chatId);
  const context = await database.repository.getChatExecutionContext(
    ownerId,
    chatId,
  );
  throw new Error(
    `Task did not reach ${state}; latest state was ${latest?.state ?? "missing"} (${JSON.stringify(latest?.lastError ?? null)}); dispatch=${JSON.stringify(latest?.dispatch ?? null)}; chat=${context?.status}; messages=${messages.map(({ idempotencyKey }) => idempotencyKey).join(",")}; worker payloads: ${serverObservedPayloads.length}; worker errors: ${workerErrors.join(" | ") || "none"}.`,
  );
}

async function waitForTaskCycle(
  chatId: string,
  operationId: string,
  state: TaskOpaqueSummary["state"],
): Promise<TaskOpaqueSummary> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await taskSummary(chatId);
    if (
      task.state === state &&
      task.dispatch?.operationId === operationId &&
      task.dispatch.state === "succeeded"
    ) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task cycle ${operationId} did not complete in ${state}.`);
}

async function waitForDispatchState(
  chatId: string,
  state: NonNullable<TaskOpaqueSummary["dispatch"]>["state"],
): Promise<TaskOpaqueSummary> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await taskSummary(chatId);
    if (task.dispatch?.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task dispatch did not reach ${state}.`);
}

beforeAll(async () => {
  workerTaskKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "task-content",
    keyRevision: 1,
  });
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    ownerId,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(ownerId, {
    workerId,
    name: "Task Lifecycle Worker",
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
    ownerId,
    taskWorkerCreateSchema.parse({
      name: "Task lifecycle",
      modelConfiguration: { modelId: DEFAULT_MODEL_ID },
      allowsPlanGoal: true,
      continuityFamilyOverride: "ollama",
    }),
  );
  const project = await database.repository.createGithubProject(ownerId, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "B".repeat(43),
    repositoryId: "task-e2ee-lifecycle",
    nameWithOwner: "ArcaneArts/TaskE2EELifecycle",
    url: "https://github.com/ArcaneArts/TaskE2EELifecycle",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    ownerId,
    projectId,
    workerId,
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/TaskE2EELifecycle",
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
  workerTaskKey.fill(0);
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("Task E2EE closure lifecycle", () => {
  it("dispatches the agent turn without waiting on a redundant launch heartbeat", async () => {
    const chatId = randomUUID();
    const initialTask = await sealTask(chatId, {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel} launch fence test`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    });
    const createdResponse = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        planGoalEnabled: false,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: initialTask,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createdResponse.json());

    const dispatch = database.repository.taskDispatch;
    const originalHeartbeat = dispatch.heartbeat.bind(dispatch);
    let heartbeatBlocked = false;
    let releaseHeartbeat: (() => void) | null = null;
    const heldHeartbeat = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    dispatch.heartbeat = async (lease, options) => {
      if (!heartbeatBlocked) {
        heartbeatBlocked = true;
        await heldHeartbeat;
      }
      return originalHeartbeat(lease, options);
    };

    try {
      const started = await app!.inject({
        method: "POST",
        url: `/api/tasks/${chatId}/start`,
        payload: {
          operationId: randomUUID(),
          rowVersion: created.task.rowVersion,
        },
      });
      expect(started.statusCode).toBe(202);

      let workerReceivedTurn = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        workerReceivedTurn = serverObservedPayloads.some((payload) =>
          payload.includes(chatId),
        );
        if (workerReceivedTurn) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(workerReceivedTurn).toBe(true);
      for (let attempt = 0; attempt < 200 && !heartbeatBlocked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(heartbeatBlocked).toBe(true);
      expect((await taskSummary(chatId)).dispatch?.state).toBe("running");

      releaseHeartbeat?.();
      await waitForTask(chatId, "complete");
    } finally {
      releaseHeartbeat?.();
      dispatch.heartbeat = originalHeartbeat;
    }
  });

  it("fails a blocked launch without retaining Task Worker capacity", async () => {
    taskOperationPrepareTimeouts.length = 0;
    codeAgentPrepareTimeouts.length = 0;
    rejectNextAgentTurnPreparation = true;
    const blockedChatId = randomUUID();
    const blockedTask = await sealTask(blockedChatId, {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel} blocked launch`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    });
    const blockedCreate = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId: blockedChatId,
        planGoalEnabled: false,
        titleProtection: protectedChatFields(blockedChatId).titleProtection,
        task: blockedTask,
      },
    });
    expect(blockedCreate.statusCode).toBe(201);
    const blocked = taskWireCreateResultSchema.parse(blockedCreate.json());
    const blockedStart = await app!.inject({
      method: "POST",
      url: `/api/tasks/${blockedChatId}/start`,
      payload: {
        operationId: randomUUID(),
        rowVersion: blocked.task.rowVersion,
      },
    });
    expect(blockedStart.statusCode).toBe(202);
    const failed = await waitForTask(blockedChatId, "failed");
    expect(failed.dispatch?.state).toBe("failed");

    const followingChatId = randomUUID();
    const followingTask = await sealTask(followingChatId, {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel} following launch`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    });
    const followingCreate = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId: followingChatId,
        planGoalEnabled: false,
        titleProtection: protectedChatFields(followingChatId).titleProtection,
        task: followingTask,
      },
    });
    expect(followingCreate.statusCode).toBe(201);
    const following = taskWireCreateResultSchema.parse(followingCreate.json());
    const followingStart = await app!.inject({
      method: "POST",
      url: `/api/tasks/${followingChatId}/start`,
      payload: {
        operationId: randomUUID(),
        rowVersion: following.task.rowVersion,
      },
    });
    expect(followingStart.statusCode).toBe(202);
    const completed = await waitForTask(followingChatId, "complete");
    expect(completed.dispatch?.state).toBe("succeeded");
    expect(taskOperationPrepareTimeouts).toEqual([
      TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
      TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
    ]);
    expect(codeAgentPrepareTimeouts).toEqual([
      TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
      TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
    ]);
  });

  it("pauses a claimed Task while launch preflight has no runtime", async () => {
    holdNextAgentTurnPreparation = true;
    heldAgentTurnPreparationStarted = false;
    releaseHeldAgentTurnPreparation = null;
    pauseCommands.length = 0;
    const chatId = randomUUID();
    const initialTask = await sealTask(chatId, {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel} claimed pause test`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    });
    const createdResponse = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        planGoalEnabled: false,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: initialTask,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createdResponse.json());
    const queued = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/start`,
      payload: {
        operationId: randomUUID(),
        rowVersion: created.task.rowVersion,
      },
    });
    expect(queued.statusCode).toBe(202);
    for (
      let attempt = 0;
      attempt < 200 && !heldAgentTurnPreparationStarted;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(heldAgentTurnPreparationStarted).toBe(true);

    const initialPause = await app!.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tasks/pause`,
    });
    const pausedResponse = await app!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tasks/pause`,
      payload: { paused: true, rowVersion: initialPause.json().rowVersion },
    });
    expect(pausedResponse.statusCode).toBe(200);
    expect((await waitForDispatchState(chatId, "paused")).dispatch?.state).toBe(
      "paused",
    );
    expect(pauseCommands).toEqual([]);
    releaseHeldAgentTurnPreparation?.();
    const resumeResponse = await app!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tasks/pause`,
      payload: {
        paused: false,
        rowVersion: pausedResponse.json().rowVersion,
      },
    });
    expect(resumeResponse.statusCode).toBe(202);
    expect((await waitForTask(chatId, "complete")).dispatch?.state).toBe(
      "succeeded",
    );
    expect(pauseCommands).toEqual([false]);
  });

  it("pauses a Project Task turn and resumes its exact resident runtime", async () => {
    pauseTestEnabled = true;
    pauseTestTurnStarted = false;
    resumePauseTestTurn = null;
    pauseCommands.length = 0;
    const chatId = randomUUID();
    const initialTask = await sealTask(chatId, {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel} direct pause test`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    });
    const createdResponse = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: {
        chatId,
        planGoalEnabled: false,
        titleProtection: protectedChatFields(chatId).titleProtection,
        task: initialTask,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createdResponse.json());
    const queued = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/start`,
      payload: {
        operationId: randomUUID(),
        rowVersion: taskOpaqueSummarySchema.parse(created.task).rowVersion,
      },
    });
    expect(queued.statusCode).toBe(202);
    for (
      let attempt = 0;
      attempt < 200 && !pauseTestTurnStarted;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pauseTestTurnStarted).toBe(true);

    const initialPause = await app!.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tasks/pause`,
    });
    expect(initialPause.statusCode).toBe(200);
    const pauseResponse = await app!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tasks/pause`,
      payload: { paused: true, rowVersion: initialPause.json().rowVersion },
    });
    expect(pauseResponse.statusCode).toBe(200);
    const paused = await waitForDispatchState(chatId, "paused");
    expect(paused.dispatch).toMatchObject({
      codexThreadId: threadId,
      turnId: "turn-direct",
    });
    expect(
      (await database.repository.taskScheduling.listTaskWorkers(ownerId))[0]
        ?.activeTaskCount,
    ).toBe(0);

    const resumeResponse = await app!.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tasks/pause`,
      payload: {
        paused: false,
        rowVersion: pauseResponse.json().rowVersion,
      },
    });
    expect(resumeResponse.statusCode).toBe(202);
    const completed = await waitForTask(chatId, "complete");
    expect(completed.dispatch).toMatchObject({ state: "succeeded" });
    expect(pauseCommands).toEqual([true, false]);
    pauseTestEnabled = false;
  });

  it("completes planning and a Goal with zero Task prose in the temporary database", async () => {
    const chatId = randomUUID();
    const initialContent: TaskProtectedContent = {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: "",
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    };
    const initialTask = await sealTask(chatId, initialContent);
    const createPayload = {
      chatId,
      planGoalEnabled: true,
      titleProtection: protectedChatFields(chatId).titleProtection,
      task: initialTask,
    };
    expect(JSON.stringify(createPayload)).not.toContain(sentinel);
    const createResponse = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: createPayload,
    });
    expect(createResponse.statusCode).toBe(201);
    const created = taskWireCreateResultSchema.parse(createResponse.json());
    let task = await openTask(taskOpaqueSummarySchema.parse(created.task));

    const draftMutation = {
      rowVersion: task.rowVersion,
      task: await sealTask(chatId, {
        ...contentFromTask(task),
        briefMarkdown: `${sentinel} private brief`,
      }),
      draftAttachmentIds: [],
    };
    expect(JSON.stringify(draftMutation)).not.toContain(sentinel);
    const draftResponse = await app!.inject({
      method: "PATCH",
      url: `/api/tasks/${chatId}/draft`,
      payload: draftMutation,
    });
    expect(draftResponse.statusCode).toBe(200);
    task = await openTask(taskOpaqueSummarySchema.parse(draftResponse.json()));

    const staleDraft = await app!.inject({
      method: "PATCH",
      url: `/api/tasks/${chatId}/draft`,
      payload: draftMutation,
    });
    expect(staleDraft.statusCode).toBe(409);

    const initialOperation = await prepareOperation(task, {
      kind: "initial-plan",
      operationId: randomUUID(),
    });
    expect(JSON.stringify(initialOperation)).not.toContain(sentinel);
    const initialResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: {
        operationId: initialOperation.operation.operationId,
        rowVersion: initialOperation.rowVersion,
      },
    });
    expect(initialResponse.statusCode).toBe(202);
    task = await openTask(
      await waitForTaskCycle(
        chatId,
        initialOperation.operation.operationId,
        "review",
      ),
    );
    expect(task.planMarkdown).toContain(`${sentinel} initial plan`);
    expect(task.currentQuestions[0]?.question).toContain(sentinel);

    const replayResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: {
        operationId: initialOperation.operation.operationId,
        rowVersion: initialOperation.rowVersion,
      },
    });
    expect(replayResponse.statusCode).toBe(202);

    const reviewedContent = contentFromTask({
      ...task,
      currentAnswers: [
        {
          questionId,
          optionId,
          freeform: `${sentinel} complete all milestones`,
        },
      ],
      additionalDirection: `${sentinel} preserve the security boundary`,
    });
    const reviewResponse = await app!.inject({
      method: "PATCH",
      url: `/api/tasks/${chatId}/plan`,
      payload: {
        rowVersion: task.rowVersion,
        task: await sealTask(chatId, reviewedContent),
      },
    });
    expect(reviewResponse.statusCode).toBe(200);
    task = await openTask(taskOpaqueSummarySchema.parse(reviewResponse.json()));
    const continuedOperationId = randomUUID();
    const continuedResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/continue`,
      payload: {
        operationId: continuedOperationId,
        rowVersion: task.rowVersion,
      },
    });
    expect(continuedResponse.statusCode).toBe(202);
    task = await openTask(
      await waitForTaskCycle(chatId, continuedOperationId, "review"),
    );
    expect(task.planMarkdown).toContain(`${sentinel} continued plan`);
    expect(continuedPromptSawAnswer).toBe(true);
    expect(task.currentQuestions).toEqual([]);

    const finalOperationId = randomUUID();
    const finalResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/begin-implementation`,
      payload: {
        operationId: finalOperationId,
        rowVersion: task.rowVersion,
      },
    });
    expect(finalResponse.statusCode).toBe(202);
    task = await openTask(await waitForTask(chatId, "implementing"));
    expect(task.finalPlanMarkdown).toContain(`${sentinel} final plan`);
    expect(task.goalPrompt).toContain(sentinel);

    for (let attempt = 0; attempt < 200 && !goalCompleted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(goalCompleted).toBe(true);
    const completedTask = await waitForTask(chatId, "complete");
    expect(completedTask.dispatch).toMatchObject({
      operationId: finalOperationId,
      operationKind: "finalize",
      state: "succeeded",
    });
    expect(completedTask.completedAt).not.toBeNull();
    const goalResponse = await app!.inject({
      method: "GET",
      url: `/api/chats/${chatId}/goal`,
    });
    expect(goalResponse.statusCode).toBe(200);
    const goalWire = goalResponse.json() as {
      kind: string;
      goal: unknown;
    };
    expect(goalWire.kind).toBe("task-encrypted");
    const goal = taskGoalObjectiveOpaqueSnapshotSchema.parse(goalWire.goal);
    const openedGoal = await decryptTaskGoalObjective({
      ownerId,
      chatId,
      threadId: goal.threadId,
      keyRevision: 1,
      componentKey: workerTaskKey,
      encrypted: goal.protectedObjective,
      publicClassification: {
        chatId,
        threadId: goal.threadId,
        status: goal.status,
      },
    });
    expect(openedGoal.objective).toContain(`${sentinel} final plan`);
    task = await openTask(await waitForTask(chatId, "complete"));
    expect(task.state).toBe("complete");

    const blockedMessage = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: {
        role: "user",
        content: [{ type: "text", text: `${sentinel} plaintext message` }],
      },
    });
    expect(blockedMessage.statusCode).toBe(400);
    const blockedQueue = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/queue`,
      payload: {
        text: `${sentinel} plaintext queue`,
        mode: "default",
        attachmentIds: [],
        frozen: false,
        idempotencyKey: randomUUID(),
      },
    });
    expect(blockedQueue.statusCode).toBe(400);
    const blockedAutomation = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/automations`,
      payload: {
        chatId,
        name: "Blocked Task automation",
        prompt: `${sentinel} plaintext automation`,
        schedule: {
          kind: "interval",
          every: 1,
          unit: "hour",
          startsAt: new Date().toISOString(),
        },
        condition: null,
        enabled: false,
      },
    });
    expect(blockedAutomation.statusCode).toBe(400);

    const stored = {
      task: await database.repository.tasks.get(ownerId, chatId),
      rounds: await database.repository.tasks.listRounds(ownerId, chatId),
      messages: await database.repository.listTaskMessages(ownerId, chatId),
      queued: await database.repository.listQueuedPrompts(ownerId, chatId),
      automations: await database.repository.projectAutomations.list(
        ownerId,
        projectId,
      ),
    };
    expect(stored.rounds).toHaveLength(3);
    expect(stored.messages.length).toBeGreaterThanOrEqual(8);
    expect(stored.queued).toEqual([]);
    expect(stored.automations).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain(sentinel);
    expect(serverObservedPayloads.join("\n")).not.toContain(sentinel);

    await app!.close();
    app = null;
    const scan = new PGlite(path.join(dataDirectory, "server-db"));
    try {
      const tableQueries = [
        [
          `tasks`,
          `SELECT row_to_json(row)::text AS record FROM tasks row WHERE chat_id = $1`,
        ],
        [
          `task_planning_rounds`,
          `SELECT row_to_json(row)::text AS record FROM task_planning_rounds row WHERE chat_id = $1`,
        ],
        [
          `chat_messages`,
          `SELECT row_to_json(row)::text AS record FROM chat_messages row WHERE chat_id = $1`,
        ],
        [
          `chat_relocation_jobs`,
          `SELECT row_to_json(row)::text AS record FROM chat_relocation_jobs row WHERE chat_id = $1`,
        ],
        [
          `chat_relocation_snapshots`,
          `SELECT row_to_json(row)::text AS record FROM chat_relocation_snapshots row WHERE chat_id = $1`,
        ],
        [
          `queued_prompts`,
          `SELECT row_to_json(row)::text AS record FROM queued_prompts row WHERE chat_id = $1`,
        ],
        [
          `project_automations`,
          `SELECT row_to_json(row)::text AS record FROM project_automations row WHERE chat_id = $1`,
        ],
        [
          `audit_events`,
          `SELECT row_to_json(row)::text AS record FROM audit_events row`,
        ],
      ] as const;
      for (const [table, query] of tableQueries) {
        const result = await scan.query<{ record: string }>(
          query,
          table === "audit_events" ? [] : [chatId],
        );
        expect(JSON.stringify(result.rows), table).not.toContain(sentinel);
      }
    } finally {
      await scan.close();
    }
  });
});
