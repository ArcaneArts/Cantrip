import type { ServerRepository } from "../db/repository.js";
import { NativeCommandError } from "../db/repository/native-command-errors.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

/** A Goal control must reach the actual current root, after any export seal is
 * released or the committed destination is published. This grants no capacity. */
export async function settleTaskGoalHandoffForControl(
  ownerId: string,
  chatId: string,
  dependencies: {
    repository: Pick<ServerRepository, "nativeRuntimeHandoffs">;
    bridge: Pick<WorkerCommandBus, "request">;
  },
): Promise<void> {
  const operations = dependencies.repository.nativeRuntimeHandoffs;
  let state = await operations.activeTaskGoalForChat(ownerId, chatId);
  if (!state) return;
  if (state.phase !== "committed") {
    try {
      state = await operations.requestCancellation(
        ownerId,
        chatId,
        state.operationId,
      );
    } catch (error) {
      if (
        !(error instanceof NativeCommandError) ||
        error.code !== "handoff-already-committed"
      )
        throw error;
      state = await operations.get(ownerId, chatId, state.operationId);
      if (!state) throw error;
    }
  }
  await dependencies.bridge.request(
    state.workerId,
    {
      type: "chat.runtime.handoff",
      chatId,
      operationId: state.operationId,
      intent: state.cancelRequested ? "cancel" : "continue",
    },
    { ownerId, timeoutMs: null },
  );
  const settled = await operations.get(ownerId, chatId, state.operationId);
  if (!settled || !["completed", "cancelled"].includes(settled.phase))
    throw new NativeCommandError(
      "handoff-control-settlement-pending",
      "The provider transfer has not settled. Retry the Goal control after the transfer finishes.",
    );
}
