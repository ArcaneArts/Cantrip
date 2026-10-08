import type { ChatMessage } from "@cantrip/protocol";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
} from "../../db/repository.js";
import { taskGoalWorkerInterrupted } from "../../chats/execution-helpers.js";
import { errorMessage } from "../../http/request-helpers.js";
import type {
  ChatTurnOptions,
  ChatTurnRuntimeDependencies,
} from "./chat-turn-types.js";

/** Settle one failed submission without replaying uncertain Task Goal input. */
export async function settleChatTurnFailure({
  dependencies: {
    app,
    repository,
    notifyCodeAgentState,
    appendLiveChatMessage,
    cancelChatTurnOutcomeRecovery,
    publishChatTurnBoundary,
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
  },
  error,
  execution,
  userMessage,
  options,
  anyActivity,
  changedPaths,
  encryptedTaskMessages,
  encryptedChatMessages,
  ownerId,
  attribution,
  turnStartedAtMs,
  clearExecutionRequests,
  finishExecution,
}: {
  dependencies: Pick<
    ChatTurnRuntimeDependencies,
    | "app"
    | "repository"
    | "notifyCodeAgentState"
    | "appendLiveChatMessage"
    | "cancelChatTurnOutcomeRecovery"
    | "publishChatTurnBoundary"
    | "continuePendingWorktreeTransition"
    | "dispatchNextQueuedPrompt"
  >;
  error: unknown;
  execution: ChatExecutionContext & { executionLaneId: string };
  userMessage: ChatMessage;
  options: ChatTurnOptions;
  anyActivity: boolean;
  changedPaths: Set<string>;
  encryptedTaskMessages: boolean;
  encryptedChatMessages: boolean;
  ownerId: string;
  attribution: ChatExecutionAttribution;
  turnStartedAtMs: number;
  clearExecutionRequests(): Promise<unknown>;
  finishExecution(
    status: "idle" | "failed",
    pauseAutomation?: boolean,
  ): Promise<boolean>;
}) {
  const workerInterrupted = taskGoalWorkerInterrupted(
    execution.experience,
    userMessage.mode,
    error,
  );
  if (options.structuredResult) {
    try {
      await options.structuredResult.onFailed({
        error,
        execution,
        userMessage,
      });
    } catch (taskError) {
      app.log.error(
        { chatId: execution.chatId, err: taskError },
        "Could not persist a failed Task planning operation",
      );
    }
  }
  if (execution.contextKind === "project") {
    await notifyCodeAgentState(
      execution,
      "failed",
      changedPaths,
      options.preflightWorkerCommandTimeoutMs,
    );
  }
  if (!anyActivity && execution.modelRouteId) {
    await repository.updateChatRuntime(
      execution.chatId,
      execution.workerId,
      execution.worktreeId,
      execution.threadId,
      execution.modelRouteId,
      "ready",
      execution.providerAccountId,
      execution.scratchRootId,
    );
  }
  const interrupted =
    workerInterrupted || /interrupted/i.test(errorMessage(error));
  app.log.error(
    {
      event: interrupted ? "chat.turn.interrupted" : "chat.turn.failed",
      subsystem: "chat-execution",
      operation: "turn",
      status: interrupted ? "interrupted" : "failed",
      reasonCode: workerInterrupted
        ? "worker-unavailable"
        : interrupted
          ? "interrupted"
          : "execution-failed",
      chatId: execution.chatId,
      projectId: execution.projectId,
      workerId: execution.workerId,
      requestId: userMessage.id,
      runId: execution.executionLaneId,
      durationMs: Date.now() - turnStartedAtMs,
      err: encryptedTaskMessages
        ? new Error(
            workerInterrupted
              ? "Encrypted Task turn interrupted because its worker became unavailable. Resume the Task to continue."
              : "Encrypted Task turn failed.",
          )
        : error,
    },
    workerInterrupted
      ? "Task Goal interrupted because its worker became unavailable"
      : "Agent turn failed",
  );
  if (!encryptedTaskMessages && !encryptedChatMessages) {
    await appendLiveChatMessage(
      ownerId,
      execution.chatId,
      {
        role: "system",
        content: [
          {
            type: "text",
            text: interrupted
              ? "Turn interrupted."
              : `Agent failed: ${errorMessage(error)}`,
          },
        ],
        idempotencyKey: `error:${userMessage.id}`,
      },
      attribution,
    );
  }
  await clearExecutionRequests();
  const finished = await finishExecution(
    interrupted || execution.contextKind === "standalone" ? "idle" : "failed",
    workerInterrupted,
  );
  cancelChatTurnOutcomeRecovery(
    execution.workerId,
    execution.chatId,
    userMessage.id,
  );
  publishChatTurnBoundary(execution.chatId, execution.projectId, execution);
  if (options.afterTurnFailed && (!workerInterrupted || finished)) {
    try {
      await options.afterTurnFailed({ error, execution, userMessage });
    } catch (taskError) {
      app.log.error(
        { chatId: execution.chatId, err: taskError },
        "Task post-processing failed after its turn failed",
      );
    }
  }
  if (
    finished &&
    !workerInterrupted &&
    (execution.contextKind === "standalone" ||
      !(await continuePendingWorktreeTransition(execution.chatId)))
  ) {
    void dispatchNextQueuedPrompt(execution.chatId);
  }
}
