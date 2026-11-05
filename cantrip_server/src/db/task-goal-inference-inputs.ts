import type { TaskMessageOpaqueContent } from "@cantrip/protocol/tasks";
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
  type TaskOperationOutcomeFence,
  type TaskGoalProjectionFence,
} from "./task-operation-fence.js";
import {
  TaskDispatchConflictError,
  TaskDispatchRepository,
} from "./task-dispatch.js";
import type { TaskInferenceInputState } from "./task-inference-inputs.js";
import { TaskRetryRepository } from "./task-retries.js";
import { classifyTaskFailure } from "../tasks/automatic-retry.js";
import { recoverGoalInputHistory } from "./task-goal-input-history.js";

function outcomeGuard(
  receipt: TaskInferenceInputReceipt,
): Extract<
  TaskOperationOutcomeFence,
  { goalInferenceInputOperationId: string }
> {
  return {
    kind: "outcome",
    ...receipt.dispatch,
    goalInferenceInputOperationId: receipt.operationId,
  };
}

function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task Goal input was replaced or revoked.",
    "stale-lease",
  );
}

/** Saving a physical result is not a lease mutation. A recovered control owner
 * cannot change which input ran, and that input cannot act as the newer owner. */
function physicalInput(
  cycle: typeof schema.taskDispatchCycles.$inferSelect | null,
  receipt: TaskInferenceInputReceipt,
) {
  const input = cycle?.goalInput;
  if (
    !cycle ||
    !input ||
    input.deferred ||
    receipt.kind !== "goal" ||
    cycle.id !== receipt.dispatch.cycleId ||
    cycle.chatId !== receipt.chatId ||
    cycle.operationId !== receipt.dispatch.operationId ||
    JSON.stringify(taskInferenceInputReceiptSchema.parse(input.receipt)) !==
      JSON.stringify(taskInferenceInputReceiptSchema.parse(receipt))
  )
    stale();
  return cycle;
}
function originalControl(
  cycle: typeof schema.taskDispatchCycles.$inferSelect,
  receipt: TaskInferenceInputReceipt,
) {
  return (
    (cycle.fencingToken === receipt.dispatch.fencingToken &&
      cycle.leaseOwner === receipt.dispatch.leaseOwner &&
      ["claimed", "running", "paused", "succeeded", "failed"].includes(
        cycle.state,
      )) ||
    (cycle.state === "expired" &&
      cycle.fencingToken === receipt.dispatch.fencingToken + 1)
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

  /** Capture cached-finalizer ownership before read-only launch preparation.
   * Running finalizers retain their normal input failure path. A live Goal
   * input owns its own settlement and must not be retired by preparation. */
  async preparationGuard(
    owner: string,
    chat: string,
    lease: TaskInferenceInputReceipt["dispatch"],
  ): Promise<TaskOperationLeaseFence | null> {
    return this.database.transaction(async (tx) => {
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        chat,
        lease.operationId,
        { kind: "leased", lease },
      );
      const cycle = await this.cycle(tx, owner, chat, lease.cycleId);
      const [round] = await tx
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, lease.operationId),
            eq(schema.taskPlanningRounds.chatId, chat),
          ),
        )
        .for("update")
        .limit(1);
      if (!round || round.kind !== "finalize" || !round.relayResult)
        return null;
      if (!cycle || (cycle.goalInput && !cycle.goalInput.deferred)) stale();
      await tx.execute(projectChatExecutionLock(owner, chat));
      const [placement] = await tx
        .select({ chat: schema.chats, task: schema.tasks })
        .from(schema.chats)
        .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
        .where(eq(schema.chats.id, chat))
        .for("update")
        .limit(1);
      if (!placement) stale();
      const guard: TaskOperationLeaseFence = {
        kind: "leased",
        lease,
        goalLaunch: {
          inputOperationId: cycle.goalInput?.receipt.operationId ?? null,
          placementRevision: placement.chat.placementRevision,
          preparation: {
            implementationStartedAt:
              placement.task.implementationStartedAt?.toISOString() ?? null,
          },
        },
      };
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        chat,
        lease.operationId,
        guard,
      );
      return guard;
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
    return {
      ...placement,
      // The existing guard above establishes this Task-only routing shape.
      chat: placement.chat as typeof placement.chat & { experience: "task" },
      round,
      message,
      lane,
    };
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

  /** Positive canonical deletion/replacement only, never lease expiry, archive,
   * observer loss, or absence of a terminal notification. This retires delivery
   * authority only and cannot settle any physical inference. */
  async outcomeRetirementReason(
    owner: string,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ): Promise<"canonical-input-deleted" | "canonical-input-replaced" | null> {
    return this.database.transaction(async (tx) => {
      await tx.execute(projectChatExecutionLock(owner, notification.chatId));
      const [row] = await tx
        .select({ state: schema.chatMessages.taskGoalInput })
        .from(schema.chatMessages)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.chatMessages.chatId),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, owner),
          ),
        )
        .where(
          and(
            eq(schema.chatMessages.id, notification.clientMessageId),
            eq(schema.chatMessages.chatId, notification.chatId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return "canonical-input-deleted" as const;
      const receipt = taskInferenceInputReceiptSchema.safeParse(
        row.state?.receipt,
      );
      if (
        receipt.success &&
        receipt.data.kind === "goal" &&
        receipt.data.chatId === notification.chatId &&
        receipt.data.clientMessageId === notification.clientMessageId &&
        receipt.data.operationId !== notification.taskInferenceInputOperationId
      )
        return "canonical-input-replaced" as const;
      return null;
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
    options: { recordOnly?: boolean } = {},
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
        return recoverGoalInputHistory(
          tx,
          owner,
          worker,
          notification,
          this.messages,
        );
      const receipt = state.receipt;
      if (
        state.deferred ||
        (notification.outcome.ok &&
          (!state.accepted ||
            !state.dispatched ||
            state.failedBeforeDispatch)) ||
        receipt.workerId !== worker ||
        receipt.clientMessageId !== notification.clientMessageId ||
        receipt.executionLaneId !== notification.executionLaneId ||
        receipt.worktreeId !== notification.worktreeId ||
        receipt.dispatch.cycleId !== fence.cycleId ||
        receipt.dispatch.operationId !== fence.operationId ||
        receipt.dispatch.fencingToken !== fence.fencingToken ||
        receipt.dispatch.leaseOwner !== fence.leaseOwner
      )
        stale();
      const physical = physicalInput(cycle, receipt);
      const ownsControl = originalControl(physical, receipt);
      let context;
      try {
        context = await this.context(tx, owner, receipt, { settled: true });
      } catch (error) {
        if (error instanceof TaskDispatchConflictError)
          return recoverGoalInputHistory(
            tx,
            owner,
            worker,
            notification,
            this.messages,
          );
        throw error;
      }
      if (!this.messages || !this.lanes)
        throw new Error(
          "Task Goal outcomes require transactional history and lane ownership.",
        );
      let message: TaskMessageOpaqueContent | null = null;
      if (notification.outcome.ok) {
        try {
          message = taskMessageRelayResultSchema.parse(
            notification.outcome.result.structuredResult,
          ).message;
          if (message.idempotencyKey !== `assistant:${receipt.clientMessageId}`)
            message = null;
        } catch {
          /* The actual terminal receipt remains useful for recovery. */
        }
      }
      const ok = notification.outcome.ok && message !== null;
      const failureKind = ok
        ? null
        : classifyTaskFailure(
            notification.outcome.ok
              ? "Task Goal outcome omitted its canonical protected response."
              : notification.outcome.error,
          );
      if (
        state.terminal &&
        (state.terminal.ok !== ok || state.terminal.failureKind !== failureKind)
      )
        stale();
      const terminal = state.terminal ?? {
        ok,
        failureKind,
        observedAt: new Date().toISOString(),
        projectedAt: null,
        threadId: notification.outcome.ok
          ? notification.outcome.result.threadId
          : (context.lane?.codexThreadId ?? null),
        turnId: notification.outcome.ok
          ? (notification.outcome.result.turnId ?? null)
          : (notification.outcome.inference?.turnId ?? null),
      };
      const saved = message
        ? await this.messages
            .inTransaction(tx)
            .appendTaskMessage(owner, receipt.chatId, message, {
              executionLaneId: receipt.executionLaneId,
              worktreeId: receipt.worktreeId,
            })
        : null;
      if (message && !saved) stale();
      if (!state.terminal)
        await tx
          .update(schema.taskDispatchCycles)
          .set({ goalInput: { ...state, terminal } })
          .where(eq(schema.taskDispatchCycles.id, cycle!.id));
      if (
        ownsControl &&
        !ok &&
        state.accepted &&
        state.allAttemptsEnforced &&
        state.firstDispatchedOperationId === null &&
        !state.failedBeforeDispatch &&
        (context.chat.automationPaused ||
          context.project.taskSchedulingPaused ||
          context.task.state === "paused")
      ) {
        // The exact cancelled owner ended without forwarding input. Preserve
        // its canonical body for Resume; no dead controller owns it anymore.
        await this.deferLocked(tx, owner, cycle!, { ...state, terminal });
        return {
          receipt,
          terminal,
          message: saved,
          finished: true,
          historyOnly: false,
          chat: context.chat,
        };
      }
      if (options.recordOnly || !ownsControl)
        return {
          receipt,
          terminal,
          message: saved,
          finished: false,
          historyOnly: false,
          chat: context.chat,
        };
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
          ok ? "idle" : "failed",
          { expectedActivatedAt: receipt.executionLaneActivatedAt },
        );
      await tx
        .update(schema.agentInteractionRequests)
        .set({
          status: "interrupted",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.agentInteractionRequests.chatId, receipt.chatId),
            eq(
              schema.agentInteractionRequests.executionLaneId,
              receipt.executionLaneId,
            ),
            eq(schema.agentInteractionRequests.status, "pending"),
          ),
        );
      return {
        receipt,
        terminal,
        message: saved,
        finished,
        historyOnly: false,
        chat: context.chat,
      };
    });
  }

  async terminal(
    owner: string,
    chat: string,
    expected?: TaskInferenceInputReceipt,
  ) {
    return this.database
      .transaction(async (tx) => {
        const cycle = await this.cycle(
          tx,
          owner,
          chat,
          expected?.dispatch.cycleId,
        );
        const state = cycle?.goalInput;
        if (
          !state?.terminal ||
          state.terminal.projectedAt ||
          state.deferred ||
          (expected &&
            JSON.stringify(taskInferenceInputReceiptSchema.parse(expected)) !==
              JSON.stringify(
                taskInferenceInputReceiptSchema.parse(state.receipt),
              ))
        )
          return null;
        const physical = physicalInput(cycle, state.receipt);
        const c = await this.context(tx, owner, state.receipt, {
          settled: true,
        });
        if (
          state.terminal.threadId &&
          c.lane?.codexThreadId !== state.terminal.threadId
        )
          stale();
        const projection: TaskGoalProjectionFence = {
          terminalObservedAt: state.terminal.observedAt,
          control: {
            fencingToken: physical.fencingToken,
            leaseOwner: physical.leaseOwner,
            state: physical.state,
          },
          placementRevision: c.chat.placementRevision,
          automationPaused: c.chat.automationPaused,
          taskSchedulingPaused: c.project.taskSchedulingPaused,
          threadId: c.lane?.codexThreadId ?? null,
        };
        const guard = {
          ...outcomeGuard(state.receipt),
          goalProjection: projection,
        };
        await assertTaskOperationDispatchFence(
          tx,
          owner,
          chat,
          guard.operationId,
          guard,
        );
        return {
          receipt: state.receipt,
          terminal: state.terminal,
          guard,
          failedBeforeDispatch:
            state.failedBeforeDispatch === true &&
            state.firstDispatchedOperationId === null,
        };
      })
      .catch((error) => {
        if (error instanceof TaskDispatchConflictError) return null;
        throw error;
      });
  }

  /** Commit the actual native Goal projection under the old physical receipt.
   * It cannot renew that receipt, create a new cycle or free provider capacity. */
  async finishProjection(
    owner: string,
    receipt: TaskInferenceInputReceipt,
    rowVersion: number,
    projection: TaskGoalProjectionFence,
    execution?: { threadId: string; status: "running" | "idle" | "failed" },
  ) {
    return this.database.transaction(async (tx) => {
      const guard = outcomeGuard(receipt);
      guard.goalProjection = projection;
      await assertTaskOperationDispatchFence(
        tx,
        owner,
        receipt.chatId,
        guard.operationId,
        guard,
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
        !state?.terminal ||
        state.terminal.projectedAt ||
        state.deferred
      )
        stale();
      const c = await this.context(tx, owner, receipt, { settled: true });
      if (
        (!execution &&
          !(
            state.failedBeforeDispatch &&
            state.firstDispatchedOperationId === null &&
            c.task.state === "failed"
          )) ||
        (execution &&
          projection.threadId &&
          execution.threadId !== projection.threadId) ||
        c.task.rowVersion !== rowVersion ||
        (state.terminal.threadId &&
          c.lane?.codexThreadId !== state.terminal.threadId)
      )
        stale();
      if (c.task.state === "failed") {
        await new TaskRetryRepository(tx).noteFailure(
          owner,
          receipt.chatId,
          `goal-input:${receipt.operationId}`,
          classifyTaskFailure(c.task.lastError?.code ?? "runtime"),
          undefined,
          guard,
        );
      } else if (["complete", "blocked"].includes(c.task.state)) {
        await new TaskRetryRepository(tx).clearPending(
          owner,
          receipt.chatId,
          guard,
        );
      }
      if (
        execution?.status !== "running" &&
        ["complete", "blocked", "failed"].includes(c.task.state)
      ) {
        if (!this.lanes)
          throw new Error("Task Goal projection requires lane ownership.");
        await this.lanes
          .inTransaction(tx)
          .finishChatExecutionLane(
            receipt.chatId,
            receipt.executionLaneId,
            c.task.state === "failed" ? "failed" : "idle",
            { expectedActivatedAt: receipt.executionLaneActivatedAt },
          );
      }
      const now = new Date();
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          goalInput: {
            ...state,
            terminal: { ...state.terminal, projectedAt: now.toISOString() },
          },
          ...(["complete", "blocked", "failed"].includes(c.task.state)
            ? {
                state:
                  c.task.state === "failed"
                    ? ("failed" as const)
                    : ("succeeded" as const),
                completedAt: now,
                eligibilityCode: null,
                updatedAt: now,
              }
            : {}),
        })
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
      return c.task.state;
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
        physicalInput(cycle, receipt);
        await this.context(tx, owner, receipt, { settled: true });
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
