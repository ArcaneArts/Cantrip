import { and, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  taskInferenceRouteChangeSchema,
  type NativeRuntimeHandoffQueuedSource,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import type { CurrentTaskGoalHandoff } from "./native-handoff-task-goal.js";
import { NativeCommandError } from "./native-command-errors.js";

export interface TaskGoalInputTransfer {
  lanes: ChatExecutionLaneRepository;
  operationId: string;
  targetModelRouteId: string;
  targetProviderAccountId: string | null;
}

/** Called only after the actual worker sealed this exact unused first input.
 * The canonical encrypted message stays in place; the applied setter is kept
 * in the native history export. Neither can be recreated by this deferral. */
export async function confirmTaskGoalInputHandoff(
  tx: RepositoryTransaction,
  row: CurrentTaskGoalHandoff,
  queued: NativeRuntimeHandoffQueuedSource,
  transfer: TaskGoalInputTransfer,
) {
  const state = row.cycle.goalInput;
  const source = queued.taskGoal?.identity.recovery?.taskInput;
  if (
    !state ||
    !source ||
    !isDeepStrictEqual(state.receipt, source) ||
    state.deferred ||
    state.failedBeforeDispatch ||
    state.firstDispatchedOperationId !== null
  )
    throw new NativeCommandError("handoff-task-goal-input-replaced");
  await transfer.lanes
    .inTransaction(tx)
    .finishChatExecutionLane(source.chatId, source.executionLaneId, "idle", {
      expectedActivatedAt: source.executionLaneActivatedAt,
      markUnreadCompletion: false,
    });
  const [active] = await tx
    .select({ id: schema.chatExecutionLanes.id })
    .from(schema.chatExecutionLanes)
    .where(
      and(
        eq(schema.chatExecutionLanes.chatId, source.chatId),
        eq(schema.chatExecutionLanes.state, "active"),
      ),
    )
    .limit(1);
  if (!active)
    await tx
      .update(schema.chats)
      .set({ status: "idle", updatedAt: new Date() })
      .where(eq(schema.chats.id, source.chatId));
  const change = taskInferenceRouteChangeSchema.parse({
    operationId: transfer.operationId,
    inputOperationId: source.operationId,
    expectedRevision: row.task.rowVersion,
    source,
    phase: "draining",
    targetModelRouteId: transfer.targetModelRouteId,
    targetProviderAccountId: transfer.targetProviderAccountId,
    queuedFencingToken: row.cycle.fencingToken + 1,
    createdAt: new Date().toISOString(),
    completedAt: null,
  });
  await tx
    .update(schema.taskDispatchCycles)
    .set({
      goalInput: { ...state, deferred: true, routeChange: change },
      state: row.paused ? "paused" : "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      fencingToken: sql`${schema.taskDispatchCycles.fencingToken}+1`,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      pausedAt: row.paused ? new Date() : null,
      eligibilityCode: "provider-transfer-pending",
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDispatchCycles.id, row.cycle.id));
}

/** Cancellation restores routing, while the already sealed input remains
 * deferred for its normal Task dispatcher. It never reopens an old receipt. */
export async function cancelTaskGoalInputHandoff(
  tx: RepositoryTransaction,
  chatId: string,
  operationId: string,
  queued: NativeRuntimeHandoffQueuedSource | null | undefined,
) {
  const receipt =
    queued?.taskGoalInput && queued.taskGoal?.identity.recovery?.taskInput;
  if (!receipt || !queued.withdrawn) return;
  const [cycle] = await tx
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .for("update")
    .limit(1);
  const input = cycle?.goalInput;
  if (
    !input?.deferred ||
    input.routeChange?.operationId !== operationId ||
    input.routeChange.phase !== "draining"
  )
    return;
  await tx
    .update(schema.taskDispatchCycles)
    .set({
      goalInput: {
        ...input,
        routeChange: {
          ...input.routeChange,
          phase: "cancelled",
          completedAt: new Date().toISOString(),
        },
      },
      eligibilityCode: null,
    })
    .where(eq(schema.taskDispatchCycles.id, cycle!.id));
}
