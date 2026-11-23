import { isDeepStrictEqual } from "node:util";
import {
  nativeTurnRecoveryObservationSchema,
  type NativeTurnRecoveryObservation,
} from "@cantrip/protocol";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import type { ChatExecutionLaneRepository } from "./repository/chat-execution-lanes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { nativeCommandContext } from "./repository/native-command-context.js";
import { nativeTaskSuspensionContext } from "./repository/native-task-suspension-context.js";
import { nativeHistoryPayloadDigest } from "./repository/native-history-digest.js";
import { assertTaskOperationDispatchFence } from "./task-operation-fence.js";
import type { TaskOperationDispatchFence } from "./task-operation-fence.js";

/** Capture the actual Task input, including its binding when the general Chat
 * runtime has no thread. No lease, inference or restoration authority is granted. */
async function capture(
  tx: RepositoryTransaction,
  owner: string,
  chatId: string,
) {
  const [ownerRow] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, owner))
    .for("update")
    .limit(1);
  if (!ownerRow) return null;
  const [cycle] = await tx
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.ownerId, owner),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .orderBy(
      desc(schema.taskDispatchCycles.createdAt),
      desc(schema.taskDispatchCycles.id),
    )
    .for("update")
    .limit(1);
  if (
    !cycle ||
    cycle.state !== "expired" ||
    cycle.operationKind === "finalize" ||
    cycle.goalInput ||
    !cycle.codexThreadId ||
    !cycle.turnId
  )
    return null;
  const guard = {
    kind: "expired" as const,
    cycleId: cycle.id,
    operationId: cycle.operationId,
    fencingToken: cycle.fencingToken,
  };
  await assertTaskOperationDispatchFence(
    tx,
    owner,
    chatId,
    cycle.operationId,
    guard,
  );
  const [round] = await tx
    .select()
    .from(schema.taskPlanningRounds)
    .where(
      and(
        eq(schema.taskPlanningRounds.chatId, chatId),
        eq(schema.taskPlanningRounds.id, cycle.operationId),
      ),
    )
    .for("update")
    .limit(1);
  const input = round?.inferenceInput;
  if (
    !round ||
    round.status !== "running" ||
    round.kind !== cycle.operationKind ||
    round.relayResult ||
    !input ||
    input.terminal ||
    input.resumption ||
    input.deferred ||
    input.failedBeforeDispatch ||
    !input.accepted ||
    !input.dispatched ||
    !input.allAttemptsEnforced ||
    input.firstDispatchedOperationId !== input.receipt.operationId ||
    input.multipleDispatched ||
    input.receipt.dispatch.fencingToken + 1 !== cycle.fencingToken
  )
    return null;
  await tx.execute(projectChatExecutionLock(owner, chatId));
  const context = await nativeCommandContext(tx, owner, chatId);
  const source = context
    ? await nativeTaskSuspensionContext(tx, context)
    : null;
  const [placement] = await tx
    .select({ chat: schema.chats, task: schema.tasks })
    .from(schema.chats)
    .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
    .where(and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, owner)))
    .for("update")
    .limit(1);
  if (
    !source?.taskRound ||
    !placement ||
    placement.chat.archivedAt ||
    placement.task.activeOperationId !== round.id ||
    placement.task.planningRound !== round.ordinal ||
    source.receipt.dispatch.cycleId !== cycle.id ||
    source.receipt.dispatch.operationId !== cycle.operationId ||
    source.receipt.workerId !== cycle.physicalWorkerId ||
    source.receipt.worktreeId !== cycle.worktreeId ||
    source.receipt.modelRouteId !== cycle.modelRouteId ||
    source.receipt.providerAccountId !== cycle.providerAccountId ||
    source.nativeExecution.threadId !== cycle.codexThreadId ||
    source.nativeExecution.turnId !== cycle.turnId ||
    (placement.chat.nativeSuspensionState &&
      !["stopped", "completed", "failed", "idle"].includes(
        placement.chat.nativeSuspensionState.phase,
      ))
  )
    return null;
  const [lane] = await tx
    .select()
    .from(schema.chatExecutionLanes)
    .where(
      and(
        eq(schema.chatExecutionLanes.chatId, chatId),
        eq(schema.chatExecutionLanes.id, source.receipt.executionLaneId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !lane ||
    lane.state !== "active" ||
    lane.workerId !== source.receipt.workerId ||
    lane.worktreeId !== source.receipt.worktreeId ||
    lane.activatedAt?.toISOString() !== source.receipt.executionLaneActivatedAt
  )
    return null;
  return {
    input,
    snapshot: {
      inputSnapshot: input,
      source: {
        context: source.context,
        taskRound: source.taskRound,
        receipt: source.receipt,
        currentReceipt: source.currentReceipt,
        executionReceipt: source.executionReceipt,
        nativeExecution: source.nativeExecution,
        nativeOwner: source.nativeOwner,
      },
      guard,
      taskRowVersion: placement.task.rowVersion,
      placementRevision: placement.chat.placementRevision,
      managedInputRevision: placement.chat.managedInputRevision,
      nativeSuspension: placement.chat.nativeSuspensionState,
    },
  };
}

export type TaskNativeTurnRecovery = NonNullable<
  Awaited<ReturnType<typeof capture>>
>["snapshot"];

export async function captureTaskNativeTurnRecovery(
  database: RepositoryDatabase,
  owner: string,
  chatId: string,
) {
  return database.transaction(
    async (tx) => (await capture(tx, owner, chatId))?.snapshot ?? null,
  );
}

/** An authenticated read of the original native terminal turn can settle its
 * expired round. Missing/successful/live turns never become synthetic failures.
 * The exact captured authority is rechecked under all write locks after IPC. */
export async function failObservedTaskNativeTurn(
  dependencies: {
    database: RepositoryDatabase;
    lanes?: ChatExecutionLaneRepository;
    fail(
      tx: RepositoryTransaction,
      guard: TaskOperationDispatchFence,
    ): Promise<unknown>;
  },
  owner: string,
  chatId: string,
  expected: TaskNativeTurnRecovery,
  evidence: NativeTurnRecoveryObservation,
) {
  const observed = nativeTurnRecoveryObservationSchema.parse(evidence);
  if (
    !["failed", "interrupted"].includes(observed.status ?? "") ||
    observed.threadId !== expected.source.nativeExecution.threadId ||
    observed.turnId !== expected.source.nativeExecution.turnId ||
    observed.runtimeGeneration === expected.source.nativeOwner.runtimeGeneration
  )
    return false;
  if (!dependencies.lanes)
    throw new Error(
      "Task terminal recovery requires execution lane ownership.",
    );
  return dependencies.database.transaction(async (tx) => {
    const current = await capture(tx, owner, chatId);
    if (!current || !isDeepStrictEqual(current.snapshot, expected))
      return false;
    const { source, guard } = current.snapshot;
    await dependencies.fail(tx, guard);
    await dependencies
      .lanes!.inTransaction(tx)
      .finishChatExecutionLane(
        chatId,
        source.receipt.executionLaneId,
        "failed",
        {
          expectedActivatedAt: source.receipt.executionLaneActivatedAt,
          markUnreadCompletion: true,
        },
      );
    const now = new Date();
    await tx
      .update(schema.tasks)
      .set({
        automaticRetry: {
          status: "idle",
          failureKind: "runtime",
          failureKey: `native-terminal:${guard.cycleId}:${guard.fencingToken}`,
          dueAt: null,
          attempts: [],
          claim: null,
        },
      })
      .where(eq(schema.tasks.chatId, chatId));
    await tx
      .update(schema.taskPlanningRounds)
      .set({
        inferenceInput: {
          ...current.input,
          terminal: {
            ok: false,
            failureKind: "runtime",
            outcomeDigest: nativeHistoryPayloadDigest({
              type: "task-native-terminal-recovery",
              ...observed,
            }),
            observedAt: now.toISOString(),
            projectedAt: now.toISOString(),
            threadId: observed.threadId,
            turnId: observed.turnId,
          },
        },
      })
      .where(eq(schema.taskPlanningRounds.id, guard.operationId));
    await tx
      .update(schema.taskDispatchCycles)
      .set({
        state: "failed",
        eligibilityCode: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.taskDispatchCycles.id, guard.cycleId));
    await tx
      .update(schema.agentInteractionRequests)
      .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(
            schema.agentInteractionRequests.executionLaneId,
            source.receipt.executionLaneId,
          ),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      );
    // The idle marker prevents another peer's legacy-failure adopter from
    // scheduling inference. The precomputed
    // encrypted failure content enables the existing user-requested Retry.
    return true;
  });
}
