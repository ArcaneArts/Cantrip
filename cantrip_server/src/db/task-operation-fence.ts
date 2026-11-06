import type { TaskInferenceInputReceipt } from "@cantrip/protocol";
import type {
  TaskDispatchFence,
  TaskDispatchCycleState,
} from "@cantrip/protocol/task-scheduling";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./schema.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { currentTaskInputExecution } from "./task-input-execution-state.js";

export type TaskOperationLeaseFence = {
  kind: "leased";
  lease: TaskDispatchFence;
  /** undefined preserves other writers; null requires a legacy round without a receipt. */
  inferenceInputOperationId?: string | null;
  /** Explicit Task Goal input, separate from the finalizer's round receipt. */
  goalInferenceInputOperationId?: string;
  /** Goal setup captures its placement and prior input (null means none yet).
   * A newly prepared input owns its own terminal handling and cannot be failed
   * by that older launcher. Deferred prior inputs remain valid setup anchors. */
  goalLaunch?: {
    inputOperationId: string | null;
    placementRevision: number;
    /** Read-only setup may fail before Goal launch. It cannot retire a Goal
     * that acquired input ownership or advanced implementation meanwhile. */
    preparation?: { implementationStartedAt: string | null };
  };
};
export type TaskOperationDispatchFence =
  | TaskOperationLeaseFence
  | {
      kind: "expired";
      cycleId: string;
      operationId: string;
      fencingToken: number;
    }
  | TaskOperationOutcomeFence;

export interface TaskGoalProjectionFence {
  terminalObservedAt: string;
  /** Current control authority observed independently of the physical input. */
  control: {
    fencingToken: number;
    leaseOwner: string | null;
    state: TaskDispatchCycleState;
  };
  placementRevision: number;
  automationPaused: boolean;
  taskSchedulingPaused: boolean;
  threadId: string | null;
}

export type TaskOperationOutcomeFence = {
  /** A positive worker terminal receipt authorizes persistence after expiry.
   * It never grants new inference, resumes work, or renews a dispatch lease. */
  kind: "outcome";
  cycleId: string;
  operationId: string;
  fencingToken: number;
  leaseOwner: string;
} & (
  | {
      inferenceInputOperationId: string;
      roundProjection?: { control: TaskGoalProjectionFence["control"] };
      goalInferenceInputOperationId?: never;
      goalProjection?: never;
    }
  | {
      goalInferenceInputOperationId: string;
      inferenceInputOperationId?: never;
      goalProjection?: TaskGoalProjectionFence;
      roundProjection?: never;
    }
);

async function assertGoalPlacement(
  transaction: PgDatabase<PgQueryResultHKT, typeof schema>,
  ownerId: string,
  chatId: string,
  receipt: TaskInferenceInputReceipt,
  fail: () => never,
  projection?: TaskGoalProjectionFence,
) {
  await transaction.execute(projectChatExecutionLock(ownerId, chatId));
  const [chat] = await transaction
    .select()
    .from(schema.chats)
    .where(eq(schema.chats.id, chatId))
    .for("update")
    .limit(1);
  const [lane] = await transaction
    .select()
    .from(schema.chatExecutionLanes)
    .where(
      and(
        eq(schema.chatExecutionLanes.id, receipt.executionLaneId),
        eq(schema.chatExecutionLanes.chatId, chatId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !chat ||
    chat.archivedAt ||
    chat.activeWorkerId !== receipt.workerId ||
    chat.activeWorktreeId !== receipt.worktreeId ||
    !lane ||
    lane.activatedAt?.toISOString() !== receipt.executionLaneActivatedAt ||
    lane.workerId !== receipt.workerId ||
    lane.worktreeId !== receipt.worktreeId
  )
    fail();
  if (projection) {
    const [project] = await transaction
      .select({ paused: schema.projects.taskSchedulingPaused })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, chat!.projectId!),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !project ||
      chat!.placementRevision !== projection.placementRevision ||
      chat!.automationPaused !== projection.automationPaused ||
      project.paused !== projection.taskSchedulingPaused ||
      lane!.codexThreadId !== projection.threadId
    )
      fail();
  }
}

/** Lock actual dispatch authority in the transaction that writes its round.
 * A successful heartbeat before this transaction cannot fence a later write. */
export async function assertTaskOperationDispatchFence(
  transaction: PgDatabase<PgQueryResultHKT, typeof schema>,
  ownerId: string,
  chatId: string,
  operationId: string,
  expected: TaskOperationDispatchFence,
  association = false,
): Promise<void> {
  const fail = (): never => {
    throw new TaskDispatchConflictError(
      "The Task dispatch lease is stale or no longer active.",
      "stale-lease",
    );
  };
  const fence = expected.kind === "leased" ? expected.lease : expected;
  if (fence.operationId !== operationId) fail();
  // Same owner lock as claim/enqueue. Hold it and the cycle row through the
  // round mutation, so recovery cannot replace this authority between them.
  const [owner] = await transaction
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .for("update")
    .limit(1);
  if (!owner) fail();
  const [cycle] = await transaction
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.id, fence.cycleId),
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(schema.taskDispatchCycles.chatId, chatId),
        eq(schema.taskDispatchCycles.operationId, operationId),
      ),
    )
    .for("update")
    .limit(1);
  const [latest] = await transaction
    .select({ id: schema.taskDispatchCycles.id })
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .orderBy(
      desc(schema.taskDispatchCycles.createdAt),
      desc(schema.taskDispatchCycles.id),
    )
    .limit(1);
  if (!cycle) return fail();
  const projectionControl =
    expected.kind === "outcome"
      ? expected.goalInferenceInputOperationId
        ? expected.goalProjection?.control
        : expected.roundProjection?.control
      : undefined;
  const expiredOutcome =
    !projectionControl &&
    expected.kind === "outcome" &&
    cycle.state === "expired" &&
    cycle.fencingToken === expected.fencingToken + 1;
  if (
    latest?.id !== cycle.id ||
    (projectionControl
      ? cycle.fencingToken !== projectionControl.fencingToken ||
        cycle.fencingToken < fence.fencingToken
      : cycle.fencingToken !== fence.fencingToken && !expiredOutcome)
  )
    fail();
  if (expected.kind === "outcome") {
    if (
      projectionControl &&
      (cycle.state !== projectionControl.state ||
        cycle.leaseOwner !== projectionControl.leaseOwner ||
        ![
          "claimed",
          "running",
          "paused",
          "expired",
          "succeeded",
          "failed",
          ...(expected.inferenceInputOperationId ? ["queued"] : []),
        ].includes(cycle.state))
    )
      fail();
    if (
      !projectionControl &&
      !expiredOutcome &&
      (![
        "claimed",
        "running",
        ...(expected.goalInferenceInputOperationId
          ? ["paused", "succeeded", "failed"]
          : []),
      ].includes(cycle.state) ||
        cycle.leaseOwner !== expected.leaseOwner)
    )
      fail();
    const goal = expected.goalInferenceInputOperationId !== undefined;
    const [round] = goal
      ? []
      : await transaction
          .select({ input: schema.taskPlanningRounds.inferenceInput })
          .from(schema.taskPlanningRounds)
          .where(
            and(
              eq(schema.taskPlanningRounds.id, operationId),
              eq(schema.taskPlanningRounds.chatId, chatId),
            ),
          )
          .for("update")
          .limit(1);
    const input = goal ? cycle.goalInput : round?.input;
    const receipt =
      !goal && round?.input
        ? currentTaskInputExecution(round.input).receipt
        : input?.receipt;
    if (
      !input ||
      input.deferred ||
      !receipt ||
      (receipt.kind === "goal") !== goal ||
      receipt.operationId !==
        (goal
          ? expected.goalInferenceInputOperationId
          : expected.inferenceInputOperationId) ||
      receipt.dispatch.cycleId !== expected.cycleId ||
      receipt.dispatch.operationId !== expected.operationId ||
      receipt.dispatch.fencingToken !== expected.fencingToken ||
      receipt.dispatch.leaseOwner !== expected.leaseOwner ||
      (goal &&
        expected.goalProjection &&
        (!input.terminal ||
          input.terminal.observedAt !==
            expected.goalProjection.terminalObservedAt ||
          input.terminal.projectedAt !== null))
    )
      fail();
    if (goal && receipt)
      await assertGoalPlacement(
        transaction,
        ownerId,
        chatId,
        receipt,
        fail,
        expected.goalProjection,
      );
  } else if (expected.kind === "expired") {
    if (cycle.state !== "expired") fail();
  } else {
    const sameOwner = cycle.leaseOwner === expected.lease.leaseOwner;
    // A fast completion may settle before its launch callback binds history.
    // That association can finish under the same fence; it cannot settle work.
    const valid = association
      ? [
          "claimed",
          "running",
          "paused",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(cycle.state)
      : ["claimed", "running"].includes(cycle.state) &&
        cycle.leaseExpiresAt !== null &&
        cycle.leaseExpiresAt.getTime() > Date.now();
    if (!sameOwner || !valid) fail();
    if (expected.goalLaunch) {
      if (
        (cycle.goalInput?.receipt.operationId ?? null) !==
        expected.goalLaunch.inputOperationId
      )
        fail();
      await transaction.execute(projectChatExecutionLock(ownerId, chatId));
      const [placement] = await transaction
        .select({ chat: schema.chats, project: schema.projects })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.chats.id, chatId))
        .for("update")
        .limit(1);
      const [round] = await transaction
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
      const [task] = await transaction
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, chatId))
        .for("update")
        .limit(1);
      if (
        !placement ||
        placement.chat.archivedAt ||
        placement.chat.automationPaused ||
        placement.project.taskSchedulingPaused ||
        placement.chat.placementRevision !==
          expected.goalLaunch.placementRevision ||
        !round ||
        round.kind !== "finalize" ||
        !task ||
        !task.planGoalEnabled ||
        task.state === "complete" ||
        task.planningRound !== round.ordinal ||
        (task.activeOperationId !== null &&
          task.activeOperationId !== operationId)
      )
        fail();
      const preparation = expected.goalLaunch.preparation;
      if (
        preparation &&
        (!round?.relayResult ||
          task?.state === "paused" ||
          (cycle.goalInput !== null && !cycle.goalInput.deferred) ||
          (task?.implementationStartedAt?.toISOString() ?? null) !==
            preparation.implementationStartedAt)
      )
        fail();
    }
    if (expected.goalInferenceInputOperationId !== undefined) {
      const input = cycle.goalInput;
      if (
        !input ||
        input.deferred ||
        input.receipt.operationId !== expected.goalInferenceInputOperationId ||
        input.receipt.dispatch.fencingToken !== cycle.fencingToken ||
        input.receipt.dispatch.leaseOwner !== cycle.leaseOwner
      )
        fail();
      if (!input) return fail();
      await assertGoalPlacement(
        transaction,
        ownerId,
        chatId,
        input.receipt,
        fail,
      );
    }
    if (expected.inferenceInputOperationId !== undefined) {
      // Receipt replacement/defer holds this same owner/cycle lock. Validate
      // inside the round write transaction, not in a prior heartbeat/read.
      const [round] = await transaction
        .select({
          input: schema.taskPlanningRounds.inferenceInput,
        })
        .from(schema.taskPlanningRounds)
        .where(
          and(
            eq(schema.taskPlanningRounds.id, operationId),
            eq(schema.taskPlanningRounds.chatId, chatId),
          ),
        )
        .limit(1);
      if (!round) return fail();
      const input = round.input;
      if (expected.inferenceInputOperationId === null) {
        if (input !== null) fail();
      } else if (
        !input ||
        input.deferred ||
        currentTaskInputExecution(input).receipt.operationId !==
          expected.inferenceInputOperationId
      )
        fail();
    }
  }
}
