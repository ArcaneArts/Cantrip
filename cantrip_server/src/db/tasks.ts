import {
  taskEncryptedOperationStartSchema,
  taskOpaqueContentSchema,
  taskOpaqueMutationSchema,
  taskOpaqueSummarySchema,
  taskOperationRelayResultSchema,
  taskPlanningRoundOpaqueSummarySchema,
  type TaskEncryptedOperationStart,
  type TaskOpaqueContent,
  type TaskOpaqueMutation,
  type TaskOpaqueSummary,
  type TaskOperationRelayRequest,
  type TaskOperationRelayResult,
  type TaskPlanningRoundOpaqueContent,
  type TaskPlanningRoundOpaqueSummary,
} from "@cantrip/protocol/tasks";
import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  canTransitionTaskState,
  TaskStateTransitionError,
  validateTaskOperationStart,
} from "../tasks/state.js";
import * as schema from "./schema.js";

type TaskDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;
type TaskPlanningRoundRow = typeof schema.taskPlanningRounds.$inferSelect;

export interface TaskOperationLookup {
  operationId?: string;
  executionLaneId?: string;
  userMessageId?: string;
}

export interface TaskOperationContext {
  task: TaskOpaqueSummary;
  round: TaskPlanningRoundOpaqueSummary;
  relayRequest: TaskOperationRelayRequest;
  relayResult: TaskOperationRelayResult | null;
}

export interface TaskOperationStartResult extends TaskOperationContext {
  idempotent: boolean;
}

export function findTaskOperationRound<
  T extends {
    id: string;
    executionLaneId: string | null;
    userMessageId: string | null;
  },
>(rounds: readonly T[], lookup: TaskOperationLookup): T | null {
  if (lookup.operationId) {
    return rounds.find((round) => round.id === lookup.operationId) ?? null;
  }
  if (lookup.userMessageId) {
    return (
      rounds.find((round) => round.userMessageId === lookup.userMessageId) ??
      null
    );
  }
  if (lookup.executionLaneId) {
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      if (rounds[index]?.executionLaneId === lookup.executionLaneId) {
        return rounds[index] ?? null;
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

function iso(value: Date): string {
  return value.toISOString();
}

export function taskOpaqueColumns(content: TaskOpaqueContent) {
  return {
    state: content.classification.state,
    stableStateBeforeFailure: content.classification.stableStateBeforeFailure,
    activeOperationKind: content.classification.activeOperationKind,
    planAuthorship: content.classification.planAuthorship,
    planningRound: content.classification.planningRound,
    hasPlan: content.classification.hasPlan,
    hasQuestions: content.classification.hasQuestions,
    hasFinalPlan: content.classification.hasFinalPlan,
    hasGoalPrompt: content.classification.hasGoalPrompt,
    lastError: content.classification.lastError,
    protectedContent: content.protectedContent,
  };
}

function roundColumns(content: TaskPlanningRoundOpaqueContent) {
  return {
    ordinal: content.classification.ordinal,
    kind: content.classification.kind,
    status: content.classification.status,
    hasOutputPlan: content.classification.hasOutputPlan,
    hasOutputQuestions: content.classification.hasOutputQuestions,
    hasOutputGoalPrompt: content.classification.hasOutputGoalPrompt,
    error: content.classification.error,
    protectedContent: content.protectedContent,
  };
}

export function toTaskOpaqueSummary(row: TaskRow): TaskOpaqueSummary {
  return taskOpaqueSummarySchema.parse({
    chatId: row.chatId,
    planGoalEnabled: row.planGoalEnabled,
    state: row.state,
    stableStateBeforeFailure: row.stableStateBeforeFailure,
    activeOperationId: row.activeOperationId,
    activeOperationKind: row.activeOperationKind,
    draftAttachmentIds: row.draftAttachmentIds,
    planAuthorship: row.planAuthorship,
    planningRound: row.planningRound,
    hasPlan: row.hasPlan,
    hasQuestions: row.hasQuestions,
    hasFinalPlan: row.hasFinalPlan,
    hasGoalPrompt: row.hasGoalPrompt,
    lastError: row.lastError,
    protectedContent: row.protectedContent,
    implementationStartedAt: row.implementationStartedAt
      ? iso(row.implementationStartedAt)
      : null,
    rowVersion: row.rowVersion,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function toRoundOpaqueSummary(
  row: TaskPlanningRoundRow,
): TaskPlanningRoundOpaqueSummary {
  return taskPlanningRoundOpaqueSummarySchema.parse({
    id: row.id,
    chatId: row.chatId,
    ordinal: row.ordinal,
    kind: row.kind,
    status: row.status,
    hasOutputPlan: row.hasOutputPlan,
    hasOutputQuestions: row.hasOutputQuestions,
    hasOutputGoalPrompt: row.hasOutputGoalPrompt,
    error: row.error,
    protectedContent: row.protectedContent,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    executionLaneId: row.executionLaneId,
    turnId: row.turnId,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  });
}

function context(
  task: TaskRow,
  round: TaskPlanningRoundRow,
): TaskOperationContext {
  return {
    task: toTaskOpaqueSummary(task),
    round: toRoundOpaqueSummary(round),
    relayRequest: round.relayRequest,
    relayResult: round.relayResult,
  };
}

function sameOperation(
  request: TaskOperationRelayRequest,
  prior: TaskOperationRelayRequest,
): boolean {
  return (
    request.chatId === prior.chatId &&
    request.operationId === prior.operationId &&
    request.fingerprint === prior.fingerprint &&
    request.classification.kind === prior.classification.kind &&
    request.classification.ordinal === prior.classification.ordinal
  );
}

function assertMutationKeepsOperationalState(
  current: TaskOpaqueSummary,
  mutation: TaskOpaqueMutation,
): void {
  const next = mutation.task.classification;
  if (
    next.state !== current.state ||
    next.stableStateBeforeFailure !== current.stableStateBeforeFailure ||
    next.activeOperationKind !== current.activeOperationKind ||
    next.planningRound !== current.planningRound ||
    next.hasFinalPlan !== current.hasFinalPlan ||
    next.hasGoalPrompt !== current.hasGoalPrompt ||
    JSON.stringify(next.lastError) !== JSON.stringify(current.lastError)
  ) {
    throw new TaskConflictError(
      "The encrypted Task mutation changed server-owned state.",
      "stale-version",
    );
  }
}

export class TaskRepository {
  constructor(private readonly database: TaskDatabase) {}

  async get(ownerId: string, chatId: string): Promise<any> {
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
    return rows[0] ? toTaskOpaqueSummary(rows[0].task) : null;
  }

  async listRounds(ownerId: string, chatId: string): Promise<any[]> {
    if (!(await this.get(ownerId, chatId))) return [];
    const rows = await this.database
      .select()
      .from(schema.taskPlanningRounds)
      .where(eq(schema.taskPlanningRounds.chatId, chatId))
      .orderBy(asc(schema.taskPlanningRounds.ordinal));
    return rows.map(toRoundOpaqueSummary);
  }

  async updateDraft(
    ownerId: string,
    chatId: string,
    rawInput: TaskOpaqueMutation,
  ): Promise<TaskOpaqueSummary | null> {
    const input = taskOpaqueMutationSchema.parse(rawInput);
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
    assertMutationKeepsOperationalState(current, input);
    const updated = await this.database
      .update(schema.tasks)
      .set({
        ...taskOpaqueColumns(input.task),
        ...(input.planGoalEnabled !== undefined
          ? { planGoalEnabled: input.planGoalEnabled }
          : {}),
        ...(input.draftAttachmentIds
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
    return toTaskOpaqueSummary(updated[0]);
  }

  async updatePlan(
    ownerId: string,
    chatId: string,
    rawInput: TaskOpaqueMutation,
  ): Promise<TaskOpaqueSummary | null> {
    const input = taskOpaqueMutationSchema.parse(rawInput);
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
    assertMutationKeepsOperationalState(current, input);
    const updated = await this.database
      .update(schema.tasks)
      .set({
        ...taskOpaqueColumns(input.task),
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
    return toTaskOpaqueSummary(updated[0]);
  }

  async beginOperation(
    ownerId: string,
    chatId: string,
    rawInput: any,
  ): Promise<any> {
    const input = taskEncryptedOperationStartSchema.parse(rawInput);
    const request = input.operation;
    if (request.chatId !== chatId) {
      throw new TaskConflictError(
        "The encrypted Task operation belongs to another Task.",
        "idempotency-conflict",
      );
    }
    return this.database.transaction(async (transaction) => {
      const priorRows = await transaction
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
        .where(eq(schema.taskPlanningRounds.id, request.operationId))
        .limit(1);
      const prior = priorRows[0];
      if (prior) {
        if (!sameOperation(request, prior.round.relayRequest)) {
          throw new TaskConflictError(
            "This Task operation ID was already used for different input.",
            "idempotency-conflict",
          );
        }
        return { ...context(prior.task, prior.round), idempotent: true };
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
      if ((request.classification.kind === "direct") === task.planGoalEnabled) {
        throw new TaskConflictError(
          task.planGoalEnabled
            ? "Disable Plan + Goal before starting this Task directly."
            : "Enable Plan + Goal before starting a planning operation.",
          "idempotency-conflict",
        );
      }
      validateTaskOperationStart(
        task.state,
        task.stableStateBeforeFailure,
        request.classification.kind,
      );
      if (request.classification.ordinal !== task.planningRound + 1) {
        throw new TaskConflictError(
          "The encrypted Task planning round is stale.",
          "stale-version",
        );
      }
      const now = new Date();
      const inserted = await transaction
        .insert(schema.taskPlanningRounds)
        .values({
          id: request.operationId,
          chatId,
          ...roundColumns({
            classification: request.classification,
            protectedContent: request.protectedInput,
          }),
          relayRequest: request,
          failureTask: input.failure.task,
          failureRound: input.failure.round,
          startedAt: now,
        })
        .returning();
      const updated = await transaction
        .update(schema.tasks)
        .set({
          ...taskOpaqueColumns(request.task),
          activeOperationId: request.operationId,
          ...(request.classification.kind === "direct"
            ? { implementationStartedAt: task.implementationStartedAt ?? now }
            : {}),
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
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
          "The Task changed in another client.",
          "stale-version",
        );
      }
      return { ...context(updated[0], inserted[0]!), idempotent: false };
    });
  }

  async getOperationContext(
    ownerId: string,
    chatId: string,
    lookup: TaskOperationLookup,
  ): Promise<any> {
    const rows = await this.database
      .select({ task: schema.tasks, round: schema.taskPlanningRounds })
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
      .where(
        and(
          eq(schema.taskPlanningRounds.chatId, chatId),
          ...(lookup.operationId
            ? [eq(schema.taskPlanningRounds.id, lookup.operationId)]
            : lookup.userMessageId
              ? [
                  eq(
                    schema.taskPlanningRounds.userMessageId,
                    lookup.userMessageId,
                  ),
                ]
              : lookup.executionLaneId
                ? [
                    eq(
                      schema.taskPlanningRounds.executionLaneId,
                      lookup.executionLaneId,
                    ),
                  ]
                : []),
        ),
      )
      .orderBy(asc(schema.taskPlanningRounds.ordinal));
    const found = lookup.executionLaneId ? rows.at(-1) : rows[0];
    return found ? context(found.task, found.round) : null;
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
      .set(input)
      .where(
        and(
          eq(schema.taskPlanningRounds.id, operationId),
          eq(schema.taskPlanningRounds.chatId, chatId),
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

  async completeOperation(
    ownerId: string,
    chatId: string,
    operationId: string,
    rawResult: TaskOperationRelayResult,
    turnId: string | null,
  ): Promise<TaskOperationContext | null> {
    const result = taskOperationRelayResultSchema.parse(rawResult);
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
      if (
        !sameOperation(
          {
            ...round.relayRequest,
            fingerprint: result.fingerprint,
          },
          round.relayRequest,
        ) ||
        result.chatId !== chatId ||
        result.operationId !== operationId ||
        result.classification.kind !== round.kind ||
        result.classification.ordinal !== round.ordinal
      ) {
        throw new TaskConflictError(
          "The encrypted Task result does not match its operation.",
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
      if (round.relayResult) {
        if (round.relayResult.fingerprint !== result.fingerprint) {
          throw new TaskConflictError(
            "A different encrypted result already completed this operation.",
            "idempotency-conflict",
          );
        }
        return context(task, round);
      }
      if (
        task.activeOperationId !== operationId ||
        task.planningRound !== round.ordinal
      ) {
        throw new TaskConflictError(
          "A newer Task operation superseded this result.",
          "idempotency-conflict",
        );
      }
      const now = new Date();
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({
          ...roundColumns({
            classification: result.classification,
            protectedContent: result.protectedResult,
          }),
          relayResult: result,
          turnId,
          completedAt: now,
        })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      let updatedTask = task;
      if (round.kind !== "finalize") {
        const updatedTasks = await transaction
          .update(schema.tasks)
          .set({
            ...taskOpaqueColumns(result.task),
            activeOperationId: null,
            rowVersion: task.rowVersion + 1,
            updatedAt: now,
          })
          .where(eq(schema.tasks.chatId, chatId))
          .returning();
        updatedTask = updatedTasks[0]!;
      }
      return context(updatedTask, updatedRounds[0]!);
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
      if (!round?.relayResult || round.kind !== "finalize") return null;
      const taskRows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;
      if (
        task.state === "implementing" &&
        task.planningRound === round.ordinal &&
        task.activeOperationId === null
      ) {
        return context(task, round);
      }
      if (
        task.activeOperationId !== operationId &&
        !(task.state === "failed" && task.planningRound === round.ordinal)
      ) {
        throw new TaskConflictError(
          "A newer Task operation superseded Goal startup.",
          "idempotency-conflict",
        );
      }
      const now = new Date();
      const updated = await transaction
        .update(schema.tasks)
        .set({
          ...taskOpaqueColumns(round.relayResult.task),
          activeOperationId: null,
          implementationStartedAt: task.implementationStartedAt ?? now,
          rowVersion: task.rowVersion + 1,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return context(updated[0]!, round);
    });
  }

  async failOperation(
    ownerId: string,
    chatId: string,
    operationId: string,
    _legacyInput?: unknown,
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
      if (task.state === "failed" && task.planningRound === round.ordinal) {
        return context(task, round);
      }
      const now = new Date();
      const updatedRounds = await transaction
        .update(schema.taskPlanningRounds)
        .set({
          ...roundColumns(round.failureRound),
          completedAt: now,
        })
        .where(eq(schema.taskPlanningRounds.id, operationId))
        .returning();
      let updatedTask = task;
      if (task.planningRound === round.ordinal) {
        const updatedTasks = await transaction
          .update(schema.tasks)
          .set({
            ...taskOpaqueColumns(round.failureTask),
            activeOperationId: null,
            rowVersion: task.rowVersion + 1,
            updatedAt: now,
          })
          .where(eq(schema.tasks.chatId, chatId))
          .returning();
        updatedTask = updatedTasks[0]!;
      }
      return context(updatedTask, updatedRounds[0]!);
    });
  }

  async reconcileInterruptedOperations(): Promise<number> {
    const active = await this.database
      .select({ task: schema.tasks, round: schema.taskPlanningRounds })
      .from(schema.tasks)
      .innerJoin(
        schema.taskPlanningRounds,
        eq(schema.taskPlanningRounds.id, schema.tasks.activeOperationId),
      );
    for (const { task, round } of active) {
      await this.database.transaction(async (transaction) => {
        const now = new Date();
        await transaction
          .update(schema.taskPlanningRounds)
          .set({ ...roundColumns(round.failureRound), completedAt: now })
          .where(eq(schema.taskPlanningRounds.id, round.id));
        await transaction
          .update(schema.tasks)
          .set({
            ...taskOpaqueColumns(round.failureTask),
            activeOperationId: null,
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

  /** @deprecated Plaintext Task completion was removed by the E2EE cutover. */
  async completePlanningOperation(..._input: unknown[]): Promise<any> {
    throw new Error("Plaintext Task completion is unavailable.");
  }

  /** @deprecated Plaintext Task finalization was removed by the E2EE cutover. */
  async stageFinalizationResult(..._input: unknown[]): Promise<any> {
    throw new Error("Plaintext Task finalization is unavailable.");
  }

  /** @deprecated Use the stored encrypted finalization result. */
  async resumeFinalizationGoalLaunch(
    ownerId: string,
    chatId: string,
    _rowVersion: number,
  ): Promise<any> {
    return this.getOperationContext(ownerId, chatId, {
      operationId: (await this.get(ownerId, chatId))?.activeOperationId,
    });
  }

  async syncImplementationState(
    ownerId: string,
    chatId: string,
    input: { rowVersion: number; task: TaskOpaqueContent },
  ): Promise<TaskOpaqueSummary | null> {
    const next = taskOpaqueContentSchema.parse(input.task);
    if (!(await this.get(ownerId, chatId))) return null;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      const current = rows[0];
      if (!current) return null;
      if (current.rowVersion !== input.rowVersion) {
        throw new TaskConflictError(
          "The Task changed before its Goal status was synchronized.",
          "stale-version",
        );
      }
      if (
        !["implementing", "paused", "blocked", "complete", "failed"].includes(
          current.state,
        ) ||
        !["implementing", "paused", "blocked", "complete", "failed"].includes(
          next.classification.state,
        ) ||
        next.classification.activeOperationKind !== null ||
        next.classification.stableStateBeforeFailure !== null ||
        next.classification.planningRound !== current.planningRound ||
        next.classification.planAuthorship !== current.planAuthorship ||
        next.classification.hasPlan !== current.hasPlan ||
        next.classification.hasQuestions !== current.hasQuestions ||
        next.classification.hasFinalPlan !== current.hasFinalPlan ||
        next.classification.hasGoalPrompt !== current.hasGoalPrompt ||
        next.protectedContent.keyRevision !==
          current.protectedContent.keyRevision
      ) {
        throw new TaskConflictError(
          "The encrypted Goal update changes protected planning metadata.",
          "idempotency-conflict",
        );
      }
      if (
        current.state !== next.classification.state &&
        !canTransitionTaskState(current.state, next.classification.state)
      ) {
        throw new TaskStateTransitionError(
          current.state,
          next.classification.state,
        );
      }
      const unchanged =
        JSON.stringify({
          classification: {
            state: current.state,
            stableStateBeforeFailure: current.stableStateBeforeFailure,
            activeOperationKind: current.activeOperationKind,
            planAuthorship: current.planAuthorship,
            planningRound: current.planningRound,
            hasPlan: current.hasPlan,
            hasQuestions: current.hasQuestions,
            hasFinalPlan: current.hasFinalPlan,
            hasGoalPrompt: current.hasGoalPrompt,
            lastError: current.lastError,
          },
          protectedContent: current.protectedContent,
        }) === JSON.stringify(next);
      if (unchanged) return toTaskOpaqueSummary(current);
      const updated = await transaction
        .update(schema.tasks)
        .set({
          ...taskOpaqueColumns(next),
          rowVersion: current.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.chatId, chatId))
        .returning();
      return toTaskOpaqueSummary(updated[0]!);
    });
  }
}
