import type { NativeCommandReceipt } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

/** Release native successors only after the logical GUI lane has durably finished. */
export async function finishManagedGui(input: {
  repository: Pick<ServerRepository, "nativeCommands">;
  bridge: Pick<WorkerCommandBus, "request">;
  ownerId: string;
  workerId: string;
  receipt: NativeCommandReceipt;
  status: "idle" | "failed";
  onAcknowledgementError(error: unknown): void;
}): Promise<boolean> {
  const finished = await input.repository.nativeCommands.finishLogicalGui(
    input.ownerId,
    input.workerId,
    input.receipt.operationId,
    input.receipt.operationGeneration,
    input.status,
  );
  try {
    await input.bridge.request(
      input.workerId,
      {
        type: "chat.native-logical.complete",
        chatId: input.receipt.chatId,
        rootOperationId: input.receipt.operationId,
        rootOperationGeneration: input.receipt.operationGeneration,
      },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    // The database result remains authoritative if the worker transport ended.
    input.onAcknowledgementError(error);
  }
  return finished;
}
