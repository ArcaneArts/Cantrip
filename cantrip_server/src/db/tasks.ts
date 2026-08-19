import {
  taskDetailSchema,
  taskDraftUpdateSchema,
  taskFinalizerResultSchema,
  taskPlanUpdateSchema,
  taskPlannerResultSchema,
  taskPlanningRoundListSchema,
  taskPlanningRoundSchema,
  TASK_ERROR_MESSAGE_LIMIT,
  type TaskDetail,
  type TaskDraftUpdate,
  type TaskFinalizerResult,
  type TaskOperationKind,
  type TaskPlanUpdate,
  type TaskPlannerResult,
  type TaskPlanningRound,
  type TaskQuestionAnswer,
  type TaskLastError,
} from "@cantrip/protocol/tasks";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  TaskStateTransitionError,
  assertTaskStateTransition,
  validateTaskOperationStart,
} from "../tasks/state.js";
import * as schema from "./schema.js";

type TaskDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;
type TaskPlanningRoundRow = typeof schema.taskPlanningRounds.$inferSelect;

export interface TaskOperationStartInput {
  operationId: string;
  kind: TaskOperationKind;
  rowVersion: number;
  answers?: TaskQuestionAnswer[];
  additionalDirection?: string;
}

export interface TaskOperationStartResult {
  task: TaskDetail;
  round: TaskPlanningRound;
  idempotent: boolean;
}

export interface TaskOperationContext {
  task: TaskDetail;
  round: TaskPlanningRound;
}

export interface TaskOperationLookup {
  operationId?: string;
  executionLaneId?: string;
  userMessageId?: string;
}

export function findTaskOperationRound(
  rounds: readonly TaskPlanningRound[],
  lookup: TaskOperationLookup,
): TaskPlanningRound | null {
  if (lookup.operationId) {
    return (
      rounds.find((candidate) => candidate.id === lookup.operationId) ?? null
    );
  }
  if (lookup.userMessageId) {
    return (
      rounds.find(
        (candidate) => candidate.userMessageId === lookup.userMessageId,
      ) ?? null
    );
  }
  if (lookup.executionLaneId) {
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const candidate = rounds[index];
      if (candidate?.executionLaneId === lookup.executionLaneId) {
        return candidate;
      }
    }
  }
  return null;
}

export class TaskConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      "idempotency-conflict" | "operation-active" | "stale-version",
  ) {
    super(message);
  }
}

function toISOString(value: Date): string {
  return value.toISOString();
}

export function toTaskDetail(row: TaskRow): TaskDetail {
  return taskDetailSchema.parse({
    chatId: row.chatId,
    state: row.state,
    stableStateBeforeFailure: row.stableStateBeforeFailure,
    activeOperationId: row.activeOperationId,
    activeOperationKind: row.activeOperationKind,
    briefMarkdown: row.briefMarkdown,
    draftAttachmentIds: row.draftAttachmentIds,
    planMarkdown: row.planMarkdown,
    planAuthorship: row.planAuthorship,
    currentQuestions: row.currentQuestions,
    currentAnswers: row.currentAnswers,
    additionalDirection: row.additionalDirection,
    finalPlanMarkdown: row.finalPlanMarkdown,
    goalPrompt: row.goalPrompt,
    planningRound: row.planningRound,
    implementationStartedAt: row.implementationStartedAt
      ? toISOString(row.implementationStartedAt)
      : null,
    lastError: row.lastError,
    rowVersion: row.rowVersion,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function toTaskPlanningRound(row: TaskPlanningRoundRow): TaskPlanningRound {
  return taskPlanningRoundSchema.parse({
    id: row.id,
    chatId: row.chatId,
    ordinal: row.ordinal,
    kind: row.kind,
    status: row.status,
    inputBriefMarkdown: row.inputBriefMarkdown,
    inputPlanMarkdown: row.inputPlanMarkdown,
    inputQuestions: row.inputQuestions,
    inputAnswers: row.inputAnswers,
    additionalDirection: row.additionalDirection,
    outputPlanMarkdown: row.outputPlanMarkdown,
    outputQuestions: row.outputQuestions,
    outputGoalPrompt: row.outputGoalPrompt,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    executionLaneId: row.executionLaneId,
    turnId: row.turnId,
    error: row.error,
    startedAt: toISOString(row.startedAt),
    completedAt: row.completedAt ? toISOString(row.completedAt) : null,
  });
}

function validateAnswers(
  task: TaskDetail,
  answers: TaskQuestionAnswer[],
  requireRequiredAnswers = true,
): void {
  const byQuestion = new Map(
    task.currentQuestions.map((question) => [question.id, question]),
  );
  const byAnswer = new Map(
    answers.map((answer) => [answer.questionId, answer]),
  );
  for (const answer of answers) {
    const question = byQuestion.get(answer.questionId);
    if (!question) {
      throw new TaskConflictError(
        "An answer referred to an outdated Task question.",
        "stale-version",
      );
    }
    if (
      answer.optionId &&
      !question.options.some((option) => option.id === answer.optionId)
    ) {
      throw new TaskConflictError(
        "An answer selected an unavailable Task option.",
        "stale-version",
      );
    }
    if (answer.freeform?.trim() && !question.allowFreeform) {
      throw new TaskConflictError(
        "This Task question does not accept a freeform answer.",
        "stale-version",
      );
    }
  }
  if (
    requireRequiredAnswers &&
    task.currentQuestions.some(
      (question) => question.required && !byAnswer.has(question.id),
    )
  ) {
    throw new TaskConflictError(
      "Answer every required Task question before continuing.",
      "stale-version",
    );
  }
}

export class TaskRepository {
  constructor(private readonly database: TaskDatabase) {}

  async get(ownerId: string, chatId: string): Promise<TaskDetail | null> {
    const rows = await this.database
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.tasks.chatId, chatId))
      .limit(1);
    return rows[0] ? toTaskDetail(rows[0].task) : null;
  }

  async listRounds(
    ownerId: string,
    chatId: string,
  ): Promise<TaskPlanningRound[]> {
    const owned = await this.get(ownerId, chatId);
    if (!owned) return [];
    const rows = await this.database
      .select()
      .from(schema.taskPlanningRounds)
      .where(eq(schema.taskPlanningRounds.chatId, chatId))
      .orderBy(asc(schema.taskPlanningRounds.ordinal));
    return taskPlanningRoundListSchema.parse(rows.map(toTaskPlanningRound));
  }

  async updateDraft(
    ownerId: string,
    chatId: string,
    rawInput: TaskDraftUpdate,
  ): Promise<TaskDetail | null> {
    const input = taskDraftUpdateSchema.parse(rawInput);
    const current = await this.get(ownerId, chatId);
    if (!current) return null;
    if (
      current.state !== "draft" &&
      !(
        current.state === "failed" &&
        current.stableStateBeforeFailure === "draft"
      )
    ) {
      throw new TaskStateTransitionError(current.state, "draft");
    }
    const updated = await this.database
      .update(schema.tasks)
      .set({
        ...(input.briefMarkdown !== undefined
          ? { briefMarkdown: input.briefMarkdown }
          : {}),
        ...(input.draftAttachmentIds !== undefined
          ? { draftAttachmentIds: input.draftAttachmentIds }
          : {}),
        rowVersion: current.rowVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.chatId, chatId),
          eq(schema.tasks.rowVersion, input.rowVersion),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw new TaskConflictError(
        "The Task draft changed in another client.",
        "stale-version",
      );
    }
    return toTaskDetail(updated[0]);
  }

  async updatePlan(
    ownerId: string,
    chatId: string,
    rawInput: TaskPlanUpdate,
  ): Promise<TaskDetail | null> {
    const input = taskPlanUpdateSchema.parse(rawInput);
    const current = await this.get(ownerId, chatId);
    if (!current) return null;
    if (
      current.state !== "review" &&
      !(
        current.state === "failed" &&
        current.stableStateBeforeFailure === "review"
      )
    ) {
      throw new TaskStateTransitionError(current.state, "review");
    }
    if (input.answers !== undefined) {
      validateAnswers(current, input.answers, false);
    }
    const planChanged =
      input.planMarkdown !== undefined &&
      input.planMarkdown !== current.planMarkdown;
    const updated = await this.database
      .update(schema.tasks)
      .set({
        ...(input.planMarkdown !== undefined
          ? { planMarkdown: input.planMarkdown }
          : {}),
        ...(planChanged
          ? {
              planAuthorship:
                current.planAuthorship === "agent" ? "user-edited" : "mixed",
            }
          : {}),
        ...(input.answers !== undefined
          ? { currentAnswers: input.answers }
          : {}),
        ...(input.additionalDirection !== undefined
          ? { additionalDirection: input.additionalDirection }
          : {}),
        rowVersion: current.rowVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.chatId, chatId),
          eq(schema.tasks.rowVersion, input.rowVersion),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw new TaskConflictError(
        "The Task plan changed in another client.",
        "stale-version",
      );
    }
    return toTaskDetail(updated[0]);
  }

  async beginOperation(
    ownerId: string,
    chatId: string,
    input: TaskOperationStartInput,
  ): Promise<TaskOperationStartResult | null> {
    if (!input.operationId.trim() || input.operationId.length > 200) {
      throw new TaskConflictError(
        "Task operation IDs must contain between 1 and 200 characters.",
        "idempotency-conflict",
      );
    }
    return this.database.transaction(async (transaction) => {
      const priorRounds = await transaction
        .select({ round: schema.taskPlanningRounds, task: schema.tasks })
        .from(schema.taskPlanningRounds)
        .innerJoin(
          schema.tasks,
          eq(schema.tasks.chatId, schema.taskPlanningRounds.chatId),
        )
        .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.taskPlanningRounds.id, input.operationId))
        .limit(1);
      const prior = priorRounds[0];
      if (prior) {
        if (prior.task.chatId !== chatId || prior.round.kind !== input.kind) {
          throw new TaskConflictError(
            "This Task operation ID was already used for different input.",
            "idempotency-conflict",
          );
        }
        return {
          task: toTaskDetail(prior.task),
          round: toTaskPlanningRound(prior.round),
          idempotent: true,
        };
      }

      const rows = await transaction
        .select({ task: schema.tasks })
        .from(schema.tasks)
        .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = rows[0]?.task;
      if (!task) return null;
      if (task.activeOperationId) {
        throw new TaskConflictError(
          "This Task already has an active operation.",
          "operation-active",
        );
      }
      if (task.rowVersion !== input.rowVersion) {
        throw new TaskConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      }
      const transition = validateTaskOperationStart(
        task.state,
        task.stableStateBeforeFailure,
        input.kind,
      );
      const current = toTaskDetail(task);
      const answers = input.answers ?? current.currentAnswers;
      const additionalDirection =
        input.additionalDirection ?? current.additionalDirection;
      if (input.kind === "initial-plan" && !current.briefMarkdown.trim()) {
        throw new TaskConflictError(
          "Write a Task brief before planning.",
          "stale-version",
        );
      }
      if (input.kind !== "initial-plan") {
        validateAnswers(current, answers);
      }
      if (input.kind === "finalize" && current.finalPlanMarkdown) {
        throw new TaskConflictError(
          "This Task already has immutable final artifacts. Retry Goal startup instead.",
          "idempotency-conflict",
        );
      }
      const ordinal = task.planningRound + 1;
      const now = new Date();
      const insertedRounds = await transaction
        .insert(schema.taskPlanningRounds)
        .values({
          id: input.operationId,
          chatId,
          ordinal,
          kind: input.kind,
          inputBriefMarkdown: task.briefMarkdown,
          inputPlanMarkdown: task.planMarkdown,
          inputQuestions: task.currentQuestions,
          inputAnswers: answers,
          additionalDirection,
          startedAt: now,
        })
        .returning();
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          state: transition.nextState,
          stableStateBeforeFailure: transition.stableState,
          activeOperationId: input.operationId,
          activeOperationKind: input.kind,
          planningRound: ordinal,
          currentAnswers: answers,
          additionalDirection,
          lastError: null,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.chatId, chatId),
            eq(schema.tasks.rowVersion, input.rowVersion),
            inArray(schema.tasks.state, [task.state]),
          ),
        )
        .returning();
      if (!updatedTasks[0]) {
        throw new TaskConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      }
      return {
        task: toTaskDetail(updatedTasks[0]),
        round: toTaskPlanningRound(insertedRounds[0]!),
        idempotent: false,
      };
    });
  }

  async getOperationContext(
    ownerId: string,
    chatId: string,
    lookup: TaskOperationLookup,
  ): Promise<TaskOperationContext | null> {
    const task = await this.get(ownerId, chatId);
    if (!task) return null;
    const rounds = await this.listRounds(ownerId, chatId);
    const round = findTaskOperationRound(rounds, lookup);
    return round ? { task, round } : null;
  }

  async attachOperationExecution(
    ownerId: string,
    chatId: string,
    operationId: string,
    input: { executionLaneId: string; userMessageId: string },
  ): Promise<TaskOperationContext | null> {
    if (!(await this.get(ownerId, chatId))) return null;
    await this.database
      .update(schema.taskPlanningRounds)
      .set({
        executionLaneId: input.executionLaneId,
        userMessageId: input.userMessageId,
      })
      .where(
        and(
          eq(schema.taskPlanningRounds.id, operationId),
          eq(schema.taskPlanningRounds.chatId, chatId),
          or(
            eq(schema.taskPlanningRounds.status, "running"),
            isNull(schema.taskPlanningRounds.userMessageId),
            eq(schema.taskPlanningRounds.userMessageId, input.userMessageId),
          ),
        ),
      );
    return this.getOperationContext(ownerId, chatId, { operationId });
  }

  async attachOperationAssistantMessage(
    ownerId: string,
    chatId: string,
    operationId: string,
    assistantMessageId: string,
  ): Promise<TaskOperationContext | null> {
    if (!(await this.get(ownerId, chatId))) return null;
    await this.database
      .update(schema.taskPlanningRounds)
      .set({ assistantMessageId })
      .where(
        and(
          eq(schema.taskPlanningRounds.id, operationId),
          eq(schema.taskPlanningRounds.chatId, chatId),
        ),
      );
    return this.getOperationContext(ownerId, chatId, { operationId });
  }

  async completePlanningOperation(
    ownerId: string,
    chatId: string,
    operationId: string,
    rawResult: TaskPlannerResult,
    turnId: string | null,
  ): Promise<TaskOperationContext | null> {
    const result = taskPlannerResultSchema.parse(rawResult);
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const roundRows = await transaction
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, operationId),
            eq(schema.taskPlanningRounds.chatId, chatId),
          ),
        )
        .for("update")
        .limit(1);
      const round = roundRows[0];
      if (!round) return null;
      if (round.kind === "finalize") {
        throw new TaskConflictError(
          "A finalization round cannot accept a planner result.",
          "idempotency-conflict",
        );
      }
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (round.status === "completed") {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(round),
        };
      }
      if (
        task.activeOperationId !== null &&
        task.activeOperationId !== operationId
      ) {
        throw new TaskConflictError(
          "A newer Task operation is active.",
          "operation-active",
        );
      }
      if (task.planningRound !== round.ordinal) {
        throw new TaskConflictError(
          "A newer Task planning round already superseded this outcome.",
          "idempotency-conflict",
        );
      }
      const now = new Date();
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({
          status: "completed",
          outputPlanMarkdown: result.planMarkdown,
          outputQuestions: result.questions,
          turnId,
          error: null,
          completedAt: now,
        })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          state: "review",
          stableStateBeforeFailure: null,
          activeOperationId: null,
          activeOperationKind: null,
          planMarkdown: result.planMarkdown,
          planAuthorship: "agent",
          currentQuestions: result.questions,
          currentAnswers: [],
          additionalDirection: "",
          lastError: null,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return {
        task: toTaskDetail(updatedTasks[0]!),
        round: toTaskPlanningRound(updatedRounds[0]!),
      };
    });
  }

  async stageFinalizationResult(
    ownerId: string,
    chatId: string,
    operationId: string,
    rawResult: TaskFinalizerResult,
    turnId: string | null,
  ): Promise<TaskOperationContext | null> {
    const result = taskFinalizerResultSchema.parse(rawResult);
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const roundRows = await transaction
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, operationId),
            eq(schema.taskPlanningRounds.chatId, chatId),
          ),
        )
        .for("update")
        .limit(1);
      const round = roundRows[0];
      if (!round) return null;
      if (round.kind !== "finalize") {
        throw new TaskConflictError(
          "A planning round cannot accept a finalization result.",
          "idempotency-conflict",
        );
      }
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (round.status === "completed") {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(round),
        };
      }
      const recoveringInterruptedResult =
        task.activeOperationId === null &&
        task.state === "failed" &&
        task.stableStateBeforeFailure === "review" &&
        task.planningRound === round.ordinal;
      if (
        !recoveringInterruptedResult &&
        round.outputPlanMarkdown === result.finalPlanMarkdown &&
        round.outputGoalPrompt === result.goalPrompt
      ) {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(round),
        };
      }
      if (
        (task.activeOperationId !== operationId &&
          !recoveringInterruptedResult) ||
        task.planningRound !== round.ordinal
      ) {
        throw new TaskConflictError(
          "A newer Task operation superseded this finalization result.",
          "idempotency-conflict",
        );
      }
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({
          outputPlanMarkdown: result.finalPlanMarkdown,
          outputGoalPrompt: result.goalPrompt,
          turnId,
          status: "running",
          error: null,
          completedAt: null,
        })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          planMarkdown: result.finalPlanMarkdown,
          finalPlanMarkdown: result.finalPlanMarkdown,
          goalPrompt: result.goalPrompt,
          currentQuestions: [],
          ...(recoveringInterruptedResult
            ? {
                state: "finalizing" as const,
                stableStateBeforeFailure: "review" as const,
                activeOperationId: operationId,
                activeOperationKind: "finalize" as const,
              }
            : {}),
          lastError: null,
          rowVersion: task.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return {
        task: toTaskDetail(updatedTasks[0]!),
        round: toTaskPlanningRound(updatedRounds[0]!),
      };
    });
  }

  async resumeFinalizationGoalLaunch(
    ownerId: string,
    chatId: string,
    rowVersion: number,
  ): Promise<TaskOperationContext | null> {
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (task.rowVersion !== rowVersion) {
        throw new TaskConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      }
      if (
        task.state !== "failed" ||
        task.stableStateBeforeFailure !== "review"
      ) {
        throw new TaskStateTransitionError(task.state, "finalizing");
      }
      const roundRows = await transaction
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.chatId, chatId),
            eq(schema.taskPlanningRounds.ordinal, task.planningRound),
          ),
        )
        .for("update")
        .limit(1);
      const round = roundRows[0];
      if (
        !round ||
        round.kind !== "finalize" ||
        !round.outputPlanMarkdown ||
        !round.outputGoalPrompt
      ) {
        throw new TaskConflictError(
          "This Task has no prepared Goal to resume.",
          "idempotency-conflict",
        );
      }
      const now = new Date();
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({ status: "running", error: null, completedAt: null })
        .where(eq(schema.taskPlanningRounds.id, round.id))
        .returning();
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          state: "finalizing",
          stableStateBeforeFailure: "review",
          activeOperationId: round.id,
          activeOperationKind: "finalize",
          lastError: null,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.chatId, chatId),
            eq(schema.tasks.rowVersion, rowVersion),
          ),
        )
        .returning();
      if (!updatedTasks[0]) {
        throw new TaskConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      }
      return {
        task: toTaskDetail(updatedTasks[0]),
        round: toTaskPlanningRound(updatedRounds[0]!),
      };
    });
  }

  async completeFinalizationOperation(
    ownerId: string,
    chatId: string,
    operationId: string,
  ): Promise<TaskOperationContext | null> {
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const roundRows = await transaction
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, operationId),
            eq(schema.taskPlanningRounds.chatId, chatId),
          ),
        )
        .for("update")
        .limit(1);
      const round = roundRows[0];
      if (!round) return null;
      if (round.kind !== "finalize") {
        throw new TaskConflictError(
          "A planning round cannot complete Goal startup.",
          "idempotency-conflict",
        );
      }
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (round.status === "completed") {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(round),
        };
      }
      if (!round.outputPlanMarkdown || !round.outputGoalPrompt) {
        throw new TaskConflictError(
          "The final Task artifacts are not ready.",
          "idempotency-conflict",
        );
      }
      if (
        task.activeOperationId !== operationId ||
        task.planningRound !== round.ordinal
      ) {
        throw new TaskConflictError(
          "A newer Task operation superseded Goal startup.",
          "idempotency-conflict",
        );
      }
      const now = new Date();
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({ status: "completed", error: null, completedAt: now })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          state: "implementing",
          stableStateBeforeFailure: null,
          activeOperationId: null,
          activeOperationKind: null,
          implementationStartedAt: task.implementationStartedAt ?? now,
          lastError: null,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return {
        task: toTaskDetail(updatedTasks[0]!),
        round: toTaskPlanningRound(updatedRounds[0]!),
      };
    });
  }

  async syncImplementationState(
    ownerId: string,
    chatId: string,
    input: {
      code: string | null;
      reason: string | null;
      state: "implementing" | "paused" | "blocked" | "complete" | "failed";
    },
  ): Promise<TaskDetail | null> {
    const current = await this.get(ownerId, chatId);
    if (!current) return null;
    const implementationFailure =
      current.state === "failed" && current.stableStateBeforeFailure === null;
    if (
      !current.implementationStartedAt ||
      (!["implementing", "paused", "blocked", "complete"].includes(
        current.state,
      ) &&
        !implementationFailure)
    ) {
      return current;
    }
    if (current.state === "complete") return current;
    if (current.state !== input.state) {
      assertTaskStateTransition(current.state, input.state);
    }
    const nextError: TaskLastError | null =
      input.state === "blocked" || input.state === "failed"
        ? {
            code: (input.code ?? "implementation-blocked").slice(0, 200),
            message: (input.reason ?? "Implementation needs attention.").slice(
              0,
              TASK_ERROR_MESSAGE_LIMIT,
            ),
            operationKind: "implementation",
            occurredAt: new Date().toISOString(),
          }
        : null;
    if (
      current.state === input.state &&
      current.lastError?.code === nextError?.code &&
      current.lastError?.message === nextError?.message
    ) {
      return current;
    }
    const updated = await this.database
      .update(schema.tasks)
      .set({
        state: input.state,
        stableStateBeforeFailure: null,
        lastError: nextError,
        rowVersion: current.rowVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.chatId, chatId),
          eq(schema.tasks.rowVersion, current.rowVersion),
        ),
      )
      .returning();
    return updated[0] ? toTaskDetail(updated[0]) : this.get(ownerId, chatId);
  }

  async failOperation(
    ownerId: string,
    chatId: string,
    operationId: string,
    input: {
      code: string;
      message: string;
      interrupted?: boolean;
    },
  ): Promise<TaskOperationContext | null> {
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const roundRows = await transaction
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, operationId),
            eq(schema.taskPlanningRounds.chatId, chatId),
          ),
        )
        .for("update")
        .limit(1);
      const round = roundRows[0];
      if (!round) return null;
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (round.status === "completed") {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(round),
        };
      }
      const now = new Date();
      const error: TaskLastError = {
        code: input.code.slice(0, 200) || "task-operation-failed",
        message:
          input.message.slice(0, TASK_ERROR_MESSAGE_LIMIT) ||
          "The Task operation failed.",
        operationKind: round.kind,
        occurredAt: now.toISOString(),
      };
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({
          status: input.interrupted ? "interrupted" : "failed",
          error,
          completedAt: now,
        })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      if (task.planningRound !== round.ordinal) {
        return {
          task: toTaskDetail(task),
          round: toTaskPlanningRound(updatedRounds[0]!),
        };
      }
      const updatedTasks = await transaction
        .update(schema.tasks)
        .set({
          state: "failed",
          stableStateBeforeFailure:
            round.kind === "initial-plan" ? "draft" : "review",
          ...(task.activeOperationId === operationId
            ? { activeOperationId: null, activeOperationKind: null }
            : {}),
          lastError: error,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return {
        task: toTaskDetail(updatedTasks[0]!),
        round: toTaskPlanningRound(updatedRounds[0]!),
      };
    });
  }

  async reconcileInterruptedOperations(): Promise<number> {
    const active = await this.database
      .select({ task: schema.tasks, round: schema.taskPlanningRounds })
      .from(schema.tasks)
      .innerJoin(
        schema.taskPlanningRounds,
        eq(schema.taskPlanningRounds.id, schema.tasks.activeOperationId),
      )
      .where(eq(schema.taskPlanningRounds.status, "running"));
    for (const { task, round } of active) {
      const now = new Date();
      const error: TaskLastError = {
        code: "server-restarted",
        message:
          "Task planning was interrupted by a server restart. A late durable worker outcome can still recover this round; otherwise retry it.",
        operationKind: round.kind,
        occurredAt: now.toISOString(),
      };
      await this.database.transaction(async (transaction) => {
        await transaction
          .update(schema.taskPlanningRounds)
          .set({ status: "interrupted", error, completedAt: now })
          .where(
            and(
              eq(schema.taskPlanningRounds.id, round.id),
              eq(schema.taskPlanningRounds.status, "running"),
            ),
          );
        await transaction
          .update(schema.tasks)
          .set({
            state: "failed",
            stableStateBeforeFailure:
              round.kind === "initial-plan" ? "draft" : "review",
            activeOperationId: null,
            activeOperationKind: null,
            lastError: error,
            rowVersion: task.rowVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.tasks.chatId, task.chatId),
              eq(schema.tasks.activeOperationId, round.id),
            ),
          );
      });
    }
    return active.length;
  }
}
