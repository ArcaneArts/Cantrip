import { randomUUID } from "node:crypto";
import {
  taskInferenceInputReceiptSchema,
  taskMessageOpaqueContentSchema,
  taskMessageRelayResultSchema,
  inferenceNeverStarted,
  type TaskInferenceInputReceipt,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
  type InferenceFailureEvidence,
  type WorkerNotification,
} from "@cantrip/protocol";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import type { ChatExecutionLaneRepository } from "./repository/chat-execution-lanes.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import {
  assertTaskOperationDispatchFence,
  type TaskOperationDispatchFence,
  type TaskOperationLeaseFence,
} from "./task-operation-fence.js";
import {
  TaskDispatchConflictError,
  TaskDispatchRepository,
} from "./task-dispatch.js";
import type { TaskInferenceInputState } from "./task-inference-inputs.js";

function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task Goal input was replaced or revoked.",
    "stale-lease",
  );
}

/** Input ownership metadata on the existing Goal dispatch, never a prompt queue. */
export class TaskGoalInferenceInputRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes?: ChatExecutionLaneRepository,
    private readonly messages?: MessageWriteRepository,
  ) {}

  async launchGuard(
    owner: string,
    chat: string,
    lease: TaskInferenceInputReceipt["dispatch"],
  ): Promise<TaskOperationLeaseFence> {
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        chat,
        lease.operationId,
        { kind: "leased", lease },
      );
      const cycle = await this.cycle(tx, owner, chat, lease.cycleId);
      if (!cycle) stale();
      const [placement] = await tx
        .select({ revision: schema.chats.placementRevision })
        .from(schema.chats)
        .where(eq(schema.chats.id, chat))
        .for("update")
        .limit(1);
      if (!placement) stale();
      return {
        kind: "leased",
        lease,
        goalLaunch: {
          inputOperationId: cycle.goalInput?.receipt.operationId ?? null,
          placementRevision: placement.revision,
        },
      };
    });
  }

  async settleLaunchFailure(
    owner: string,
    chat: string,
    guard: TaskOperationLeaseFence,
  ) {
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        chat,
        guard.lease.operationId,
        guard,
      );
      return new TaskDispatchRepository(tx).settle(guard.lease, "failed");
    });
  }

  private async cycle(
    tx: RepositoryTransaction,
    owner: string,
    chat: string,
    id?: string,
  ) {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, owner))
      .for("update")
      .limit(1);
    if (!user) return null;
    const [latest] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, owner),
          eq(schema.taskDispatchCycles.chatId, chat),
        ),
      )
      .orderBy(
        desc(schema.taskDispatchCycles.createdAt),
        desc(schema.taskDispatchCycles.id),
      )
      .for("update")
      .limit(1);
    return latest && (!id || latest.id === id) ? latest : null;
  }

  private async context(
    tx: RepositoryTransaction,
    owner: string,
    receipt: TaskInferenceInputReceipt,
    options: { execution?: boolean; settled?: boolean } = {},
  ) {
    await tx.execute(projectChatExecutionLock(owner, receipt.chatId));
    const [placement] = await tx
      .select({
        chat: schema.chats,
        project: schema.projects,
        task: schema.tasks,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, owner),
        ),
      )
      .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
      .where(eq(schema.chats.id, receipt.chatId))
      .for("update")
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
    const [message] = await tx
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.id, receipt.clientMessageId),
          eq(schema.chatMessages.chatId, receipt.chatId),
        ),
      )
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
      !placement ||
      !round ||
      !message ||
      placement.chat.experience !== "task" ||
      placement.chat.archivedAt ||
      !placement.task.planGoalEnabled ||
      !placement.task.implementationStartedAt ||
      placement.task.activeOperationId !== null ||
      (!options.settled &&
        ["complete", "failed"].includes(placement.task.state)) ||
      round.kind !== "finalize" ||
      !round.relayResult?.goal ||
      placement.task.planningRound !== round.ordinal ||
      message.mode !== "goal" ||
      !["user", "system"].includes(message.role) ||
      !message.taskProtectedContent ||
      message.content ||
      (options.execution !== false &&
        (placement.chat.activeWorkerId !== receipt.workerId ||
          placement.chat.activeWorktreeId !== receipt.worktreeId ||
          !lane ||
          lane.activatedAt?.toISOString() !==
            receipt.executionLaneActivatedAt ||
          lane.workerId !== receipt.workerId ||
          lane.worktreeId !== receipt.worktreeId))
    )
      stale();
    return { ...placement, round, message, lane };
  }

  async prepare(
    owner: string,
    input: Omit<TaskInferenceInputReceipt, "operationId" | "kind">,
  ) {
    const receipt = taskInferenceInputReceiptSchema.parse({
      ...input,
      kind: "goal",
      operationId: randomUUID(),
    });
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        receipt.chatId,
        receipt.dispatch.operationId,
        { kind: "leased", lease: receipt.dispatch },
      );
      const cycle = await this.cycle(
        tx,
        owner,
        receipt.chatId,
        receipt.dispatch.cycleId,
      );
      if (
        !cycle ||
        cycle.operationKind !== "finalize" ||
        cycle.physicalWorkerId !== receipt.workerId ||
        cycle.worktreeId !== receipt.worktreeId
      )
        stale();
      const c = await this.context(tx, owner, receipt);
      if (
        c.chat.automationPaused ||
        c.project.taskSchedulingPaused ||
        c.task.state === "paused" ||
        c.lane?.state !== "active"
      )
        stale();
      const old = cycle.goalInput;
      if (
        old?.failedBeforeDispatch &&
        old.receipt.dispatch.fencingToken === receipt.dispatch.fencingToken
      )
        stale();
      const same = old?.receipt.clientMessageId === receipt.clientMessageId;
      const state: TaskInferenceInputState = {
        receipt,
        deferred: false,
        failedBeforeDispatch: false,
        accepted: false,
        dispatched: false,
        allAttemptsEnforced:
          !same || (old!.accepted && old!.allAttemptsEnforced),
        firstDispatchedOperationId: same
          ? old!.firstDispatchedOperationId
          : null,
        multipleDispatched: same ? old!.multipleDispatched : false,
        attemptCountBefore: cycle.attemptCount,
      };
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          goalInput: state,
          modelRouteId: receipt.modelRouteId,
          providerAccountId: receipt.providerAccountId,
        })
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
      return receipt;
    });
  }

  async dispatch(
    owner: string,
    worker: string,
    receipt: TaskInferenceInputReceipt,
    phase: "accepted" | "dispatch",
  ) {
    if (worker !== receipt.workerId) stale();
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        receipt.chatId,
        receipt.dispatch.operationId,
        { kind: "leased", lease: receipt.dispatch },
      );
      const cycle = await this.cycle(
        tx,
        owner,
        receipt.chatId,
        receipt.dispatch.cycleId,
      );
      const state = cycle?.goalInput;
      if (
        !cycle ||
        !state ||
        state.deferred ||
        state.failedBeforeDispatch ||
        state.dispatched ||
        JSON.stringify(taskInferenceInputReceiptSchema.parse(state.receipt)) !==
          JSON.stringify(taskInferenceInputReceiptSchema.parse(receipt))
      )
        stale();
      const c = await this.context(tx, owner, receipt);
      if (
        c.chat.automationPaused ||
        c.project.taskSchedulingPaused ||
        c.task.state === "paused" ||
        c.lane?.state !== "active"
      )
        stale();
      if (phase === "dispatch" && !state.accepted) stale();
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          goalInput:
            phase === "accepted"
              ? { ...state, accepted: true }
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
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
      return { receipt };
    });
  }

  private async deferLocked(
    tx: RepositoryTransaction,
    owner: string,
    cycle: typeof schema.taskDispatchCycles.$inferSelect,
    state: TaskInferenceInputState,
  ) {
    if (!this.lanes)
      throw new Error("Task Goal recovery requires execution lane ownership.");
    if (state.failedBeforeDispatch) stale();
    const c = await this.context(tx, owner, state.receipt, {
      execution: false,
    });
    const paused =
      c.chat.automationPaused ||
      c.project.taskSchedulingPaused ||
      c.task.state === "paused";
    await this.lanes
      .inTransaction(tx)
      .finishChatExecutionLane(
        state.receipt.chatId,
        state.receipt.executionLaneId,
        "idle",
        {
          expectedActivatedAt: state.receipt.executionLaneActivatedAt,
          markUnreadCompletion: false,
        },
      );
    const [active] = await tx
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, state.receipt.chatId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .limit(1);
    if (!active)
      await tx
        .update(schema.chats)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(schema.chats.id, state.receipt.chatId));
    await tx
      .update(schema.taskDispatchCycles)
      .set({
        goalInput: { ...state, deferred: true },
        state: paused ? "paused" : "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        fencingToken: sql`${schema.taskDispatchCycles.fencingToken}+1`,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        pausedAt: paused ? new Date() : null,
        eligibilityCode: "capacity-unavailable",
        updatedAt: new Date(),
      })
      .where(eq(schema.taskDispatchCycles.id, cycle.id));
  }

  /** null means the cycle has no Goal input and belongs to the round path. */
  async defer(
    owner: string,
    chat: string,
    guard: TaskOperationDispatchFence,
  ): Promise<boolean | null> {
    return this.database.transaction(async (tx) => {
      const fence = guard.kind === "leased" ? guard.lease : guard;
      const cycle = await this.cycle(tx, owner, chat, fence.cycleId);
      if (!cycle?.goalInput) return null;
      if (
        guard.kind === "leased" &&
        !["claimed", "running", "paused"].includes(cycle.state)
      )
        return false;
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        chat,
        fence.operationId,
        guard,
        guard.kind === "leased",
      );
      const state = cycle.goalInput;
      const receipt = state.receipt;
      if (
        !state.accepted ||
        !state.allAttemptsEnforced ||
        state.deferred ||
        state.failedBeforeDispatch ||
        state.firstDispatchedOperationId !== null
      )
        return false;
      if (
        receipt.dispatch.cycleId !== fence.cycleId ||
        receipt.dispatch.operationId !== fence.operationId ||
        receipt.dispatch.fencingToken + (guard.kind === "expired" ? 1 : 0) !==
          fence.fencingToken ||
        (guard.kind === "leased" &&
          receipt.dispatch.leaseOwner !== guard.lease.leaseOwner)
      )
        return false;
      await this.deferLocked(tx, owner, cycle, state);
      return true;
    });
  }

  async recordFailure(
    owner: string,
    failure:
      { workerId: string; evidence: InferenceFailureEvidence } | undefined,
  ) {
    if (!failure || failure.evidence.disposition !== "input-not-dispatched")
      return;
    const proof = failure.evidence;
    await this.database.transaction(async (tx) => {
      const cycle = await this.cycle(tx, owner, proof.chatId);
      const state = cycle?.goalInput;
      if (!cycle || !state || state.deferred) return;
      const r = state.receipt;
      if (
        r.operationId !== proof.operationId ||
        r.clientMessageId !== proof.messageId ||
        r.providerId !== proof.providerId ||
        r.workerId !== failure.workerId
      )
        return;
      if (!(
        (cycle.fencingToken === r.dispatch.fencingToken &&
          cycle.leaseOwner === r.dispatch.leaseOwner &&
          ["claimed", "running"].includes(cycle.state)) ||
        (cycle.state === "expired" &&
          cycle.fencingToken === r.dispatch.fencingToken + 1)
      ))
        return;
      try {
        await this.context(tx, owner, r, { execution: false });
      } catch (e) {
        if (e instanceof TaskDispatchConflictError) return;
        throw e;
      }
      await tx
        .update(schema.taskDispatchCycles)
        .set({ goalInput: { ...state, failedBeforeDispatch: true } })
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
    });
  }

  async reconcile(
    owner: string,
    input: NativeInferenceRecovery,
  ): Promise<NativeInferenceRecoveryResult> {
    const record = input.record;
    const r = record.identity.recovery?.taskInput;
    const result = (
      disposition: NativeInferenceRecoveryResult["disposition"],
      noInput = false,
    ): NativeInferenceRecoveryResult => ({
      key: record.key,
      disposition,
      chatId: r?.chatId ?? null,
      ...(noInput ? { taskInputNotDispatched: true } : {}),
    });
    if (
      !r ||
      r.kind !== "goal" ||
      r.workerId !== input.workerId ||
      r.operationId !== record.identity.operationId ||
      r.chatId !== record.identity.chatId ||
      r.clientMessageId !== record.identity.recovery?.messageId ||
      r.providerId !== record.identity.providerId ||
      record.workerGeneration === input.workerGeneration
    )
      return result("unresolved");
    return this.database.transaction(async (tx) => {
      const cycle = await this.cycle(tx, owner, r.chatId, r.dispatch.cycleId);
      const state = cycle?.goalInput;
      if (
        !cycle ||
        !state ||
        !["claimed", "running", "queued", "paused", "expired"].includes(
          cycle.state,
        )
      )
        return result("retired");
      if (
        state.failedBeforeDispatch ||
        state.receipt.clientMessageId !== r.clientMessageId ||
        state.receipt.workerId !== input.workerId ||
        state.receipt.providerId !== r.providerId
      )
        return result("retired");
      if (!state.accepted || !state.allAttemptsEnforced)
        return result("unresolved");
      if (state.firstDispatchedOperationId !== null) {
        if (
          state.firstDispatchedOperationId !== r.operationId ||
          state.multipleDispatched ||
          !inferenceNeverStarted(record)
        )
          return result("unresolved");
        state.firstDispatchedOperationId = null;
        await tx
          .update(schema.taskDispatchCycles)
          .set({ goalInput: state })
          .where(eq(schema.taskDispatchCycles.id, cycle.id));
      }
      try {
        const c = await this.context(tx, owner, state.receipt, {
          execution: false,
        });
        const paused =
          c.chat.automationPaused ||
          c.project.taskSchedulingPaused ||
          c.task.state === "paused";
        if (state.deferred || state.receipt.operationId !== r.operationId)
          return result(
            paused || cycle.state === "paused" ? "retired" : "requeued",
            true,
          );
        const f = state.receipt.dispatch;
        if (!(
          (cycle.fencingToken === f.fencingToken &&
            cycle.leaseOwner === f.leaseOwner &&
            ["claimed", "running"].includes(cycle.state)) ||
          (cycle.state === "expired" &&
            cycle.fencingToken === f.fencingToken + 1)
        ))
          return result("retired");
        await this.deferLocked(tx, owner, cycle, state);
        return result(paused ? "retired" : "requeued", true);
      } catch (e) {
        if (e instanceof TaskDispatchConflictError) return result("retired");
        throw e;
      }
    });
  }

  /** Read the canonical message; return no duplicate encrypted prompt storage. */
  async pending(owner: string, chat: string, cycleId?: string) {
    return this.database.transaction(async (tx) => {
      const cycle = await this.cycle(tx, owner, chat, cycleId);
      const state = cycle?.goalInput;
      if (
        !cycle ||
        !state ||
        !["claimed", "running", "queued", "paused", "expired"].includes(
          cycle.state,
        ) ||
        state.failedBeforeDispatch ||
        state.firstDispatchedOperationId !== null
      )
        return null;
      let c;
      try {
        c = await this.context(tx, owner, state.receipt, { execution: false });
      } catch (e) {
        if (e instanceof TaskDispatchConflictError) return null;
        throw e;
      }
      return {
        receipt: state.receipt,
        deferred: state.deferred,
        message: taskMessageOpaqueContentSchema.parse({
          id: c.message.id,
          classification: {
            role: c.message.role,
            mode: c.message.mode,
            attachmentIds: c.message.taskAttachmentIds,
          },
          protectedContent: c.message.taskProtectedContent,
          reasoningEffort: c.message.reasoningEffort,
          idempotencyKey: c.message.idempotencyKey,
        }),
      };
    });
  }

  /** A Goal input is not its already-completed finalization round. Apply its
   * protected history and exact lane settlement under the same input authority.
   * Task/Goal projection is synchronized separately; this never settles a Goal
   * dispatch just because its first response finished. */
  async applyOutcome(
    owner: string,
    worker: string,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ) {
    const fence = notification.taskDispatchFence;
    if (!fence || !notification.taskInferenceInputOperationId) return null;
    return this.database.transaction(async (tx) => {
      const cycle = await this.cycle(
        tx,
        owner,
        notification.chatId,
        fence.cycleId,
      );
      const state = cycle?.goalInput;
      if (
        !state ||
        state.receipt.operationId !== notification.taskInferenceInputOperationId
      )
        return null;
      const receipt = state.receipt;
      if (
        state.deferred ||
        receipt.workerId !== worker ||
        receipt.clientMessageId !== notification.clientMessageId ||
        receipt.executionLaneId !== notification.executionLaneId ||
        receipt.worktreeId !== notification.worktreeId ||
        receipt.dispatch.operationId !== fence.operationId ||
        receipt.dispatch.fencingToken !== fence.fencingToken ||
        receipt.dispatch.leaseOwner !== fence.leaseOwner
      )
        stale();
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        receipt.chatId,
        fence.operationId,
        {
          kind: "leased",
          lease: fence,
          goalInferenceInputOperationId: receipt.operationId,
        },
        true,
      );
      const context = await this.context(tx, owner, receipt, { settled: true });
      if (!this.messages || !this.lanes)
        throw new Error(
          "Task Goal outcomes require transactional history and lane ownership.",
        );
      const message = notification.outcome.ok
        ? taskMessageRelayResultSchema.parse(
            notification.outcome.result.structuredResult,
          ).message
        : null;
      if (
        message &&
        (message.classification.role !== "assistant" ||
          message.idempotencyKey !== `assistant:${receipt.clientMessageId}`)
      )
        throw new Error(
          "Task Goal outcome does not match its canonical response.",
        );
      const saved = message
        ? await this.messages
            .inTransaction(tx)
            .appendTaskMessage(owner, receipt.chatId, message, {
              executionLaneId: receipt.executionLaneId,
              worktreeId: receipt.worktreeId,
            })
        : null;
      if (message && !saved) stale();
      if (notification.outcome.ok)
        await this.lanes
          .inTransaction(tx)
          .updateChatExecutionLaneRuntime(
            receipt.chatId,
            receipt.executionLaneId,
            notification.outcome.result.threadId,
            "ready",
          );
      const finished = await this.lanes
        .inTransaction(tx)
        .finishChatExecutionLane(
          receipt.chatId,
          receipt.executionLaneId,
          notification.outcome.ok ? "idle" : "failed",
          { expectedActivatedAt: receipt.executionLaneActivatedAt },
        );
      return { receipt, message: saved, finished, chat: context.chat };
    });
  }

  async receiptForTurn(
    owner: string,
    chat: string,
    lease: TaskInferenceInputReceipt["dispatch"],
    turn: {
      clientMessageId: string;
      executionLaneId: string;
      executionLaneActivatedAt?: string;
    },
  ) {
    return this.database
      .transaction(async (tx) => {
        const cycle = await this.cycle(tx, owner, chat, lease.cycleId);
        const state = cycle?.goalInput;
        const receipt = state?.receipt;
        if (
          !state ||
          state.deferred ||
          !receipt ||
          receipt.clientMessageId !== turn.clientMessageId ||
          receipt.executionLaneId !== turn.executionLaneId ||
          receipt.executionLaneActivatedAt !== turn.executionLaneActivatedAt ||
          receipt.dispatch.operationId !== lease.operationId ||
          receipt.dispatch.fencingToken !== lease.fencingToken ||
          receipt.dispatch.leaseOwner !== lease.leaseOwner
        )
          return null;
        await assertTaskOperationDispatchFence(
          tx,
          owner,
          chat,
          lease.operationId,
          {
            kind: "leased",
            lease,
            goalInferenceInputOperationId: receipt.operationId,
          },
          true,
        );
        return receipt;
      })
      .catch((error) => {
        if (error instanceof TaskDispatchConflictError) return null;
        throw error;
      });
  }

  async pause(
    owner: string,
    receipt: TaskInferenceInputReceipt,
    threadId: string | null,
  ) {
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        receipt.chatId,
        receipt.dispatch.operationId,
        {
          kind: "leased",
          lease: receipt.dispatch,
          goalInferenceInputOperationId: receipt.operationId,
        },
        true,
      );
      return new TaskDispatchRepository(tx).pause(receipt.dispatch, {
        threadId,
        turnId: null,
      });
    });
  }
}
