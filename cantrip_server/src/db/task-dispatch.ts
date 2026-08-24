import { randomUUID } from "node:crypto";

import {
  taskDispatchCycleListSchema,
  taskDispatchCycleSummarySchema,
  taskDispatchWorkerLeaseSchema,
  taskWorkerSummarySchema,
  type TaskDispatchCycleState,
  type TaskDispatchCycleSummary,
  type TaskDispatchEligibilityCode,
  type TaskDispatchFence,
  type TaskDispatchOperationKind,
  type TaskDispatchWorkerLease,
  type TaskWorkerSummary,
} from "@cantrip/protocol/task-scheduling";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import {
  TaskStateTransitionError,
  validateTaskOperationStart,
} from "../tasks/state.js";

type TaskDispatchDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TaskDispatchRow = typeof schema.taskDispatchCycles.$inferSelect;
type TaskWorkerRow = typeof schema.taskWorkers.$inferSelect;

export const TASK_DISPATCH_LEASE_MS = 2 * 60_000;

export class TaskDispatchNotFoundError extends Error {}

export class TaskDispatchConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "active-operation"
      | "idempotency-conflict"
      | "stale-lease"
      | "stale-version",
  ) {
    super(message);
    this.name = "TaskDispatchConflictError";
  }
}

export interface TaskDispatchEligibilityInput {
  cycle: TaskDispatchCycleSummary;
  projectId: string;
  physicalWorkerId: string;
  worktreeId: string;
  taskWorker: TaskWorkerSummary;
}

export type TaskDispatchEligibilityResult =
  | {
      eligible: true;
      modelRouteId: string;
      providerAccountId: string | null;
      codexThreadId?: string | null;
    }
  | { eligible: false; code: TaskDispatchEligibilityCode };

export type TaskDispatchEligibilityResolver = (
  input: TaskDispatchEligibilityInput,
) => Promise<TaskDispatchEligibilityResult>;

export interface ClaimedTaskDispatch {
  cycle: TaskDispatchCycleSummary;
  lease: TaskDispatchWorkerLease;
  projectId: string;
  taskWorker: TaskWorkerSummary;
}

function iso(value: Date): string {
  return value.toISOString();
}

function modelConfiguration(row: TaskWorkerRow) {
  return {
    modelId: row.modelId,
    reasoningEffort: row.reasoningEffort,
    customSubagentModel: row.customSubagentModel,
    subagentModelId: row.subagentModelId,
    subagentReasoningEffort: row.subagentReasoningEffort,
  };
}

function toTaskWorkerSummary(
  row: TaskWorkerRow,
  activeTaskCount: number,
): TaskWorkerSummary {
  return taskWorkerSummarySchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    modelConfiguration: modelConfiguration(row),
    maxConcurrency: row.maxConcurrency,
    allowsPlanGoal: row.allowsPlanGoal,
    continuityFamily: row.continuityFamily,
    continuityFamilyOverride: row.continuityFamilyOverride,
    position: row.position,
    activeTaskCount,
    rowVersion: row.rowVersion,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function toTaskDispatchCycleSummary(
  row: TaskDispatchRow,
): TaskDispatchCycleSummary {
  return taskDispatchCycleSummarySchema.parse({
    id: row.id,
    chatId: row.chatId,
    operationId: row.operationId,
    operationKind: row.operationKind,
    state: row.state,
    fifoCreatedAt: iso(row.fifoCreatedAt),
    requestedTaskWorkerId: row.requestedTaskWorkerId,
    selectedTaskWorkerId: row.selectedTaskWorkerId,
    taskWorkerRevision: row.taskWorkerRevision,
    continuityFamily: row.continuityFamily,
    modelConfiguration: row.modelConfiguration,
    modelRouteId: row.modelRouteId,
    providerAccountId: row.providerAccountId,
    physicalWorkerId: row.physicalWorkerId,
    worktreeId: row.worktreeId,
    codexThreadId: row.codexThreadId,
    turnId: row.turnId,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt ? iso(row.leaseExpiresAt) : null,
    lastHeartbeatAt: row.lastHeartbeatAt ? iso(row.lastHeartbeatAt) : null,
    fencingToken: row.fencingToken,
    attemptCount: row.attemptCount,
    eligibilityCode: row.eligibilityCode,
    queuedAt: iso(row.queuedAt),
    claimedAt: row.claimedAt ? iso(row.claimedAt) : null,
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    pausedAt: row.pausedAt ? iso(row.pausedAt) : null,
    completedAt: row.completedAt ? iso(row.completedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function assertOperationId(operationId: string): void {
  if (operationId.trim().length === 0 || operationId.length > 200) {
    throw new TypeError(
      "Task dispatch operation IDs must contain 1-200 characters.",
    );
  }
}

function fenceWhere(fence: TaskDispatchFence, now: Date) {
  return and(
    eq(schema.taskDispatchCycles.id, fence.cycleId),
    eq(schema.taskDispatchCycles.operationId, fence.operationId),
    eq(schema.taskDispatchCycles.leaseOwner, fence.leaseOwner),
    eq(schema.taskDispatchCycles.fencingToken, fence.fencingToken),
    sql`${schema.taskDispatchCycles.leaseExpiresAt} > ${now}`,
  );
}

export class TaskDispatchRepository {
  constructor(private readonly database: TaskDispatchDatabase) {}

  async get(
    ownerId: string,
    cycleId: string,
  ): Promise<TaskDispatchCycleSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, ownerId),
          eq(schema.taskDispatchCycles.id, cycleId),
        ),
      )
      .limit(1);
    return rows[0] ? toTaskDispatchCycleSummary(rows[0]) : null;
  }

  async list(ownerId: string): Promise<TaskDispatchCycleSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.taskDispatchCycles)
      .where(eq(schema.taskDispatchCycles.ownerId, ownerId))
      .orderBy(
        asc(schema.taskDispatchCycles.fifoCreatedAt),
        asc(schema.taskDispatchCycles.id),
      );
    return taskDispatchCycleListSchema.parse(
      rows.map(toTaskDispatchCycleSummary),
    );
  }

  async listSchedulerOwnerIds(): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ ownerId: schema.taskDispatchCycles.ownerId })
      .from(schema.taskDispatchCycles)
      .where(
        inArray(schema.taskDispatchCycles.state, [
          "queued",
          "claimed",
          "running",
        ]),
      )
      .orderBy(asc(schema.taskDispatchCycles.ownerId));
    return rows.map(({ ownerId }) => ownerId);
  }

  async enqueue(
    ownerId: string,
    chatId: string,
    operationId: string,
    operationKind: TaskDispatchOperationKind,
    rowVersion: number,
  ): Promise<TaskDispatchCycleSummary> {
    assertOperationId(operationId);
    return this.database.transaction(async (transaction) => {
      const ownerRows = await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      if (!ownerRows[0]) throw new TaskDispatchNotFoundError("Task not found.");
      const priorRows = await transaction
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, chatId),
            eq(schema.taskDispatchCycles.operationId, operationId),
          ),
        )
        .limit(1);
      const prior = priorRows[0];
      if (prior) {
        if (prior.operationKind !== operationKind) {
          throw new TaskDispatchConflictError(
            "This Task operation ID was already used for another operation.",
            "idempotency-conflict",
          );
        }
        return toTaskDispatchCycleSummary(prior);
      }
      const taskRows = await transaction
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
      const task = taskRows[0]?.task;
      if (!task) throw new TaskDispatchNotFoundError("Task not found.");
      if (task.rowVersion !== rowVersion) {
        throw new TaskDispatchConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      }
      if (operationKind !== "goal-continuation") {
        if ((operationKind === "direct") === task.planGoalEnabled) {
          throw new TaskDispatchConflictError(
            task.planGoalEnabled
              ? "Disable Plan + Goal before queueing this Task directly."
              : "Enable Plan + Goal before queueing a planning operation.",
            "idempotency-conflict",
          );
        }
        try {
          validateTaskOperationStart(
            task.state,
            task.stableStateBeforeFailure,
            operationKind,
          );
        } catch (error) {
          if (error instanceof TaskStateTransitionError) {
            throw new TaskDispatchConflictError(
              error.message,
              "idempotency-conflict",
            );
          }
          throw error;
        }
      }

      const activeRows = await transaction
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.chatId, chatId),
            inArray(schema.taskDispatchCycles.state, [
              "queued",
              "claimed",
              "running",
              "paused",
            ]),
          ),
        )
        .limit(1);
      const active = activeRows[0];
      if (active?.operationId === operationId)
        return toTaskDispatchCycleSummary(active);
      if (active) {
        throw new TaskDispatchConflictError(
          "The Task already has an active scheduled operation.",
          "active-operation",
        );
      }

      const rows = await transaction
        .insert(schema.taskDispatchCycles)
        .values({
          id: randomUUID(),
          ownerId,
          chatId,
          operationId,
          operationKind,
          state: "queued",
          fifoCreatedAt: task.createdAt,
          requestedTaskWorkerId: task.requestedTaskWorkerId,
        })
        .returning();
      return toTaskDispatchCycleSummary(rows[0]!);
    });
  }

  async claimNext(
    ownerId: string,
    leaseOwner: string,
    resolveEligibility: TaskDispatchEligibilityResolver,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<ClaimedTaskDispatch | null> {
    if (leaseOwner.trim().length === 0 || leaseOwner.length > 200) {
      throw new TypeError(
        "Task dispatch lease owners must contain 1-200 characters.",
      );
    }
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? TASK_DISPATCH_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new TypeError("Task dispatch lease duration must be positive.");
    }

    return this.database.transaction(async (transaction) => {
      const ownerRows = await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      if (!ownerRows[0]) return null;

      const [workerRows, activeCounts, candidateRows, activeLanes] =
        await Promise.all([
          transaction
            .select()
            .from(schema.taskWorkers)
            .where(
              and(
                eq(schema.taskWorkers.ownerId, ownerId),
                eq(schema.taskWorkers.enabled, true),
                isNull(schema.taskWorkers.deletedAt),
              ),
            )
            .orderBy(
              asc(schema.taskWorkers.position),
              asc(schema.taskWorkers.id),
            ),
          transaction
            .select({
              taskWorkerId: schema.taskDispatchCycles.selectedTaskWorkerId,
              count: sql<number>`count(*)::int`,
            })
            .from(schema.taskDispatchCycles)
            .where(
              and(
                eq(schema.taskDispatchCycles.ownerId, ownerId),
                inArray(schema.taskDispatchCycles.state, [
                  "claimed",
                  "running",
                ]),
              ),
            )
            .groupBy(schema.taskDispatchCycles.selectedTaskWorkerId),
          transaction
            .select({
              cycle: schema.taskDispatchCycles,
              task: schema.tasks,
              projectId: schema.projects.id,
              projectPaused: schema.projects.taskSchedulingPaused,
              archivedAt: schema.chats.archivedAt,
              worktreeId: schema.projectWorktrees.id,
              worktreeState: schema.projectWorktrees.lifecycleState,
              physicalWorkerId: schema.projectWorktrees.workerId,
              physicalWorkerUnlinkedAt: schema.workers.unlinkedAt,
            })
            .from(schema.taskDispatchCycles)
            .innerJoin(
              schema.tasks,
              eq(schema.tasks.chatId, schema.taskDispatchCycles.chatId),
            )
            .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
            .innerJoin(
              schema.projects,
              and(
                eq(schema.projects.id, schema.chats.projectId),
                eq(schema.projects.ownerId, ownerId),
              ),
            )
            .innerJoin(
              schema.projectWorktrees,
              eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
            )
            .innerJoin(
              schema.workers,
              eq(schema.workers.id, schema.projectWorktrees.workerId),
            )
            .where(
              and(
                eq(schema.taskDispatchCycles.ownerId, ownerId),
                eq(schema.taskDispatchCycles.state, "queued"),
              ),
            )
            .orderBy(
              asc(schema.taskDispatchCycles.fifoCreatedAt),
              asc(schema.taskDispatchCycles.id),
            ),
          transaction
            .select({ chatId: schema.chatExecutionLanes.chatId })
            .from(schema.chatExecutionLanes)
            .where(
              inArray(schema.chatExecutionLanes.state, [
                "active",
                "delivering",
              ]),
            ),
        ]);

      const activeByWorker = new Map(
        activeCounts.flatMap(({ taskWorkerId, count }) =>
          taskWorkerId ? [[taskWorkerId, count] as const] : [],
        ),
      );
      const activeChatIds = new Set(activeLanes.map(({ chatId }) => chatId));
      const reasons = new Map<string, TaskDispatchEligibilityCode>();

      for (const worker of workerRows) {
        const activeTaskCount = activeByWorker.get(worker.id) ?? 0;
        if (activeTaskCount >= worker.maxConcurrency) {
          for (const candidate of candidateRows) {
            if (
              candidate.cycle.requestedTaskWorkerId === worker.id ||
              candidate.cycle.requestedTaskWorkerId === null
            ) {
              reasons.set(candidate.cycle.id, "capacity-unavailable");
            }
          }
          continue;
        }
        const taskWorker = toTaskWorkerSummary(worker, activeTaskCount);

        for (const candidate of candidateRows) {
          const { cycle, task } = candidate;
          if (candidate.projectPaused) {
            reasons.set(cycle.id, "project-paused");
            continue;
          }
          if (candidate.archivedAt || activeChatIds.has(cycle.chatId)) continue;
          if (
            cycle.requestedTaskWorkerId !== null &&
            cycle.requestedTaskWorkerId !== worker.id
          ) {
            continue;
          }
          if (task.planGoalEnabled && !worker.allowsPlanGoal) {
            reasons.set(cycle.id, "plan-goal-unsupported");
            continue;
          }
          if (
            cycle.requestedTaskWorkerId === null &&
            task.continuityFamily !== null &&
            task.continuityFamily !== worker.continuityFamily
          ) {
            reasons.set(cycle.id, "continuity-mismatch");
            continue;
          }
          if (
            candidate.worktreeState !== "ready" ||
            candidate.physicalWorkerUnlinkedAt !== null
          ) {
            reasons.set(cycle.id, "placement-unavailable");
            continue;
          }

          const resolution = await resolveEligibility({
            cycle: toTaskDispatchCycleSummary(cycle),
            projectId: candidate.projectId,
            physicalWorkerId: candidate.physicalWorkerId,
            worktreeId: candidate.worktreeId,
            taskWorker,
          });
          if (!resolution.eligible) {
            reasons.set(cycle.id, resolution.code);
            continue;
          }

          const leaseExpiresAt = new Date(now.getTime() + leaseMs);
          const fencingToken = cycle.fencingToken + 1;
          const claimedRows = await transaction
            .update(schema.taskDispatchCycles)
            .set({
              state: "claimed",
              selectedTaskWorkerId: worker.id,
              taskWorkerRevision: worker.rowVersion,
              continuityFamily: worker.continuityFamily,
              modelConfiguration: modelConfiguration(worker),
              modelRouteId: resolution.modelRouteId,
              providerAccountId: resolution.providerAccountId,
              physicalWorkerId: candidate.physicalWorkerId,
              worktreeId: candidate.worktreeId,
              codexThreadId: resolution.codexThreadId ?? null,
              leaseOwner,
              leaseExpiresAt,
              lastHeartbeatAt: now,
              fencingToken,
              attemptCount: cycle.attemptCount + 1,
              eligibilityCode: null,
              claimedAt: now,
              pausedAt: null,
              completedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.taskDispatchCycles.id, cycle.id),
                eq(schema.taskDispatchCycles.state, "queued"),
                eq(schema.taskDispatchCycles.fencingToken, cycle.fencingToken),
              ),
            )
            .returning();
          const claimed = claimedRows[0];
          if (!claimed) continue;

          await transaction
            .update(schema.tasks)
            .set({
              lastTaskWorkerId: worker.id,
              continuityFamily:
                task.requestedTaskWorkerId === null
                  ? (task.continuityFamily ?? worker.continuityFamily)
                  : task.continuityFamily,
              schedulerRevision: sql`${schema.tasks.schedulerRevision} + 1`,
              updatedAt: now,
            })
            .where(eq(schema.tasks.chatId, cycle.chatId));

          const claimedCycle = toTaskDispatchCycleSummary(claimed);
          const lease = taskDispatchWorkerLeaseSchema.parse({
            cycleId: claimed.id,
            operationId: claimed.operationId,
            leaseOwner,
            leaseExpiresAt: iso(leaseExpiresAt),
            fencingToken,
          });
          return {
            cycle: claimedCycle,
            lease,
            projectId: candidate.projectId,
            taskWorker,
          };
        }
      }

      if (workerRows.length === 0) {
        for (const candidate of candidateRows) {
          reasons.set(candidate.cycle.id, "task-worker-disabled");
        }
      }
      for (const [cycleId, eligibilityCode] of reasons) {
        await transaction
          .update(schema.taskDispatchCycles)
          .set({ eligibilityCode, updatedAt: now })
          .where(
            and(
              eq(schema.taskDispatchCycles.id, cycleId),
              eq(schema.taskDispatchCycles.state, "queued"),
            ),
          );
      }
      return null;
    });
  }

  async markRunning(
    fence: TaskDispatchFence,
    options: { now?: Date; turnId?: string | null } = {},
  ): Promise<TaskDispatchCycleSummary> {
    const now = options.now ?? new Date();
    const rows = await this.database
      .update(schema.taskDispatchCycles)
      .set({
        state: "running",
        startedAt: now,
        turnId: options.turnId,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          fenceWhere(fence, now),
          eq(schema.taskDispatchCycles.state, "claimed"),
        ),
      )
      .returning();
    if (!rows[0]) throw this.staleLease();
    return toTaskDispatchCycleSummary(rows[0]);
  }

  async heartbeat(
    fence: TaskDispatchFence,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<TaskDispatchWorkerLease> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? TASK_DISPATCH_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new TypeError("Task dispatch lease duration must be positive.");
    }
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const rows = await this.database
      .update(schema.taskDispatchCycles)
      .set({ leaseExpiresAt, lastHeartbeatAt: now, updatedAt: now })
      .where(
        and(
          fenceWhere(fence, now),
          inArray(schema.taskDispatchCycles.state, ["claimed", "running"]),
        ),
      )
      .returning({ id: schema.taskDispatchCycles.id });
    if (!rows[0]) throw this.staleLease();
    return taskDispatchWorkerLeaseSchema.parse({
      ...fence,
      leaseExpiresAt: iso(leaseExpiresAt),
    });
  }

  async settle(
    fence: TaskDispatchFence,
    state: Extract<
      TaskDispatchCycleState,
      "succeeded" | "failed" | "cancelled" | "expired"
    >,
    options: { now?: Date } = {},
  ): Promise<TaskDispatchCycleSummary> {
    const now = options.now ?? new Date();
    const rows = await this.database
      .update(schema.taskDispatchCycles)
      .set({ state, completedAt: now, updatedAt: now })
      .where(
        and(
          fenceWhere(fence, now),
          inArray(schema.taskDispatchCycles.state, ["claimed", "running"]),
        ),
      )
      .returning();
    if (!rows[0]) throw this.staleLease();
    return toTaskDispatchCycleSummary(rows[0]);
  }

  async requeueExpiredLeases(
    ownerId: string,
    now = new Date(),
  ): Promise<TaskDispatchCycleSummary[]> {
    const rows = await this.database
      .update(schema.taskDispatchCycles)
      .set({
        state: "queued",
        selectedTaskWorkerId: null,
        taskWorkerRevision: null,
        continuityFamily: null,
        modelConfiguration: null,
        modelRouteId: null,
        providerAccountId: null,
        physicalWorkerId: null,
        worktreeId: null,
        codexThreadId: null,
        turnId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        fencingToken: sql`${schema.taskDispatchCycles.fencingToken} + 1`,
        eligibilityCode: "reconciliation-required",
        claimedAt: null,
        startedAt: null,
        pausedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, ownerId),
          inArray(schema.taskDispatchCycles.state, ["claimed", "running"]),
          lte(schema.taskDispatchCycles.leaseExpiresAt, now),
        ),
      )
      .returning();
    return taskDispatchCycleListSchema.parse(
      rows.map(toTaskDispatchCycleSummary),
    );
  }

  private staleLease(): TaskDispatchConflictError {
    return new TaskDispatchConflictError(
      "The Task dispatch lease is stale or no longer active.",
      "stale-lease",
    );
  }
}
