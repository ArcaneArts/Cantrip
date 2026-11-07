import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { TaskInferenceInputReceipt } from "@cantrip/protocol";
import * as schema from "./schema.js";
import type { RepositoryTransaction } from "./repository/database.js";
import type { TaskInferenceInputState } from "./task-inference-inputs.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";

type Cycle = typeof schema.taskDispatchCycles.$inferSelect;

export function taskGoalExecutionReceipt(
  cycle: Cycle | null | undefined,
  operationId?: string,
) {
  const restored = cycle?.goalCycleRecovery?.suspension?.restoration?.receipt;
  if (
    restored &&
    (operationId === undefined || restored.operationId === operationId)
  )
    return restored;
  const input = cycle?.goalInput;
  return input?.resumption?.receipt ?? input?.receipt;
}

/** Share the existing physical command callbacks without rewriting a completed
 * parent input. The cycle's restoration receipt owns only the saved native turn;
 * it never admits another prompt. The returned view is not a persisted input. */
export function taskGoalExecutionState(
  cycle: Cycle | null | undefined,
  receipt: Partial<Pick<TaskInferenceInputReceipt, "operationId">>,
): TaskInferenceInputState | null {
  const suspension = cycle?.goalCycleRecovery?.suspension;
  if (
    !receipt.operationId ||
    suspension?.restoration?.receipt.operationId !== receipt.operationId
  )
    return cycle?.goalInput ?? null;
  if (
    !cycle?.goalInput ||
    !isDeepStrictEqual(suspension.source.parent, cycle.goalInput.receipt)
  )
    return null;
  const source = suspension.source;
  return {
    ...cycle.goalInput,
    receipt: source.parent,
    publication: source.publication,
    nativeExecution: {
      threadId: source.threadId,
      turnId: source.turnId,
      scopeId: source.cycle.scopeId,
    },
    nativeOwner: {
      workerGeneration: source.workerGeneration,
      runtimeGeneration: source.runtimeGeneration,
    },
    resumption: suspension.restoration,
    terminal: suspension.terminal,
    routeChange: undefined,
  };
}

export async function saveTaskGoalExecutionState(
  tx: RepositoryTransaction,
  cycle: Cycle,
  receipt: Pick<TaskInferenceInputReceipt, "operationId">,
  state: TaskInferenceInputState,
) {
  if (
    cycle.goalCycleRecovery?.suspension?.restoration?.receipt.operationId !==
    receipt.operationId
  ) {
    await tx
      .update(schema.taskDispatchCycles)
      .set({ goalInput: state })
      .where(eq(schema.taskDispatchCycles.id, cycle.id));
    return;
  }
  const marker = cycle.goalCycleRecovery;
  const suspension = marker?.suspension;
  if (
    !suspension?.restoration ||
    !state.resumption ||
    !isDeepStrictEqual(suspension.source.parent, cycle.goalInput?.receipt)
  )
    throw new TaskDispatchConflictError(
      "The restored Goal cycle was replaced.",
      "stale-lease",
    );
  await tx
    .update(schema.taskDispatchCycles)
    .set({
      goalCycleRecovery: {
        ...marker!,
        suspension: {
          ...suspension,
          restoration: { ...suspension.restoration, ...state.resumption },
          ...(state.terminal ? { terminal: state.terminal } : {}),
        },
      },
    })
    .where(eq(schema.taskDispatchCycles.id, cycle.id));
}
