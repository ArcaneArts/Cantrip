import type { TaskFailureKind } from "@cantrip/protocol/tasks";
import { randomUUID } from "node:crypto";
import { TaskGoalInferenceInputRepository } from "./task-goal-inference-inputs.js";
import { TaskGoalCycleRecoveryRepository } from "./task-goal-cycle-recovery.js";
import { bindTaskNativeInput } from "./task-native-input-binding.js";
import {
  taskInferenceInputReceiptSchema,
  type InferenceFailureEvidence,
  type TaskInferenceInputReceipt,
  inferenceNeverStarted,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
  type TaskInferenceRouteChange,
  type TaskInferenceRouteChangeRequest,
  taskInferenceRouteChangeSchema,
  modelConfigurationSchema,
  inferenceNativeExecutionSchema,
  type InferenceNativeExecution,
  type TaskTurnResumption,
  type TaskDispatchFence,
} from "@cantrip/protocol";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import type { ChatExecutionLaneRepository } from "./repository/chat-execution-lanes.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { nativeRuntimeHandoffInventory } from "./repository/native-runtime-handoff-inventory.js";
import {
  assertTaskOperationDispatchFence,
  type TaskOperationDispatchFence,
} from "./task-operation-fence.js";
import { NativeSuspensionRepository } from "./repository/native-suspensions.js";
import { isDeepStrictEqual } from "node:util";
import {
  currentTaskInputExecution,
  taskCheckpointExecution,
} from "./task-input-execution-state.js";

/** Metadata on the canonical round, never another copy/queue of its input.
 * Sticky dispatch evidence survives route retries: a later unstarted attempt
 * cannot authorize replay of an earlier possibly executed attempt. */
export interface TaskInferenceInputState {
  /** Only the current physical Resume attempt may produce native admission or
   * terminal projection. The original receipt remains the checkpoint source. */
  resumption?: TaskInferenceResumption;
  nativeExecution?: InferenceNativeExecution;
  claimWorkerGeneration?: string;
  nativeOwner?: { workerGeneration: string; runtimeGeneration: string };
  routeChange?: TaskInferenceRouteChange;
  receipt: TaskInferenceInputReceipt;
  deferred: boolean;
  accepted: boolean;
  dispatched: boolean;
  allAttemptsEnforced: boolean;
  firstDispatchedOperationId: string | null;
  multipleDispatched: boolean;
  attemptCountBefore: number;
  /** A positive terminal worker failure, not a transport observation timeout. */
  failedBeforeDispatch?: boolean;
  /** Bounded terminal receipt metadata on the existing input. Goal projection
   * and round completion keep their own authority; this cannot launch input. */
  terminal?: {
    ok: boolean;
    failureKind: TaskFailureKind | null;
    /** Round completion's canonical protected-outcome identity; no response copy. */
    outcomeDigest?: string;
    /** Historical persistence must never replay Task/lane/dispatch mutations. */
    historyOnly?: boolean;
    observedAt: string;
    projectedAt: string | null;
    threadId: string | null;
    turnId: string | null;
  };
}

export type TaskInferenceResumption = Pick<
  TaskInferenceInputState,
  | "receipt"
  | "accepted"
  | "dispatched"
  | "claimWorkerGeneration"
  | "nativeExecution"
  | "nativeOwner"
> & {
  controlId: string;
  checkpointOwner?: {
    receipt: TaskInferenceInputReceipt;
    nativeExecution: InferenceNativeExecution;
    nativeOwner: { workerGeneration: string; runtimeGeneration: string };
  };
};

function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task input receipt was replaced or revoked.",
    "stale-lease",
  );
}

export class TaskInferenceInputRepository {
  readonly goals: TaskGoalInferenceInputRepository;
  readonly goalCycles: TaskGoalCycleRecoveryRepository;
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes?: ChatExecutionLaneRepository,
    messages?: MessageWriteRepository,
  ) {
    this.goalCycles = new TaskGoalCycleRecoveryRepository(database);
    this.goals = new TaskGoalInferenceInputRepository(
      database,
      lanes,
      messages,
    );
  }

  private async context(
    tx: RepositoryTransaction,
    ownerId: string,
    receipt: TaskInferenceInputReceipt,
  ) {
    await tx.execute(projectChatExecutionLock(ownerId, receipt.chatId));
    const [round] = await tx
      .select()
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.id, receipt.dispatch.operationId),
          eq(schema.taskPlanningRounds.chatId, receipt.chatId),
        ),
      )
      .for("update")
      .limit(1);
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.chatId, receipt.chatId))
      .for("update")
      .limit(1);
    const [placement] = await tx
      .select({ chat: schema.chats, project: schema.projects })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chats.id, receipt.chatId))
      .limit(1);
    const [lane] = await tx
      .select()
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.id, receipt.executionLaneId),
          eq(schema.chatExecutionLanes.chatId, receipt.chatId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !round ||
      !task ||
      !placement ||
      !lane ||
      task.activeOperationId !== round.id ||
      round.status !== "running" ||
      round.relayRequest.userMessage.id !== receipt.clientMessageId ||
      (round.userMessageId !== null &&
        round.userMessageId !== receipt.clientMessageId) ||
      round.relayResult !== null ||
      round.assistantMessageId !== null ||
      round.turnId !== null ||
      lane.activatedAt?.toISOString() !== receipt.executionLaneActivatedAt ||
      lane.workerId !== receipt.workerId ||
      lane.worktreeId !== receipt.worktreeId ||
      placement.chat.archivedAt !== null ||
      ["complete", "failed"].includes(task.state)
    )
      return stale();
    return { round, task, lane, ...placement };
  }

  private async deferLocked(
    tx: RepositoryTransaction,
    ownerId: string,
    state: TaskInferenceInputState,
  ): Promise<void> {
    if (state.failedBeforeDispatch) stale();
    const receipt = state.receipt;
    const chatId = receipt.chatId;
    const { round, task, lane, chat, project } = await this.context(
      tx,
      ownerId,
      receipt,
    );
    // A transferred input starts a fresh command, never resumes the old bound
    // native session. User/project pause flags still gate claiming that command.
    const transferred =
      state.routeChange?.inputOperationId === receipt.operationId;
    const paused =
      !transferred &&
      (chat.automationPaused ||
        project.taskSchedulingPaused ||
        task.state === "paused");
    await this.lanes!.inTransaction(tx).finishChatExecutionLane(
      chatId,
      lane.id,
      "idle",
      {
        expectedActivatedAt: receipt.executionLaneActivatedAt,
        markUnreadCompletion: false,
      },
    );
    // A preceding failure observer may already have suspended this exact
    // activation. Never change the status of a newer active activation.
    const [active] = await tx
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .limit(1);
    if (!active)
      await tx
        .update(schema.chats)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(schema.chats.id, chatId));
    const now = new Date();
    await tx
      .update(schema.taskPlanningRounds)
      .set({ inferenceInput: { ...state, deferred: true } })
      .where(eq(schema.taskPlanningRounds.id, round.id));
    await tx
      .update(schema.taskDispatchCycles)
      .set({
        state: paused ? "paused" : "queued",
        ...(paused
          ? {}
          : {
              selectedTaskWorkerId: null,
              taskWorkerRevision: null,
              continuityFamily: null,
              modelConfiguration: null,
              modelRouteId: null,
              providerAccountId: null,
              physicalWorkerId: null,
              worktreeId: null,
              codexThreadId: null,
            }),
        turnId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        fencingToken: sql`${schema.taskDispatchCycles.fencingToken}+1`,
        attemptCount: state.attemptCountBefore,
        eligibilityCode: "capacity-unavailable",
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        pausedAt: paused ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId));
  }

  async routeView(ownerId: string, chatId: string) {
    const [owned] = await this.database
      .select({ task: schema.tasks, archivedAt: schema.chats.archivedAt })
      .from(schema.tasks)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
      .where(
        and(eq(schema.tasks.chatId, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!owned) return null;
    const [currentRound] = owned.task.activeOperationId
      ? await this.database
          .select({ state: schema.taskPlanningRounds.inferenceInput })
          .from(schema.taskPlanningRounds)
          .where(
            and(
              eq(schema.taskPlanningRounds.chatId, chatId),
              eq(schema.taskPlanningRounds.id, owned.task.activeOperationId),
              eq(schema.taskPlanningRounds.status, "running"),
            ),
          )
          .limit(1)
      : [];
    const [latestRound] = await this.database
      .select({ state: schema.taskPlanningRounds.inferenceInput })
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.chatId, chatId),
          sql`${schema.taskPlanningRounds.inferenceInput} ? 'routeChange'`,
        ),
      )
      .orderBy(desc(schema.taskPlanningRounds.ordinal))
      .limit(1);
    const current = currentRound?.state;
    const latest = latestRound?.state?.routeChange ?? null;
    const inventory = await nativeRuntimeHandoffInventory(
      this.database,
      ownerId,
      chatId,
      null,
    );
    return {
      chatId,
      revision: owned.task.rowVersion,
      source:
        !owned.archivedAt &&
        !["complete", "failed"].includes(owned.task.state) &&
        current?.accepted &&
        current.allAttemptsEnforced &&
        !current.receipt.kind &&
        !current.failedBeforeDispatch &&
        current.firstDispatchedOperationId === null
          ? current.receipt
          : null,
      latest,
      providers: inventory?.providers ?? [],
    };
  }

  /** Revoke primary dispatch authority under its existing locks. The worker's
   * physical settlement acknowledgement is still required before re-eligibility. */
  async changeRoute(
    ownerId: string,
    chatId: string,
    input: TaskInferenceRouteChangeRequest,
  ) {
    if (!this.lanes)
      throw new Error("Task route changes require execution lane ownership.");
    return this.database.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update");
      await tx.execute(projectChatExecutionLock(ownerId, chatId));
      const [item] = await tx
        .select({ round: schema.taskPlanningRounds, task: schema.tasks })
        .from(schema.taskPlanningRounds)
        .innerJoin(
          schema.tasks,
          and(
            eq(schema.tasks.chatId, chatId),
            eq(schema.tasks.activeOperationId, schema.taskPlanningRounds.id),
          ),
        )
        .innerJoin(
          schema.chats,
          and(
            eq(schema.chats.id, schema.tasks.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .where(eq(schema.taskPlanningRounds.chatId, chatId))
        .limit(1);
      const state = item?.round.inferenceInput;
      if (!item || !state) stale();
      const prior = state!.routeChange;
      if (prior?.operationId === input.operationId) {
        if (
          prior.inputOperationId !== input.inputOperationId ||
          prior.expectedRevision !== input.expectedRevision ||
          prior.targetModelRouteId !== input.targetModelRouteId ||
          prior.targetProviderAccountId !== input.targetProviderAccountId
        )
          throw new TaskDispatchConflictError(
            "The route-change request changed identity.",
            "idempotency-conflict",
          );
        return prior;
      }
      if (item!.task.rowVersion !== input.expectedRevision)
        throw new TaskDispatchConflictError(
          "The Task changed in another client.",
          "stale-version",
        );
      if (
        prior?.phase === "draining" ||
        state!.receipt.operationId !== input.inputOperationId ||
        state!.receipt.kind ||
        !state!.accepted ||
        !state!.allAttemptsEnforced ||
        state!.failedBeforeDispatch ||
        state!.firstDispatchedOperationId !== null
      )
        stale();
      const source = state!.receipt;
      const alreadySettled =
        state!.deferred &&
        prior?.phase === "completed" &&
        prior.source.operationId === source.operationId;
      if (
        input.targetModelRouteId ===
          (alreadySettled ? prior!.targetModelRouteId : source.modelRouteId) &&
        input.targetProviderAccountId ===
          (alreadySettled
            ? prior!.targetProviderAccountId
            : source.providerAccountId)
      )
        throw new TaskDispatchConflictError(
          "The queued Task already uses that route and account.",
          "stale-version",
        );
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.id, source.dispatch.cycleId),
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, chatId),
            eq(schema.taskDispatchCycles.operationId, item!.round.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!cycle) stale();
      if (
        ["queued", "paused"].includes(cycle!.state) &&
        cycle!.fencingToken > source.dispatch.fencingToken
      ) {
        // A previous deferral or Pause already revoked this exact old source.
      } else {
        await assertTaskOperationDispatchFence(
          tx,
          ownerId,
          chatId,
          item!.round.id,
          { kind: "leased", lease: source.dispatch },
        );
      }
      await this.context(tx, ownerId, source);
      const [target] = await tx
        .select({
          modelId: schema.modelRoutes.modelId,
          providerId: schema.modelRoutes.providerId,
          kind: schema.modelProviders.kind,
        })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProfiles,
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
        )
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
        )
        .where(
          and(
            eq(schema.modelRoutes.id, input.targetModelRouteId),
            eq(schema.modelRoutes.enabled, true),
            eq(schema.modelProfiles.ownerId, ownerId),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!target)
        throw new TaskDispatchConflictError(
          "The configured destination no longer exists.",
          "stale-version",
        );
      const accountProvider =
        target.kind === "chatgpt" || target.kind === "grok";
      if (accountProvider !== (input.targetProviderAccountId !== null))
        throw new TaskDispatchConflictError(
          "Select an account belonging to the destination provider.",
          "stale-version",
        );
      if (input.targetProviderAccountId) {
        const [account] = await tx
          .select({ id: schema.modelProviderAccounts.id })
          .from(schema.modelProviderAccounts)
          .where(
            and(
              eq(
                schema.modelProviderAccounts.id,
                input.targetProviderAccountId,
              ),
              eq(schema.modelProviderAccounts.providerId, target.providerId),
              eq(schema.modelProviderAccounts.enabled, true),
            ),
          )
          .limit(1);
        if (!account)
          throw new TaskDispatchConflictError(
            "The destination account no longer exists.",
            "stale-version",
          );
      }
      const now = new Date();
      const change = taskInferenceRouteChangeSchema.parse({
        ...input,
        source,
        phase: alreadySettled ? "completed" : "draining",
        queuedFencingToken: cycle!.fencingToken + 1,
        createdAt: now.toISOString(),
        completedAt: alreadySettled ? now.toISOString() : null,
      });
      await this.deferLocked(tx, ownerId, { ...state!, routeChange: change });
      const configuration = modelConfigurationSchema.parse({
        ...item!.task.modelConfiguration,
        modelId: target.modelId,
        reasoningEffort: null,
      });
      await tx
        .update(schema.tasks)
        .set({
          modelConfiguration: configuration,
          schedulerRevision: sql`${schema.tasks.schedulerRevision}+1`,
          rowVersion: sql`${schema.tasks.rowVersion}+1`,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, chatId));
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          eligibilityCode: alreadySettled ? null : "provider-transfer-pending",
        })
        .where(eq(schema.taskDispatchCycles.id, cycle!.id));
      return change;
    });
  }

  async pendingRouteChanges(ownerId: string, workerId: string, after?: string) {
    const rows = await this.database
      .select({ input: schema.taskPlanningRounds.inferenceInput })
      .from(schema.taskPlanningRounds)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.taskPlanningRounds.chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .where(
        and(
          sql`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->>'phase' = 'draining'`,
          sql`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->'source'->>'workerId' = ${workerId}`,
          after ? gt(schema.taskPlanningRounds.id, after) : undefined,
        ),
      )
      .orderBy(asc(schema.taskPlanningRounds.id))
      .limit(100);
    return rows.map((row) =>
      taskInferenceRouteChangeSchema.parse(row.input?.routeChange),
    );
  }

  async routeChangeScopes() {
    return this.database
      .selectDistinct({
        ownerId: schema.chats.ownerId,
        workerId: sql<string>`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->'source'->>'workerId'`,
      })
      .from(schema.taskPlanningRounds)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.taskPlanningRounds.chatId),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.ownerId, schema.chats.ownerId),
          sql`${schema.workers.id} = ${schema.taskPlanningRounds.inferenceInput}->'routeChange'->'source'->>'workerId'`,
        ),
      )
      .where(
        sql`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->>'phase' = 'draining'`,
      );
  }

  /** Only current queued destinations and draining intents are read; completed
   * history never becomes a scheduler-wide in-memory receipt ledger. */
  async routeSchedulingState(ownerId: string) {
    const [pending, routes] = await Promise.all([
      this.database
        .selectDistinct({ chatId: schema.taskPlanningRounds.chatId })
        .from(schema.taskPlanningRounds)
        .innerJoin(
          schema.chats,
          and(
            eq(schema.chats.id, schema.taskPlanningRounds.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .where(
          sql`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->>'phase' = 'draining'`,
        ),
      this.database
        .select({
          cycleId: schema.taskDispatchCycles.id,
          state: schema.taskPlanningRounds.inferenceInput,
        })
        .from(schema.taskDispatchCycles)
        .innerJoin(
          schema.taskPlanningRounds,
          and(
            eq(
              schema.taskPlanningRounds.id,
              schema.taskDispatchCycles.operationId,
            ),
            eq(
              schema.taskPlanningRounds.chatId,
              schema.taskDispatchCycles.chatId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            inArray(schema.taskDispatchCycles.state, ["queued", "paused"]),
            sql`${schema.taskPlanningRounds.inferenceInput}->'routeChange'->>'phase' = 'completed'`,
            sql`${schema.taskPlanningRounds.inferenceInput}->>'deferred' = 'true'`,
            sql`${schema.taskPlanningRounds.inferenceInput}->'receipt'->>'operationId' = ${schema.taskPlanningRounds.inferenceInput}->'routeChange'->>'inputOperationId'`,
          ),
        ),
    ]);
    return {
      pendingChats: new Set(pending.map((row) => row.chatId)),
      routes: new Map(
        routes.map((row) => [
          row.cycleId,
          taskInferenceRouteChangeSchema.parse(row.state?.routeChange),
        ]),
      ),
    };
  }

  async completeRouteChange(
    ownerId: string,
    workerId: string,
    change: TaskInferenceRouteChange,
  ) {
    return this.database.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update");
      await tx.execute(projectChatExecutionLock(ownerId, change.source.chatId));
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.id, change.source.dispatch.cycleId),
            eq(schema.taskDispatchCycles.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const [round] = await tx
        .select({
          round: schema.taskPlanningRounds,
          task: schema.tasks,
          archivedAt: schema.chats.archivedAt,
        })
        .from(schema.taskPlanningRounds)
        .innerJoin(
          schema.chats,
          and(
            eq(schema.chats.id, schema.taskPlanningRounds.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .innerJoin(
          schema.tasks,
          eq(schema.tasks.chatId, schema.taskPlanningRounds.chatId),
        )
        .where(
          eq(schema.taskPlanningRounds.id, change.source.dispatch.operationId),
        )
        .for("update")
        .limit(1);
      const state = round?.round.inferenceInput;
      if (!state?.routeChange) return;
      if (
        state.routeChange.operationId !== change.operationId ||
        change.source.workerId !== workerId ||
        JSON.stringify(state.routeChange.source) !==
          JSON.stringify(change.source)
      )
        stale();
      if (state.routeChange.phase !== "draining") return;
      const now = new Date();
      const current =
        round!.task.activeOperationId === change.source.dispatch.operationId &&
        !round!.archivedAt &&
        !["complete", "failed"].includes(round!.task.state) &&
        cycle &&
        cycle.chatId === change.source.chatId &&
        cycle.operationId === change.source.dispatch.operationId &&
        state.deferred &&
        state.receipt.operationId === change.inputOperationId &&
        ["queued", "paused"].includes(cycle.state);
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          inferenceInput: {
            ...state,
            routeChange: {
              ...state.routeChange,
              phase: current ? "completed" : "cancelled",
              completedAt: now.toISOString(),
              queuedFencingToken: current
                ? cycle!.fencingToken
                : state.routeChange.queuedFencingToken,
            },
          },
        })
        .where(
          eq(schema.taskPlanningRounds.id, change.source.dispatch.operationId),
        );
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          eligibilityCode: null,
          updatedAt: now,
          ...(current && cycle!.state === "paused"
            ? {
                state: "queued" as const,
                pausedAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                selectedTaskWorkerId: null,
                taskWorkerRevision: null,
                continuityFamily: null,
                modelConfiguration: null,
                modelRouteId: null,
                providerAccountId: null,
                physicalWorkerId: null,
                worktreeId: null,
                codexThreadId: null,
              }
            : {}),
        })
        .where(
          and(
            eq(schema.taskDispatchCycles.id, change.source.dispatch.cycleId),
            current && cycle!.state === "paused"
              ? undefined
              : eq(
                  schema.taskDispatchCycles.eligibilityCode,
                  "provider-transfer-pending",
                ),
          ),
        );
      await tx
        .update(schema.tasks)
        .set({
          schedulerRevision: sql`${schema.tasks.schedulerRevision}+1`,
          rowVersion: sql`${schema.tasks.rowVersion}+1`,
          updatedAt: now,
        })
        .where(eq(schema.tasks.chatId, change.source.chatId));
    });
  }

  async prepare(
    ownerId: string,
    input: Omit<TaskInferenceInputReceipt, "operationId">,
    expectedInputRevision?: number,
  ): Promise<TaskInferenceInputReceipt> {
    if (input.kind === "goal")
      return this.goals.prepare(ownerId, input, expectedInputRevision);
    const receipt = taskInferenceInputReceiptSchema.parse({
      ...input,
      operationId: randomUUID(),
    });
    const prepared = await this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        ownerId,
        receipt.chatId,
        receipt.dispatch.operationId,
        { kind: "leased", lease: receipt.dispatch },
      );
      const { round, task, lane, chat, project } = await this.context(
        tx,
        ownerId,
        receipt,
      );
      const controlChanged =
        expectedInputRevision !== undefined &&
        chat.managedInputRevision !== expectedInputRevision;
      if (
        lane.state !== "active" ||
        (!controlChanged &&
          (chat.automationPaused ||
            project.taskSchedulingPaused ||
            task.state === "paused"))
      )
        stale();
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId))
        .limit(1);
      if (
        !cycle ||
        cycle.physicalWorkerId !== receipt.workerId ||
        cycle.worktreeId !== receipt.worktreeId
      )
        stale();
      // A Stop creates a new eligibility episode even if its older worker
      // command/queue record has not yet acknowledged cancellation.
      receipt.queueOrderEpoch = cycle.goalOrderEpoch;
      const previous = round.inferenceInput;
      if (
        previous?.failedBeforeDispatch &&
        previous.receipt.dispatch.cycleId === receipt.dispatch.cycleId &&
        previous.receipt.dispatch.fencingToken === receipt.dispatch.fencingToken
      )
        stale();
      const state: TaskInferenceInputState = {
        ...(previous?.routeChange ? { routeChange: previous.routeChange } : {}),
        receipt,
        deferred: false,
        failedBeforeDispatch: false,
        accepted: false,
        dispatched: false,
        allAttemptsEnforced:
          previous === null ||
          (previous.allAttemptsEnforced === true &&
            (previous.accepted === true || previous.deferred === true)),
        firstDispatchedOperationId:
          previous?.firstDispatchedOperationId ?? null,
        multipleDispatched: previous?.multipleDispatched ?? false,
        attemptCountBefore: previous?.deferred
          ? previous.attemptCountBefore
          : Math.max(0, cycle.attemptCount - 1),
      };
      if (
        controlChanged &&
        (!state.allAttemptsEnforced ||
          state.firstDispatchedOperationId !== null)
      )
        stale();
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          inferenceInput: state,
          userMessageId: receipt.clientMessageId,
          executionLaneId: receipt.executionLaneId,
        })
        .where(eq(schema.taskPlanningRounds.id, round.id));
      // Actual route selection may have changed during safe account failover.
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          modelRouteId: receipt.modelRouteId,
          providerAccountId: receipt.providerAccountId,
        })
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
      if (controlChanged) {
        // This exact launcher has not sent a worker turn. Commit its canonical
        // unclaimed receipt as deferred; never manufacture a physical claim.
        await this.deferLocked(tx, ownerId, state);
        return null;
      }
      return receipt;
    });
    if (!prepared)
      throw new TaskDispatchConflictError(
        "Pending Task input was cancelled by a control change.",
        "stale-lease",
      );
    return prepared;
  }

  async prepareResumption(
    ownerId: string,
    input: {
      resumption: TaskTurnResumption;
      lease: TaskDispatchFence;
      expectedInputRevision?: number;
    },
  ): Promise<TaskInferenceInputReceipt> {
    return this.database.transaction(async (tx) => {
      const original = taskInferenceInputReceiptSchema.parse(
        input.resumption.source,
      );
      if (original.kind) stale();
      await assertTaskOperationDispatchFence(
        tx,
        ownerId,
        original.chatId,
        original.dispatch.operationId,
        { kind: "leased", lease: input.lease },
      );
      const { round, chat, project } = await this.context(
        tx,
        ownerId,
        original,
      );
      const state = round.inferenceInput;
      const checkpointOwner = state ? taskCheckpointExecution(state) : null;
      const suspension = await new NativeSuspensionRepository(
        this.database,
        tx,
      ).read(ownerId, original.chatId);
      if (
        !state ||
        !state.nativeExecution ||
        !state.nativeOwner ||
        !checkpointOwner?.nativeExecution ||
        !checkpointOwner.nativeOwner ||
        state.terminal ||
        !isDeepStrictEqual(state.receipt, original) ||
        !state.dispatched ||
        !state.accepted ||
        (input.expectedInputRevision !== undefined &&
          chat.managedInputRevision !== input.expectedInputRevision) ||
        project.taskSchedulingPaused ||
        suspension?.phase !== "resuming" ||
        suspension.action !== "resume" ||
        suspension.controlId !== input.resumption.controlId ||
        !isDeepStrictEqual(
          suspension.checkpoint,
          input.resumption.checkpoint,
        ) ||
        suspension.target.taskRound?.inputOperationId !==
          original.operationId ||
        suspension.target.taskRound.operationId !==
          original.dispatch.operationId ||
        suspension.target.taskRound.cycleId !== input.lease.cycleId ||
        suspension.active?.threadId !== state.nativeExecution.threadId ||
        suspension.active.turnId !== state.nativeExecution.turnId
      )
        stale();
      if (
        suspension.actor?.operationId !== checkpointOwner.receipt.operationId ||
        suspension.actor.operationGeneration !==
          checkpointOwner.receipt.operationId ||
        suspension.actor.workerGeneration !==
          checkpointOwner.nativeOwner.workerGeneration ||
        suspension.actor.runtimeGeneration !==
          checkpointOwner.nativeOwner.runtimeGeneration
      )
        stale();
      const dispatch = {
        cycleId: input.lease.cycleId,
        operationId: input.lease.operationId,
        leaseOwner: input.lease.leaseOwner,
        fencingToken: input.lease.fencingToken,
      };
      if (
        state.resumption?.controlId === suspension.controlId &&
        isDeepStrictEqual(state.resumption.receipt.dispatch, dispatch)
      )
        return state.resumption.receipt;
      const receipt = taskInferenceInputReceiptSchema.parse({
        ...original,
        operationId: randomUUID(),
        dispatch,
      });
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          inferenceInput: {
            ...state,
            resumption: {
              controlId: suspension.controlId,
              receipt,
              accepted: false,
              dispatched: false,
              checkpointOwner: {
                receipt: checkpointOwner.receipt,
                nativeExecution: checkpointOwner.nativeExecution,
                nativeOwner: checkpointOwner.nativeOwner,
              },
            },
          },
        })
        .where(eq(schema.taskPlanningRounds.id, round.id));
      return receipt;
    });
  }

  /** This acknowledgement is required BEFORE the worker sends turn/start.
   * It authorizes this canonical input, and never grants a provider ticket. */
  async dispatch(
    ownerId: string,
    workerId: string,
    receipt: TaskInferenceInputReceipt,
    phase: "accepted" | "claim" | "dispatch" | "native" = "dispatch",
    metadata?: {
      workerGeneration: string;
      nativeExecution?: InferenceNativeExecution;
      nativeRuntimeGeneration?: string;
    },
  ): Promise<{
    receipt: TaskInferenceInputReceipt;
    nativeExecution?: InferenceNativeExecution;
    nativeRuntimeGeneration?: string;
  }> {
    if (receipt.kind === "goal") {
      if (phase === "native") stale();
      return this.goals.dispatch(ownerId, workerId, receipt, phase);
    }
    if (workerId !== receipt.workerId) stale();
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        ownerId,
        receipt.chatId,
        receipt.dispatch.operationId,
        { kind: "leased", lease: receipt.dispatch },
      );
      const { round, task, lane, chat, project } = await this.context(
        tx,
        ownerId,
        receipt,
      );
      const state = round.inferenceInput;
      const execution = state ? currentTaskInputExecution(state) : null;
      if (execution && !isDeepStrictEqual(execution.receipt, receipt)) stale();
      let resumed = false;
      if (state?.resumption) {
        const suspension = await new NativeSuspensionRepository(
          this.database,
          tx,
        ).read(ownerId, receipt.chatId);
        resumed =
          suspension?.controlId === state.resumption.controlId &&
          suspension.action === "resume" &&
          (suspension.phase === "resuming" ||
            (phase === "native" && suspension.phase === "running"));
        if (!resumed) stale();
      }
      const updatedExecution = (
        update: Partial<TaskInferenceResumption>,
      ): TaskInferenceInputState =>
        state!.resumption
          ? { ...state!, resumption: { ...state!.resumption, ...update } }
          : { ...state!, ...update };
      if (phase === "native") {
        if (
          !state ||
          state.deferred ||
          state.failedBeforeDispatch ||
          !execution?.accepted ||
          !execution.dispatched ||
          state.terminal ||
          !metadata?.nativeRuntimeGeneration ||
          execution.claimWorkerGeneration !== metadata.workerGeneration ||
          JSON.stringify(
            taskInferenceInputReceiptSchema.parse(execution.receipt),
          ) !==
            JSON.stringify(taskInferenceInputReceiptSchema.parse(receipt)) ||
          lane.state !== "active"
        )
          stale();
        return bindTaskNativeInput(
          tx,
          ownerId,
          receipt,
          inferenceNativeExecutionSchema.parse(metadata!.nativeExecution),
          state,
          {
            workerGeneration: metadata!.workerGeneration,
            runtimeGeneration: metadata!.nativeRuntimeGeneration!,
          },
          new NativeSuspensionRepository(this.database, tx),
        );
      }
      if (
        !state ||
        state.deferred ||
        state.failedBeforeDispatch ||
        execution?.dispatched ||
        !execution ||
        JSON.stringify(
          taskInferenceInputReceiptSchema.parse(execution.receipt),
        ) !== JSON.stringify(taskInferenceInputReceiptSchema.parse(receipt)) ||
        lane.state !== "active" ||
        (chat.automationPaused && !resumed) ||
        project.taskSchedulingPaused ||
        task.state === "paused"
      )
        stale();
      if (
        execution.claimWorkerGeneration &&
        execution.claimWorkerGeneration !== metadata?.workerGeneration
      )
        stale();
      if (phase === "accepted" || phase === "claim") {
        // A canonical source may be created only by the first actual claim.
        // Legacy accepted acknowledgements remain idempotent, but cannot be
        // upgraded to a fresh source after their original worker lost it.
        if (phase === "claim" && execution.accepted) stale();
        await tx
          .update(schema.taskPlanningRounds)
          .set({
            inferenceInput: updatedExecution({
              accepted: true,
              ...(phase === "claim" && metadata
                ? { claimWorkerGeneration: metadata.workerGeneration }
                : {}),
            }),
          })
          .where(eq(schema.taskPlanningRounds.id, round.id));
        return { receipt };
      }
      if (!execution.accepted) stale();
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          inferenceInput: resumed
            ? updatedExecution({ dispatched: true })
            : {
                ...state,
                dispatched: true,
                firstDispatchedOperationId:
                  state.firstDispatchedOperationId ?? receipt.operationId,
                multipleDispatched:
                  state.multipleDispatched ||
                  (state.firstDispatchedOperationId !== null &&
                    state.firstDispatchedOperationId !== receipt.operationId),
              },
        })
        .where(eq(schema.taskPlanningRounds.id, round.id));
      return { receipt };
    });
  }

  /** Persist an actual worker rejection even if its lease just expired.
   * No input authority, provider capacity or retry decision is granted here. */
  async recordFailure(
    ownerId: string,
    failure:
      | {
          workerId: string;
          evidence: InferenceFailureEvidence;
        }
      | undefined,
  ): Promise<void> {
    await this.goals.recordFailure(ownerId, failure);
    if (!failure || failure.evidence.disposition !== "input-not-dispatched")
      return;
    const proof = failure.evidence;
    await this.database.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      if (!owner) return;
      const [found] = await tx
        .select({ round: schema.taskPlanningRounds })
        .from(schema.taskPlanningRounds)
        .innerJoin(
          schema.tasks,
          and(
            eq(schema.tasks.chatId, schema.taskPlanningRounds.chatId),
            eq(schema.tasks.activeOperationId, schema.taskPlanningRounds.id),
          ),
        )
        .where(eq(schema.taskPlanningRounds.chatId, proof.chatId))
        .limit(1);
      const state = found?.round.inferenceInput;
      if (!state || state.deferred) return;
      const receipt = state.receipt;
      if (
        receipt.operationId !== proof.operationId ||
        receipt.chatId !== proof.chatId ||
        receipt.clientMessageId !== proof.messageId ||
        receipt.providerId !== proof.providerId ||
        receipt.workerId !== failure.workerId
      )
        return;
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId),
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, receipt.chatId),
            eq(
              schema.taskDispatchCycles.operationId,
              receipt.dispatch.operationId,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const [latest] = await tx
        .select({ id: schema.taskDispatchCycles.id })
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, receipt.chatId),
          ),
        )
        .orderBy(
          desc(schema.taskDispatchCycles.createdAt),
          desc(schema.taskDispatchCycles.id),
        )
        .limit(1);
      if (!cycle || latest?.id !== cycle.id) return;
      const fence = receipt.dispatch;
      const current =
        (cycle.fencingToken === fence.fencingToken &&
          cycle.leaseOwner === fence.leaseOwner &&
          ["claimed", "running"].includes(cycle.state)) ||
        (cycle.state === "expired" &&
          cycle.fencingToken === fence.fencingToken + 1);
      if (!current) return;
      try {
        const { round } = await this.context(tx, ownerId, receipt);
        if (!round.inferenceInput?.failedBeforeDispatch)
          await tx
            .update(schema.taskPlanningRounds)
            .set({
              inferenceInput: { ...state, failedBeforeDispatch: true },
            })
            .where(eq(schema.taskPlanningRounds.id, round.id));
      } catch (error) {
        if (!(error instanceof TaskDispatchConflictError)) throw error;
      }
    });
  }

  /** Seal an unused planning/finalizer receipt under the Stop owner's locks.
   * Input authority is revoked here; physical inference settlement is separate. */
  async deferForInterrupt(
    tx: RepositoryTransaction,
    ownerId: string,
    cycle: typeof schema.taskDispatchCycles.$inferSelect,
  ): Promise<void> {
    const [round] = await tx
      .select()
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.id, cycle.operationId),
          eq(schema.taskPlanningRounds.chatId, cycle.chatId),
        ),
      )
      .for("update")
      .limit(1);
    const state = round?.inferenceInput;
    if (
      !state ||
      !state.allAttemptsEnforced ||
      state.receipt.kind ||
      state.deferred ||
      state.failedBeforeDispatch ||
      state.dispatched ||
      state.firstDispatchedOperationId !== null ||
      state.receipt.dispatch.cycleId !== cycle.id ||
      state.receipt.dispatch.operationId !== cycle.operationId ||
      state.receipt.dispatch.fencingToken !== cycle.fencingToken ||
      state.receipt.dispatch.leaseOwner !== cycle.leaseOwner ||
      !["claimed", "running"].includes(cycle.state)
    )
      return;
    try {
      // Revocation also covers a command that has not claimed this receipt yet.
      // The actual before-send RPC serializes against this same canonical row.
      await this.deferLocked(tx, ownerId, state);
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) throw error;
    }
  }

  /** Revoke pending input authority and restore its original canonical cycle.
   * If dispatch won the race, uncertainty wins: never replay that whole input.
   * An old title/native preparation may still occupy its worker ticket until
   * physical settlement. This transaction does not release that capacity. */
  async defer(
    ownerId: string,
    chatId: string,
    guard: TaskOperationDispatchFence,
  ): Promise<boolean> {
    const goal = await this.goals.defer(ownerId, chatId, guard);
    if (goal !== null) return goal;
    if (!this.lanes)
      throw new Error("Task input recovery requires execution lane ownership.");
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        ownerId,
        chatId,
        guard.kind === "leased" ? guard.lease.operationId : guard.operationId,
        guard,
      );
      const operationId =
        guard.kind === "leased" ? guard.lease.operationId : guard.operationId;
      const [current] = await tx
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
      const state = current?.inferenceInput;
      if (
        !state ||
        !state.accepted ||
        !state.allAttemptsEnforced ||
        state.deferred ||
        state.failedBeforeDispatch ||
        state.firstDispatchedOperationId !== null
      )
        return false;
      const receipt = state.receipt;
      const fence = guard.kind === "leased" ? guard.lease : guard;
      if (
        receipt.dispatch.cycleId !== fence.cycleId ||
        receipt.dispatch.operationId !== fence.operationId ||
        receipt.dispatch.fencingToken + (guard.kind === "expired" ? 1 : 0) !==
          fence.fencingToken ||
        (guard.kind === "leased" &&
          receipt.dispatch.leaseOwner !== guard.lease.leaseOwner)
      )
        return false;
      await this.deferLocked(tx, ownerId, state);
      return true;
    });
  }

  async reconcile(
    ownerId: string,
    input: NativeInferenceRecovery,
  ): Promise<NativeInferenceRecoveryResult> {
    if (input.record.identity.recovery?.taskInput?.kind === "goal")
      return this.goals.reconcile(ownerId, input);
    const record = input.record;
    const receipt = record.identity.recovery?.taskInput;
    const result = (
      disposition: NativeInferenceRecoveryResult["disposition"],
      noInput = false,
    ): NativeInferenceRecoveryResult => ({
      key: record.key,
      disposition,
      chatId: receipt?.chatId ?? null,
      ...(noInput ? { taskInputNotDispatched: true } : {}),
    });
    if (
      !receipt ||
      receipt.workerId !== input.workerId ||
      receipt.operationId !== record.identity.operationId ||
      receipt.chatId !== record.identity.chatId ||
      receipt.clientMessageId !== record.identity.recovery?.messageId ||
      receipt.providerId !== record.identity.providerId ||
      record.workerGeneration === input.workerGeneration
    )
      return result("unresolved");
    if (!this.lanes)
      throw new Error("Task input recovery requires execution lane ownership.");
    return this.database.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      if (!owner) return result("retired");
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId),
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, receipt.chatId),
          ),
        )
        .for("update")
        .limit(1);
      const [latest] = await tx
        .select({ id: schema.taskDispatchCycles.id })
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            eq(schema.taskDispatchCycles.chatId, receipt.chatId),
          ),
        )
        .orderBy(
          desc(schema.taskDispatchCycles.createdAt),
          desc(schema.taskDispatchCycles.id),
        )
        .limit(1);
      const [round] = await tx
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, receipt.dispatch.operationId),
            eq(schema.taskPlanningRounds.chatId, receipt.chatId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !cycle ||
        latest?.id !== cycle.id ||
        cycle.operationId !== receipt.dispatch.operationId ||
        !round ||
        round.relayRequest.userMessage.id !== receipt.clientMessageId
      )
        return result("retired");
      const state = round.inferenceInput;
      if (!state) return result("unresolved");
      if (state.failedBeforeDispatch) return result("retired");
      if (!state.accepted || !state.allAttemptsEnforced)
        return result("unresolved");
      if (
        round.relayResult ||
        round.status !== "running" ||
        !["claimed", "running", "queued", "paused", "expired"].includes(
          cycle.state,
        )
      )
        return result("retired");
      if (
        state.receipt.workerId !== input.workerId ||
        state.receipt.providerId !== receipt.providerId
      )
        return result("retired");
      // Exact native no-start evidence can undo an unobserved dispatch ack,
      // but never evidence belonging to another or multiple forwarded attempts.
      if (state.firstDispatchedOperationId !== null) {
        if (
          state.firstDispatchedOperationId !== receipt.operationId ||
          state.multipleDispatched ||
          !inferenceNeverStarted(record)
        )
          return result("unresolved");
        state.firstDispatchedOperationId = null;
        await tx
          .update(schema.taskPlanningRounds)
          .set({ inferenceInput: state })
          .where(eq(schema.taskPlanningRounds.id, round.id));
      }
      try {
        const current = await this.context(tx, ownerId, state.receipt);
        const paused =
          current.chat.automationPaused ||
          current.project.taskSchedulingPaused ||
          current.task.state === "paused";
        if (
          state.deferred ||
          state.receipt.operationId !== receipt.operationId
        ) {
          // A replacement already revoked this old attempt. Adopt its order
          // into that replacement, rather than revoking the replacement again.
          return result(
            paused || cycle.state === "paused" ? "retired" : "requeued",
            true,
          );
        }
        const expected = state.receipt.dispatch;
        const valid =
          (cycle.fencingToken === expected.fencingToken &&
            cycle.leaseOwner === expected.leaseOwner &&
            ["claimed", "running"].includes(cycle.state)) ||
          (cycle.state === "expired" &&
            cycle.fencingToken === expected.fencingToken + 1);
        if (!valid) return result("retired");
        await this.deferLocked(tx, ownerId, state);
        return result(paused ? "retired" : "requeued", true);
      } catch (error) {
        if (error instanceof TaskDispatchConflictError)
          return result("retired");
        throw error;
      }
    });
  }
}
