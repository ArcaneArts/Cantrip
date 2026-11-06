import type {
  NativeCommandReceipt,
  TaskInferenceInputReceipt,
} from "@cantrip/protocol";
import type { ChatTurnRuntimeDependencies } from "./chat-turn-types.js";

/** Preserve the existing logical input on worker loss. This reads the actual
 * committed suspension and current activation, not an error-message heuristic. */
export async function retainSuspendedChatTurn(
  dependencies: Pick<
    ChatTurnRuntimeDependencies,
    "repository" | "app" | "publishChatSummary"
  >,
  ownerId: string,
  workerId: string,
  receipt: NativeCommandReceipt | null | undefined,
  taskInput?: TaskInferenceInputReceipt,
): Promise<boolean> {
  const stopped = taskInput
    ? await dependencies.repository.nativeSuspensions.taskExecutionStopped(
        ownerId,
        workerId,
        taskInput,
      )
    : null;
  if (stopped && taskInput) {
    dependencies.publishChatSummary(taskInput.chatId, stopped.target.projectId);
    return true;
  }
  const suspension = taskInput
    ? await dependencies.repository.nativeSuspensions.retainTaskExecution(
        ownerId,
        workerId,
        taskInput,
      )
    : receipt
      ? await dependencies.repository.nativeCommands.suspendedExecution(
          ownerId,
          workerId,
          receipt.operationId,
          receipt.operationGeneration,
        )
      : null;
  if (!suspension) return false;
  const chatId = taskInput?.chatId ?? receipt!.chatId;
  dependencies.publishChatSummary(chatId, suspension.target.projectId);
  dependencies.app.log.info(
    {
      event: "chat.turn.suspended",
      subsystem: "chat-execution",
      operation: "retain-suspended-turn",
      status: suspension.phase,
      chatId,
      workerId,
      operationId: taskInput?.operationId ?? receipt!.operationId,
      turnId: suspension.active!.turnId,
    },
    "Suspended native turn retained after its worker submission ended",
  );
  return true;
}
