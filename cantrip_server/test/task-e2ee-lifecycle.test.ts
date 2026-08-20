import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  taskCreateResultSchema,
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
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

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
const serverObservedPayloads: string[] = [];
const workerErrors: string[] = [];

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
    if (command.type === "code.prepareAgentTurn") {
      return { prepared: true, sessions: [] };
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
    `Task did not reach ${state}; latest state was ${latest?.state ?? "missing"} (${JSON.stringify(latest?.lastError ?? null)}); chat=${context?.status}; messages=${messages.map(({ idempotencyKey }) => idempotencyKey).join(",")}; worker payloads: ${serverObservedPayloads.length}; worker errors: ${workerErrors.join(" | ") || "none"}.`,
  );
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
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: { create: true, convertToGithub: true, remove: true },
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(ownerId, {
    workerId,
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
      title: "Encrypted lifecycle Task",
      task: initialTask,
    };
    expect(JSON.stringify(createPayload)).not.toContain(sentinel);
    const createResponse = await app!.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: createPayload,
    });
    expect(createResponse.statusCode).toBe(201);
    const created = taskCreateResultSchema.parse(createResponse.json());
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
      payload: initialOperation,
    });
    expect(initialResponse.statusCode).toBe(202);
    task = await openTask(await waitForTask(chatId, "review"));
    expect(task.planMarkdown).toContain(`${sentinel} initial plan`);
    expect(task.currentQuestions[0]?.question).toContain(sentinel);

    const replayResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/plan`,
      payload: initialOperation,
    });
    expect(replayResponse.statusCode).toBe(202);

    const continuedOperation = await prepareOperation(task, {
      answers: [
        {
          questionId,
          optionId,
          freeform: `${sentinel} complete all milestones`,
        },
      ],
      additionalDirection: `${sentinel} preserve the security boundary`,
      kind: "continue-plan",
      operationId: randomUUID(),
    });
    expect(JSON.stringify(continuedOperation)).not.toContain(sentinel);
    const continuedResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/continue`,
      payload: continuedOperation,
    });
    expect(continuedResponse.statusCode).toBe(202);
    task = await openTask(await waitForTask(chatId, "review"));
    expect(task.planMarkdown).toContain(`${sentinel} continued plan`);
    expect(continuedPromptSawAnswer).toBe(true);
    expect(task.currentQuestions).toEqual([]);

    const finalOperation = await prepareOperation(task, {
      kind: "finalize",
      operationId: randomUUID(),
    });
    expect(JSON.stringify(finalOperation)).not.toContain(sentinel);
    const finalResponse = await app!.inject({
      method: "POST",
      url: `/api/tasks/${chatId}/begin-implementation`,
      payload: finalOperation,
    });
    expect(finalResponse.statusCode).toBe(202);
    task = await openTask(await waitForTask(chatId, "implementing"));
    expect(task.finalPlanMarkdown).toContain(`${sentinel} final plan`);
    expect(task.goalPrompt).toContain(sentinel);

    for (let attempt = 0; attempt < 200 && !goalCompleted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(goalCompleted).toBe(true);
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
    expect(blockedMessage.statusCode).toBe(409);
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
    expect(blockedQueue.statusCode).toBe(409);
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
    expect(blockedAutomation.statusCode).toBe(404);

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
