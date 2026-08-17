import {
  taskDetailSchema,
  taskDraftUpdateSchema,
  taskPlanUpdateSchema,
  taskPlanningRoundListSchema,
  taskPlanningRoundSchema,
  type TaskDetail,
  type TaskDraftUpdate,
  type TaskOperationKind,
  type TaskPlanUpdate,
  type TaskPlanningRound,
} from "@cantrip/protocol/tasks";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  TaskStateTransitionError,
  validateTaskOperationStart,
} from "../tasks/state.js";
import * as schema from "./schema.js";

type TaskDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;
type TaskPlanningRoundRow = typeof schema.taskPlanningRounds.$inferSelect;

export interface TaskOperationStart {
  operationId: string;
  kind: TaskOperationKind;
  rowVersion: number;
}

export interface TaskOperationStartResult {
  task: TaskDetail;
  round: TaskPlanningRound;
  idempotent: boolean;
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
    if (current.state !== "review") {
      throw new TaskStateTransitionError(current.state, "review");
    }
    const updated = await this.database
      .update(schema.tasks)
      .set({
        planMarkdown: input.planMarkdown,
        planAuthorship:
          current.planAuthorship === "agent" ? "user-edited" : "mixed",
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
    input: TaskOperationStart,
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
          inputAnswers: task.currentAnswers,
          additionalDirection: task.additionalDirection,
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
}
