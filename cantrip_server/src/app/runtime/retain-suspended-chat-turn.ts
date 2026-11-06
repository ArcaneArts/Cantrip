import type { NativeCommandReceipt } from "@cantrip/protocol";
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
): Promise<boolean> {
  if (!receipt) return false;
  const suspension =
    await dependencies.repository.nativeCommands.suspendedExecution(
      ownerId,
      workerId,
      receipt.operationId,
      receipt.operationGeneration,
    );
  if (!suspension) return false;
  dependencies.publishChatSummary(receipt.chatId, suspension.target.projectId);
  dependencies.app.log.info(
    {
      event: "chat.turn.suspended",
      subsystem: "chat-execution",
      operation: "retain-suspended-turn",
      status: suspension.phase,
      chatId: receipt.chatId,
      workerId,
      operationId: receipt.operationId,
      turnId: suspension.active!.turnId,
    },
    "Suspended native turn retained after its worker submission ended",
  );
  return true;
}
