import type { TaskFailureKind } from "@cantrip/protocol/tasks";
import { randomUUID } from "node:crypto";
import { TaskGoalInferenceInputRepository } from "./task-goal-inference-inputs.js";
import {
  taskInferenceInputReceiptSchema,
  type InferenceFailureEvidence,
  type TaskInferenceInputReceipt,
  inferenceNeverStarted,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
} from "@cantrip/protocol";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import type { ChatExecutionLaneRepository } from "./repository/chat-execution-lanes.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import {
  assertTaskOperationDispatchFence,
  type TaskOperationDispatchFence,
} from "./task-operation-fence.js";

/** Metadata on the canonical round, never another copy/queue of its input.
 * Sticky dispatch evidence survives route retries: a later unstarted attempt
 * cannot authorize replay of an earlier possibly executed attempt. */
export interface TaskInferenceInputState {
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
    observedAt: string;
    projectedAt: string | null;
    threadId: string | null;
    turnId: string | null;
  };
}

function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task input receipt was replaced or revoked.",
    "stale-lease",
  );
}

export class TaskInferenceInputRepository {
  readonly goals: TaskGoalInferenceInputRepository;
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes?: ChatExecutionLaneRepository,
    messages?: MessageWriteRepository,
  ) {
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
    const paused =
      chat.automationPaused ||
      project.taskSchedulingPaused ||
      task.state === "paused";
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

  async prepare(
    ownerId: string,
    input: Omit<TaskInferenceInputReceipt, "operationId">,
  ): Promise<TaskInferenceInputReceipt> {
    if (input.kind === "goal") return this.goals.prepare(ownerId, input);
    const receipt = taskInferenceInputReceiptSchema.parse({
      ...input,
      operationId: randomUUID(),
    });
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
      if (
        lane.state !== "active" ||
        chat.automationPaused ||
        project.taskSchedulingPaused ||
        task.state === "paused"
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
      const previous = round.inferenceInput;
      if (
        previous?.failedBeforeDispatch &&
        previous.receipt.dispatch.cycleId === receipt.dispatch.cycleId &&
        previous.receipt.dispatch.fencingToken === receipt.dispatch.fencingToken
      )
        stale();
      const state: TaskInferenceInputState = {
        receipt,
        deferred: false,
        failedBeforeDispatch: false,
        accepted: false,
        dispatched: false,
        allAttemptsEnforced:
          previous === null ||
          (previous.accepted === true && previous.allAttemptsEnforced === true),
        firstDispatchedOperationId:
          previous?.firstDispatchedOperationId ?? null,
        multipleDispatched: previous?.multipleDispatched ?? false,
        attemptCountBefore: previous?.deferred
          ? previous.attemptCountBefore
          : Math.max(0, cycle.attemptCount - 1),
      };
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
      return receipt;
    });
  }

  /** This acknowledgement is required BEFORE the worker sends turn/start.
   * It authorizes this canonical input, and never grants a provider ticket. */
  async dispatch(
    ownerId: string,
    workerId: string,
    receipt: TaskInferenceInputReceipt,
    phase: "accepted" | "dispatch" = "dispatch",
  ): Promise<{ receipt: TaskInferenceInputReceipt }> {
    if (receipt.kind === "goal")
      return this.goals.dispatch(ownerId, workerId, receipt, phase);
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
      if (
        !state ||
        state.deferred ||
        state.failedBeforeDispatch ||
        state.dispatched ||
        JSON.stringify(taskInferenceInputReceiptSchema.parse(state.receipt)) !==
          JSON.stringify(taskInferenceInputReceiptSchema.parse(receipt)) ||
        lane.state !== "active" ||
        chat.automationPaused ||
        project.taskSchedulingPaused ||
        task.state === "paused"
      )
        stale();
      if (phase === "accepted") {
        await tx
          .update(schema.taskPlanningRounds)
          .set({ inferenceInput: { ...state, accepted: true } })
          .where(eq(schema.taskPlanningRounds.id, round.id));
        return { receipt };
      }
      if (!state.accepted) stale();
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          inferenceInput: {
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
