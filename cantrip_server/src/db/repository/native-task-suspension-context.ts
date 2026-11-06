import { and, eq } from "drizzle-orm";
import {
  inferenceNativeExecutionSchema,
  taskInferenceInputReceiptSchema,
  type NativeSuspensionTaskRound,
  type NativeSuspensionTarget,
  type NativeSuspensionActor,
  type NativeSuspensionActiveTurn,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import type { ChatExecutionContext } from "./chat-execution-lanes.js";
import { taskCheckpointExecution } from "../task-input-execution-state.js";

/** Actual canonical Task binding. This neither attaches a generic chat runtime
 * nor grants a dispatch lease; cold resumption must acquire fresh Task authority. */
export async function nativeTaskSuspensionContext(
  tx: RepositoryTransaction,
  context: ChatExecutionContext,
) {
  if (context.experience !== "task" || context.contextKind !== "project")
    return null;
  const [item] = await tx
    .select({ round: schema.taskPlanningRounds, task: schema.tasks })
    .from(schema.taskPlanningRounds)
    .innerJoin(
      schema.tasks,
      and(
        eq(schema.tasks.chatId, schema.taskPlanningRounds.chatId),
        eq(schema.tasks.activeOperationId, schema.taskPlanningRounds.id),
      ),
    )
    .where(eq(schema.tasks.chatId, context.chatId))
    .limit(1);
  const state = item?.round.inferenceInput;
  if (
    !item ||
    !state ||
    item.round.status !== "running" ||
    ["complete", "failed"].includes(item.task.state) ||
    !state.accepted ||
    !state.dispatched ||
    state.deferred ||
    state.failedBeforeDispatch ||
    state.terminal ||
    !state.nativeExecution ||
    !state.nativeOwner ||
    state.receipt.kind
  )
    return null;
  const receipt = taskInferenceInputReceiptSchema.parse(state.receipt);
  const physical = taskCheckpointExecution(state);
  const nativeExecution = inferenceNativeExecutionSchema.parse(
    physical.nativeExecution,
  );
  if (
    receipt.chatId !== context.chatId ||
    receipt.workerId !== context.workerId ||
    receipt.worktreeId !== context.worktreeId ||
    receipt.executionLaneId !== context.executionLaneId ||
    receipt.dispatch.operationId !== item.round.id ||
    receipt.clientMessageId !== item.round.userMessageId
  )
    return null;
  const taskRound: NativeSuspensionTaskRound = {
    operationId: item.round.id,
    inputOperationId: receipt.operationId,
    cycleId: receipt.dispatch.cycleId,
  };
  return {
    context: {
      ...context,
      threadId: nativeExecution.threadId,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: receipt.providerAccountId,
    },
    taskRound,
    receipt,
    currentReceipt: state.resumption?.receipt ?? receipt,
    executionReceipt: taskInferenceInputReceiptSchema.parse(physical.receipt),
    nativeExecution,
    nativeOwner: physical.nativeOwner!,
  };
}

/** Claim only the actual physical Task owner; no generic command activation
 * can stand in for this canonical input's native binding. */
export function matchesNativeTaskSuspensionActor(
  source: Awaited<ReturnType<typeof nativeTaskSuspensionContext>>,
  target: NativeSuspensionTarget,
  actor: NativeSuspensionActor | null,
  active: NativeSuspensionActiveTurn | null,
): boolean {
  return Boolean(
    source &&
    actor &&
    active &&
    target.taskRound &&
    target.taskRound.operationId === source.taskRound.operationId &&
    target.taskRound.inputOperationId === source.taskRound.inputOperationId &&
    target.taskRound.cycleId === source.taskRound.cycleId &&
    actor.operationId === source.executionReceipt.operationId &&
    actor.operationGeneration === source.executionReceipt.operationId &&
    actor.workerGeneration === source.nativeOwner.workerGeneration &&
    actor.runtimeGeneration === source.nativeOwner.runtimeGeneration &&
    active.threadId === source.nativeExecution.threadId &&
    active.turnId === source.nativeExecution.turnId,
  );
}
