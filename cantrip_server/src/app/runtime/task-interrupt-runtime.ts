import { chatInterruptAcceptedSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { settleTaskGoalHandoffForControl } from "../../terminals/task-goal-handoff-control.js";
import { ChatAutomationPauseError } from "./chat-automation-pause-error.js";
import { errorMessage } from "../../http/request-helpers.js";

/** Stop closes future Task admission before selecting the actual current root.
 * Native execution, not cached chat status or a model lookup, decides what ends. */
export async function interruptTask(
  ownerId: string,
  chatId: string,
  dependencies: {
    repository: Pick<
      ServerRepository,
      "taskAutomationPause" | "nativeRuntimeHandoffs"
    >;
    bridge: Pick<WorkerCommandBus, "request">;
    publishChatSummary(chatId: string, projectId: string | null): void;
  },
) {
  const { repository, bridge, publishChatSummary } = dependencies;
  const original = await repository.taskAutomationPause.request(
    ownerId,
    chatId,
    true,
  );
  if (!original)
    throw new ChatAutomationPauseError(404, "Task source not found.");
  try {
    await settleTaskGoalHandoffForControl(ownerId, chatId, dependencies);
    const current = await repository.taskAutomationPause.fenceInterrupt(
      ownerId,
      chatId,
      original.scope.revision,
    );
    if (
      !current ||
      !current.paused ||
      current.scope.revision !== original.scope.revision
    )
      return { interrupted: false };
    return chatInterruptAcceptedSchema.parse(
      await bridge.request(
        current.scope.workerId,
        {
          type: "chat.interrupt",
          executionProfile: "ide",
          chatId,
          threadId: current.scope.threadId,
          task: current.scope,
        },
        { ownerId, timeoutMs: null },
      ),
    );
  } catch (error) {
    throw new ChatAutomationPauseError(
      502,
      `The worker could not confirm this Task interruption: ${errorMessage(error)}`,
    );
  } finally {
    publishChatSummary(chatId, original.scope.projectId);
  }
}
