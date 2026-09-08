import type { NativeCommandReceipt } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { deliverNativeLogicalCompletion } from "./native-logical-completion-delivery.js";

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
    const completion =
      await input.repository.nativeCommands.getLogicalCompletion(
        input.ownerId,
        input.workerId,
        input.receipt.chatId,
        input.receipt.operationId,
        input.receipt.operationGeneration,
      );
    if (completion) {
      await deliverNativeLogicalCompletion(completion, input.bridge);
      await input.repository.nativeCommands.acknowledgeLogicalCompletion(
        completion.ownerId,
        completion.workerId,
        completion.chatId,
        completion.rootOperationId,
        completion.rootOperationGeneration,
      );
    }
  } catch (error) {
    // The completion stays in the durable outbox for independent redelivery.
    input.onAcknowledgementError(error);
  }
  return finished;
}
