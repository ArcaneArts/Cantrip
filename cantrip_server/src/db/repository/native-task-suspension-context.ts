import { and, desc, eq, isNull } from "drizzle-orm";
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
  let state = item?.round.inferenceInput;
  let operationId = item?.round.id;
  let userMessageId = item?.round.userMessageId;
  let goalSource = false;
  if (!item) {
    const [goal] = await tx
      .select({
        cycle: schema.taskDispatchCycles,
        task: schema.tasks,
        round: schema.taskPlanningRounds,
      })
      .from(schema.taskDispatchCycles)
      .innerJoin(
        schema.tasks,
        and(
          eq(schema.tasks.chatId, schema.taskDispatchCycles.chatId),
          isNull(schema.tasks.activeOperationId),
        ),
      )
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
      .where(eq(schema.taskDispatchCycles.chatId, context.chatId))
      .orderBy(
        desc(schema.taskDispatchCycles.createdAt),
        desc(schema.taskDispatchCycles.id),
      )
      .limit(1);
    if (
      !goal ||
      ["complete", "failed"].includes(goal.task.state) ||
      !goal.task.planGoalEnabled ||
      !goal.task.implementationStartedAt ||
      goal.round.kind !== "finalize" ||
      goal.task.planningRound !== goal.round.ordinal ||
      !goal.round.relayResult?.goal ||
      goal.cycle.operationKind !== "finalize" ||
      goal.cycle.goalInput?.receipt.kind !== "goal"
    )
      return null;
    state = goal.cycle.goalInput;
    operationId = goal.cycle.operationId;
    userMessageId = state.receipt.clientMessageId;
    const [message] = await tx
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.id, userMessageId),
          eq(schema.chatMessages.chatId, context.chatId),
        ),
      );
    if (
      !message ||
      message.mode !== "goal" ||
      !["system", "user"].includes(message.role) ||
      !message.taskProtectedContent
    )
      return null;
    goalSource = true;
  }
  if (
    !state ||
    (item &&
      (item.round.status !== "running" ||
        ["complete", "failed"].includes(item.task.state))) ||
    !state.accepted ||
    !state.dispatched ||
    state.deferred ||
    state.failedBeforeDispatch ||
    state.terminal ||
    !state.nativeExecution ||
    !state.nativeOwner ||
    (state.receipt.kind === "goal") !== goalSource
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
    receipt.dispatch.operationId !== operationId ||
    receipt.clientMessageId !== userMessageId
  )
    return null;
  const taskRound: NativeSuspensionTaskRound = {
    operationId: operationId!,
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
