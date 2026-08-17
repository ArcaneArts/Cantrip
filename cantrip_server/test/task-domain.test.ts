import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatAttachmentListSchema,
  chatListSchema,
  chatMessageListSchema,
  chatSummarySchema,
  taskCreateResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { taskDetailSchema } from "@cantrip/protocol/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { buildTaskGoalObjective } from "../src/tasks/planner.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-domain-"),
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
const plannerResult = {
  planMarkdown: "# Durable Task plan\n\nImplement this in isolated milestones.",
  questions: [
    {
      id: "delivery",
      header: "Delivery",
      question: "Should milestones merge sequentially?",
      options: [
        {
          id: "sequential",
          label: "Sequential PRs",
          description: "Merge and clean each worktree before the next.",
        },
      ],
      recommendedOptionId: "sequential",
      allowFreeform: true,
      required: true,
    },
  ],
};
const finalizerResult = {
  finalPlanMarkdown:
    "# Final Task plan\n\nDeliver every acceptance criterion in sequential, policy-compliant milestones.",
  goalPrompt:
    "Implement the complete final plan and continue through every milestone.",
};
let taskTurnCommand: Extract<WorkerCommand, { type: "chat.turn" }> | null =
  null;
let codePreparationCount = 0;
let goalCreateCount = 0;
let goalTurnCount = 0;
let structuredTurnCount = 0;
let failNextGoalCreate = false;
let nextTaskStructuredResult: unknown = plannerResult;
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
  async request(_workerId, command, options) {
    if (command.type === "code.prepareAgentTurn") {
      codePreparationCount += 1;
      return { prepared: true, sessions: [] };
    }
    if (command.type === "code.agentTurnState") {
      return { notifiedSessions: 0, refreshed: [], conflicts: [] };
    }
    if (command.type === "chat.turn") {
      taskTurnCommand = command;
      if (command.resultMode.kind !== "structured") {
        goalTurnCount += 1;
        return {
          threadId: "task-planner-thread",
          turnId: "task-goal-turn",
          text: "Implementation is underway.",
          structuredResult: null,
          status: "completed",
        };
      }
      structuredTurnCount += 1;
      const structuredResult = nextTaskStructuredResult;
      nextTaskStructuredResult = plannerResult;
      await options?.onEvent?.({
        type: "agent.message",
        message: {
          id: "task-commentary",
          text: "Inspecting the repository and effective policies.",
          phase: "commentary",
          correlation: null,
        },
      });
      await options?.onEvent?.({
        type: "agent.message",
        message: {
          id: "task-raw-final",
          text: `RAW_STRUCTURED_RESULT ${JSON.stringify(structuredResult)}`,
          phase: "final_answer",
          correlation: null,
        },
      });
      return {
        threadId: "task-planner-thread",
        turnId: "task-planner-turn",
        text: JSON.stringify(structuredResult),
        structuredResult,
        status: "completed",
      };
    }
    if (command.type === "chat.goal.create") {
      goalCreateCount += 1;
      if (failNextGoalCreate) {
        failNextGoalCreate = false;
        throw new Error("Goal runtime temporarily unavailable.");
      }
      return {
        goal: {
          threadId: command.threadId ?? "task-planner-thread",
          objective: command.objective,
          status: "active",
          tokenBudget: command.tokenBudget,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    }
    throw new Error(`Unexpected Task foundation command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "task-worker",
    name: "Task Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "task-worker",
    repositoryId: "task-domain",
    nameWithOwner: "ArcaneArts/TaskDomain",
    url: "https://github.com/ArcaneArts/TaskDomain",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "task-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/TaskDomain",
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

async function waitForTaskState(
  chatId: string,
  state: string,
  planningRound?: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${chatId}`,
    });
    const task = taskDetailSchema.parse(response.json());
    if (
      task.state === state &&
      (planningRound === undefined || task.planningRound >= planningRound)
    )
      return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${chatId} did not reach ${state}.`);
}

describe.sequential("Task domain foundation", () => {
  it("atomically creates a Task-backed Chat without changing ordinary Chats", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: { title: "Plan a large feature" },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskCreateResultSchema.parse(createdResponse.json());
    expect(created.chat).toMatchObject({
      experience: "task",
      title: "Plan a large feature",
    });
    expect(created.task).toMatchObject({
      chatId: created.chat.id,
      state: "draft",
      rowVersion: 1,
      briefMarkdown: "",
    });

    const task = taskDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/tasks/${created.chat.id}`,
        })
      ).json(),
    );
    expect(task.chatId).toBe(created.chat.id);

    const ordinaryResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: { title: "Ordinary agent" },
    });
    expect(ordinaryResponse.statusCode).toBe(201);
    const ordinary = chatSummarySchema.parse(ordinaryResponse.json());
    expect(ordinary.experience).toBe("agent");
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${ordinary.id}` }))
        .statusCode,
    ).toBe(404);

    const chats = chatListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/chats`,
        })
      ).json(),
    );
    expect(chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.chat.id, experience: "task" }),
        expect.objectContaining({ id: ordinary.id, experience: "agent" }),
      ]),
    );
    expect(
      await database.repository.tasks.get("other-owner", created.chat.id),
    ).toBeNull();
  });

  it("uses optimistic revisions for draft updates", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Revision safety", worktreeMode: "agent-managed" },
    );
    expect(created).not.toBeNull();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/draft`,
      payload: {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "A durable implementation brief",
        draftAttachmentIds: ["attachment-one"],
      },
    });
    expect(response.statusCode).toBe(200);
    const updated = taskDetailSchema.parse(response.json());
    expect(updated).toMatchObject({
      rowVersion: 2,
      briefMarkdown: "A durable implementation brief",
      draftAttachmentIds: ["attachment-one"],
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/draft`,
      payload: { rowVersion: 1, briefMarkdown: "Stale overwrite" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale-version" });
    expect(
      await database.repository.tasks.get(LOCAL_USER_ID, created!.chat.id),
    ).toMatchObject({ briefMarkdown: "A durable implementation brief" });
  });

  it("hydrates only the ordered attachments selected by the Task draft", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Attachment hydration", worktreeMode: "agent-managed" },
    );
    const attachmentId = randomUUID();
    await database.repository.createChatAttachment(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        fileName: "architecture.md",
        id: attachmentId,
        kind: "text",
        mimeType: "text/markdown",
        previewText: "# Architecture",
        sha256: "a".repeat(64),
        sizeBytes: 14,
        source: "file",
        workerId: "task-worker",
      },
    );
    await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        draftAttachmentIds: [attachmentId],
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${created!.chat.id}/attachments`,
    });
    expect(response.statusCode).toBe(200);
    expect(chatAttachmentListSchema.parse(response.json())).toEqual([
      expect.objectContaining({
        chatId: created!.chat.id,
        fileName: "architecture.md",
        id: attachmentId,
      }),
    ]);
  });

  it("starts one idempotent planning round with a stable input snapshot", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Idempotent planning", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Plan this once even if the request is retried.",
      },
    );
    const input = {
      operationId: "task-operation-one",
      kind: "initial-plan" as const,
      rowVersion: drafted!.rowVersion,
    };
    const started = await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      input,
    );
    expect(started).toMatchObject({
      idempotent: false,
      task: {
        state: "planning",
        activeOperationId: input.operationId,
        planningRound: 1,
      },
      round: {
        id: input.operationId,
        ordinal: 1,
        status: "running",
        inputBriefMarkdown: "Plan this once even if the request is retried.",
      },
    });

    const retried = await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      input,
    );
    expect(retried).toMatchObject({
      idempotent: true,
      round: { id: input.operationId },
    });
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toHaveLength(1);
    await database.repository.tasks.completePlanningOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      input.operationId,
      plannerResult,
      "foundation-turn",
    );
  });

  it("runs Task planning as a read-only structured turn and normalizes its transcript", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Structured planner", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Inspect the repository and write a complete plan.",
      },
    );
    const operationId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: {
        operationId,
        rowVersion: drafted!.rowVersion,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${created!.chat.id}/plan`,
          payload: { operationId, rowVersion: drafted!.rowVersion },
        })
      ).statusCode,
    ).toBe(202);
    const completed = await waitForTaskState(created!.chat.id, "review");
    expect(completed).toMatchObject({
      planMarkdown: plannerResult.planMarkdown,
      currentQuestions: plannerResult.questions,
      activeOperationId: null,
      lastError: null,
    });

    expect(taskTurnCommand).toMatchObject({
      permissionProfileId: expect.any(String),
      planMode: "default",
      skillNames: [],
      mcpServers: [],
      resultMode: {
        kind: "structured",
        outputSchema: expect.objectContaining({ type: "object" }),
      },
    });
    expect(taskTurnCommand?.policyContext).toContain(
      "Effective Cantrip policies",
    );
    expect(taskTurnCommand?.prompt).toContain("strictly read-only");
    expect(codePreparationCount).toBe(0);

    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${created!.chat.id}/messages`,
        })
      ).json(),
    );
    const visibleText = messages
      .flatMap((message) =>
        message.content.flatMap((content) =>
          content.type === "text" ? [content.text] : [],
        ),
      )
      .join("\n");
    expect(visibleText).toContain(plannerResult.planMarkdown);
    expect(visibleText).toContain("Inspecting the repository");
    expect(visibleText).not.toContain("RAW_STRUCTURED_RESULT");
    expect(visibleText).not.toContain('"planMarkdown"');

    const rounds = await database.repository.tasks.listRounds(
      LOCAL_USER_ID,
      created!.chat.id,
    );
    expect(rounds).toEqual([
      expect.objectContaining({
        status: "completed",
        outputPlanMarkdown: plannerResult.planMarkdown,
        userMessageId: expect.any(String),
        assistantMessageId: expect.any(String),
        executionLaneId: expect.any(String),
        turnId: "task-planner-turn",
      }),
    ]);

    const invalidReviewResponse = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: {
        rowVersion: completed.rowVersion,
        answers: [
          {
            questionId: "delivery",
            optionId: "missing-option",
            freeform: null,
          },
        ],
      },
    });
    expect(invalidReviewResponse.statusCode).toBe(409);

    const savedReviewResponse = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: {
        rowVersion: completed.rowVersion,
        planMarkdown:
          "# User-refined Task plan\n\nKeep the rollout independently reversible.",
        answers: [
          {
            questionId: "delivery",
            optionId: "sequential",
            freeform: null,
          },
        ],
        additionalDirection: "Keep each milestone independently mergeable.",
      },
    });
    expect(savedReviewResponse.statusCode).toBe(200);
    const savedReview = taskDetailSchema.parse(savedReviewResponse.json());
    expect(savedReview).toMatchObject({
      planAuthorship: "user-edited",
      currentAnswers: [{ questionId: "delivery", optionId: "sequential" }],
      additionalDirection: "Keep each milestone independently mergeable.",
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${created!.chat.id}/plan`,
          payload: {
            rowVersion: completed.rowVersion,
            additionalDirection: "Overwrite from a stale window.",
          },
        })
      ).statusCode,
    ).toBe(409);

    const continuedPlan = {
      planMarkdown:
        "# Revised Task plan\n\nDeliver every milestone as a sequential PR.",
      questions: [],
    };
    nextTaskStructuredResult = continuedPlan;
    const continuedResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/continue`,
      payload: {
        operationId: randomUUID(),
        rowVersion: savedReview.rowVersion,
        answers: [
          {
            questionId: "delivery",
            optionId: "sequential",
            freeform: null,
          },
        ],
        additionalDirection: "Keep each milestone independently mergeable.",
      },
    });
    expect(continuedResponse.statusCode).toBe(202);
    const continued = await waitForTaskState(created!.chat.id, "review", 2);
    expect(continued).toMatchObject({
      planningRound: 2,
      planMarkdown: continuedPlan.planMarkdown,
      currentQuestions: [],
    });
    expect(taskTurnCommand?.prompt).toContain("Sequential PRs");
    expect(taskTurnCommand?.prompt).toContain("User-refined Task plan");
    expect(taskTurnCommand?.prompt).toContain(
      "Keep each milestone independently mergeable.",
    );
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toHaveLength(2);
  });

  it("retains the stable draft when structured planner output is invalid", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Invalid planner output", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Keep this draft if the model contract fails.",
      },
    );
    nextTaskStructuredResult = { questions: [] };
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: { operationId: randomUUID(), rowVersion: drafted!.rowVersion },
    });
    expect(response.statusCode).toBe(202);
    const failed = await waitForTaskState(created!.chat.id, "failed");
    expect(failed).toMatchObject({
      briefMarkdown: "Keep this draft if the model contract fails.",
      planMarkdown: null,
      stableStateBeforeFailure: "draft",
      activeOperationId: null,
      lastError: { code: "task-planning-failed" },
    });
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toEqual([expect.objectContaining({ status: "failed" })]);

    nextTaskStructuredResult = plannerResult;
    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/retry`,
      payload: {
        operationId: randomUUID(),
        rowVersion: failed.rowVersion,
      },
    });
    expect(retryResponse.statusCode).toBe(202);
    const recovered = await waitForTaskState(created!.chat.id, "review", 2);
    expect(recovered).toMatchObject({
      planMarkdown: plannerResult.planMarkdown,
      planningRound: 2,
      lastError: null,
    });
  });

  it("finalizes one immutable plan and starts one same-Chat Goal idempotently", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Goal handoff", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Finalize this plan and implement the complete result.",
      },
    );
    await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: { operationId: randomUUID(), rowVersion: drafted!.rowVersion },
    });
    const review = await waitForTaskState(created!.chat.id, "review");
    nextTaskStructuredResult = finalizerResult;
    const operationId = randomUUID();
    const payload = {
      operationId,
      rowVersion: review.rowVersion,
      answers: [
        {
          questionId: "delivery",
          optionId: "sequential",
          freeform: null,
        },
      ],
      additionalDirection: "Keep every milestone independently mergeable.",
    };
    const goalsBefore = goalCreateCount;
    const goalTurnsBefore = goalTurnCount;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${created!.chat.id}/begin-implementation`,
          payload,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${created!.chat.id}/begin-implementation`,
          payload,
        })
      ).statusCode,
    ).toBe(202);

    const implementing = await waitForTaskState(
      created!.chat.id,
      "implementing",
    );
    expect(implementing).toMatchObject({
      finalPlanMarkdown: finalizerResult.finalPlanMarkdown,
      implementationStartedAt: expect.any(String),
      currentQuestions: [],
      activeOperationId: null,
    });
    expect(implementing.goalPrompt).toContain(
      "# Cantrip Task implementation objective",
    );
    expect(implementing.goalPrompt).toContain("cantrip policy read");
    expect(implementing.goalPrompt).toContain(finalizerResult.goalPrompt);
    expect(implementing.goalPrompt).toContain(
      finalizerResult.finalPlanMarkdown,
    );
    expect(goalCreateCount - goalsBefore).toBe(1);
    expect(goalTurnCount - goalTurnsBefore).toBe(1);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${created!.chat.id}/begin-implementation`,
          payload,
        })
      ).statusCode,
    ).toBe(202);
    expect(goalCreateCount - goalsBefore).toBe(1);
    expect(goalTurnCount - goalTurnsBefore).toBe(1);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${created!.chat.id}/plan`,
          payload: {
            rowVersion: implementing.rowVersion,
            planMarkdown: "# Attempted rewrite",
          },
        })
      ).statusCode,
    ).toBe(409);

    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${created!.chat.id}/messages`,
        })
      ).json(),
    );
    expect(
      messages.filter(
        (message) => message.role === "user" && message.mode === "goal",
      ),
    ).toHaveLength(1);
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: operationId,
          kind: "finalize",
          status: "completed",
          outputPlanMarkdown: finalizerResult.finalPlanMarkdown,
          outputGoalPrompt: implementing.goalPrompt,
          turnId: "task-planner-turn",
        }),
      ]),
    );
  });

  it("retries a prepared Goal launch without rerunning finalization", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Goal launch recovery", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Preserve final artifacts if Goal startup fails.",
      },
    );
    await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/plan`,
      payload: { operationId: randomUUID(), rowVersion: drafted!.rowVersion },
    });
    const review = await waitForTaskState(created!.chat.id, "review");
    nextTaskStructuredResult = finalizerResult;
    failNextGoalCreate = true;
    const structuredBefore = structuredTurnCount;
    const goalsBefore = goalCreateCount;
    await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/begin-implementation`,
      payload: {
        operationId: randomUUID(),
        rowVersion: review.rowVersion,
        answers: [
          {
            questionId: "delivery",
            optionId: "sequential",
            freeform: null,
          },
        ],
        additionalDirection: "",
      },
    });
    const failed = await waitForTaskState(created!.chat.id, "failed");
    expect(failed).toMatchObject({
      stableStateBeforeFailure: "review",
      finalPlanMarkdown: finalizerResult.finalPlanMarkdown,
      goalPrompt: expect.stringContaining(finalizerResult.goalPrompt),
      lastError: { code: "task-goal-start-failed", operationKind: "finalize" },
    });
    expect(structuredTurnCount - structuredBefore).toBe(1);
    expect(goalCreateCount - goalsBefore).toBe(1);

    const retry = await app.inject({
      method: "POST",
      url: `/api/tasks/${created!.chat.id}/retry`,
      payload: {
        operationId: randomUUID(),
        rowVersion: failed.rowVersion,
      },
    });
    expect(retry.statusCode).toBe(202);
    await waitForTaskState(created!.chat.id, "implementing");
    expect(structuredTurnCount - structuredBefore).toBe(1);
    expect(goalCreateCount - goalsBefore).toBe(2);
  });

  it("recovers staged final artifacts after a server restart window", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Finalization restart", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Recover finalization after a restart.",
      },
    );
    const planningId = randomUUID();
    await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        operationId: planningId,
        kind: "initial-plan",
        rowVersion: drafted!.rowVersion,
      },
    );
    const reviewed = await database.repository.tasks.completePlanningOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      planningId,
      plannerResult,
      "restart-planning-turn",
    );
    const finalizeId = randomUUID();
    await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        operationId: finalizeId,
        kind: "finalize",
        rowVersion: reviewed!.task.rowVersion,
        answers: [
          {
            questionId: "delivery",
            optionId: "sequential",
            freeform: null,
          },
        ],
      },
    );
    const objective = buildTaskGoalObjective(finalizerResult);
    await database.repository.tasks.stageFinalizationResult(
      LOCAL_USER_ID,
      created!.chat.id,
      finalizeId,
      {
        finalPlanMarkdown: finalizerResult.finalPlanMarkdown,
        goalPrompt: objective,
      },
      "restart-finalizer-turn",
    );

    expect(
      await database.repository.tasks.reconcileInterruptedOperations(),
    ).toBe(1);
    const interrupted = await database.repository.tasks.get(
      LOCAL_USER_ID,
      created!.chat.id,
    );
    expect(interrupted).toMatchObject({
      state: "failed",
      finalPlanMarkdown: finalizerResult.finalPlanMarkdown,
      goalPrompt: objective,
      lastError: { code: "server-restarted", operationKind: "finalize" },
    });

    const resumed =
      await database.repository.tasks.resumeFinalizationGoalLaunch(
        LOCAL_USER_ID,
        created!.chat.id,
        interrupted!.rowVersion,
      );
    expect(resumed).toMatchObject({
      task: { state: "finalizing", activeOperationId: finalizeId },
      round: { id: finalizeId, status: "running" },
    });
    const completed =
      await database.repository.tasks.completeFinalizationOperation(
        LOCAL_USER_ID,
        created!.chat.id,
        finalizeId,
      );
    expect(completed).toMatchObject({
      task: {
        state: "implementing",
        finalPlanMarkdown: finalizerResult.finalPlanMarkdown,
        implementationStartedAt: expect.any(String),
      },
      round: { status: "completed" },
    });
  });

  it("reconciles interrupted rounds and accepts a late durable outcome once", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Restart recovery", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Recover this planning result after restart.",
      },
    );
    const operationId = randomUUID();
    await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        operationId,
        kind: "initial-plan",
        rowVersion: drafted!.rowVersion,
      },
    );
    expect(
      await database.repository.tasks.reconcileInterruptedOperations(),
    ).toBe(1);
    expect(
      await database.repository.tasks.get(LOCAL_USER_ID, created!.chat.id),
    ).toMatchObject({
      state: "failed",
      stableStateBeforeFailure: "draft",
      activeOperationId: null,
      lastError: { code: "server-restarted" },
    });

    const recovered = await database.repository.tasks.completePlanningOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      operationId,
      plannerResult,
      "late-worker-turn",
    );
    expect(recovered).toMatchObject({
      task: { state: "review", planMarkdown: plannerResult.planMarkdown },
      round: { status: "completed", turnId: "late-worker-turn" },
    });
    const duplicate = await database.repository.tasks.completePlanningOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      operationId,
      plannerResult,
      "late-worker-turn",
    );
    expect(duplicate).toMatchObject({ round: { status: "completed" } });
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toHaveLength(1);
  });
});
