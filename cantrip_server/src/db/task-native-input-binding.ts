import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type {
  InferenceNativeExecution,
  TaskInferenceInputReceipt,
} from "@cantrip/protocol";
import type { RepositoryTransaction } from "./repository/database.js";
import type { TaskInferenceInputState } from "./task-inference-inputs.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import * as schema from "./schema.js";

/** The caller holds the actual Task dispatch/input/lane locks. Native Core has
 * bound its scope; recording that identity does not grant or replay input. */
export async function bindTaskNativeInput(
  tx: RepositoryTransaction,
  ownerId: string,
  receipt: TaskInferenceInputReceipt,
  nativeExecution: InferenceNativeExecution,
  state: TaskInferenceInputState,
  nativeOwner: { workerGeneration: string; runtimeGeneration: string },
) {
  const stale = (): never => {
    throw new TaskDispatchConflictError(
      "The Task input cannot change its bound native execution.",
      "stale-lease",
    );
  };
  if (
    state.nativeExecution &&
    !isDeepStrictEqual(state.nativeExecution, nativeExecution)
  )
    stale();
  if (state.nativeOwner && !isDeepStrictEqual(state.nativeOwner, nativeOwner))
    stale();
  const now = new Date();
  const [lane] = await tx
    .update(schema.chatExecutionLanes)
    .set({ codexThreadId: nativeExecution.threadId, updatedAt: now })
    .where(
      and(
        eq(schema.chatExecutionLanes.id, receipt.executionLaneId),
        eq(schema.chatExecutionLanes.state, "active"),
      ),
    )
    .returning({ id: schema.chatExecutionLanes.id });
  const [cycle] = await tx
    .update(schema.taskDispatchCycles)
    .set({
      codexThreadId: nativeExecution.threadId,
      turnId: nativeExecution.turnId,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.taskDispatchCycles.id, receipt.dispatch.cycleId),
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(
          schema.taskDispatchCycles.fencingToken,
          receipt.dispatch.fencingToken,
        ),
      ),
    )
    .returning({ id: schema.taskDispatchCycles.id });
  if (!lane || !cycle) stale();
  await tx
    .update(schema.taskPlanningRounds)
    .set({ inferenceInput: { ...state, nativeExecution, nativeOwner } })
    .where(eq(schema.taskPlanningRounds.id, receipt.dispatch.operationId));
  return {
    receipt,
    nativeExecution,
    nativeRuntimeGeneration: nativeOwner.runtimeGeneration,
  };
}
