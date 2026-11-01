import { finishManagedGui } from "./finish-managed-gui.js";
import {
  chatMessageRelayResultSchema,
  type WorkerNotification,
} from "@cantrip/protocol";
import { taskMessageRelayResultSchema } from "@cantrip/protocol/tasks";
import {
  outcomeBelongsToLatestLaneTurn,
  shouldRecoverChatTurnOutcome,
} from "../../chats/turn-outcome-recovery.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import type { ChatExecutionAttribution } from "../../db/repository.js";
import { parseTaskOperationRelayResult } from "../../tasks/encrypted-relay.js";
import type { ChatRecoveryRuntimeDependencies } from "./chat-recovery-runtime.js";

type Dependencies = Pick<
  ChatRecoveryRuntimeDependencies,
  | "app"
  | "repository"
  | "bridge"
  | "appendLiveTaskMessage"
  | "appendLiveEncryptedChatMessage"
  | "upsertLiveChatMessage"
  | "interruptLiveAgentInteractionRequests"
  | "publishChatTurnBoundary"
  | "publishChatInvalidation"
  | "launchPreparedTaskGoal"
  | "failTaskGoalLaunch"
  | "queueTaskScheduleTick"
> & {
  continuePendingWorktreeTransition: (chatId: string) => Promise<boolean>;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
};

/** Saved worker outcomes share the live turn's durable mutation boundaries. */
export function createChatTurnOutcomeRuntime({
  app,
  repository,
  bridge,
  appendLiveTaskMessage,
  appendLiveEncryptedChatMessage,
  upsertLiveChatMessage,
  interruptLiveAgentInteractionRequests,
  publishChatTurnBoundary,
  publishChatInvalidation,
  launchPreparedTaskGoal,
  failTaskGoalLaunch,
  queueTaskScheduleTick,
  continuePendingWorktreeTransition,
  dispatchNextQueuedPrompt,
}: Dependencies) {
  async function recoverChatTurnOutcome(
    ownerId: string,
    workerId: string,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ): Promise<void> {
    const laneContext = await repository.getChatExecutionRecoveryContext(
      ownerId,
      notification.chatId,
      notification.executionLaneId,
    );
    const logicalRoot =
      notification.nativeLogicalRoot && notification.contextKind === "project"
        ? await repository.nativeCommands.logicalGuiOutcomeRoot(
            ownerId,
            workerId,
            {
              chatId: notification.chatId,
              executionLaneId: notification.executionLaneId,
              clientMessageId: notification.clientMessageId,
              worktreeId: notification.worktreeId,
              nativeLogicalRoot: notification.nativeLogicalRoot,
              ...(notification.outcome.ok
                ? {
                    threadId: notification.outcome.result.threadId,
                    turnId: notification.outcome.result.turnId,
                  }
                : {}),
            },
          )
        : null;
    if (
      !laneContext ||
      (notification.nativeLogicalRoot && !logicalRoot) ||
      (!logicalRoot &&
        !shouldRecoverChatTurnOutcome(
          {
            ...laneContext.lane,
            scratchRootId: laneContext.lane.scratchRootId ?? null,
          },
          workerId,
          notification.worktreeId,
          notification.scratchRootId,
        ))
    ) {
      app.log.warn(
        {
          chatId: notification.chatId,
          clientMessageId: notification.clientMessageId,
          executionLaneId: notification.executionLaneId,
          workerId,
        },
        "Ignored an agent turn outcome outside its execution lane",
      );
      return;
    }

    const messages = await repository.listMessageHeaders(
      ownerId,
      notification.chatId,
    );
    if (
      !outcomeBelongsToLatestLaneTurn(
        messages,
        notification.executionLaneId,
        notification.clientMessageId,
      )
    ) {
      app.log.warn(
        {
          chatId: notification.chatId,
          clientMessageId: notification.clientMessageId,
          executionLaneId: notification.executionLaneId,
          workerId,
        },
        "Ignored a stale agent turn outcome after the execution lane advanced",
      );
      return;
    }

    const attribution: ChatExecutionAttribution =
      notification.contextKind === "standalone"
        ? {
            contextKind: "standalone",
            executionLaneId: notification.executionLaneId,
            worktreeId: null,
            scratchRootId: notification.scratchRootId!,
          }
        : {
            contextKind: "project",
            executionLaneId: notification.executionLaneId,
            worktreeId: notification.worktreeId!,
            scratchRootId: null,
          };
    const taskOperation =
      notification.contextKind === "project"
        ? await repository.tasks.getOperationContext(
            ownerId,
            notification.chatId,
            {
              executionLaneId: notification.executionLaneId,
              userMessageId: notification.clientMessageId,
            },
          )
        : null;
    const taskDispatchFence = notification.taskDispatchFence;
    if (taskDispatchFence) {
      if (
        !taskOperation ||
        taskOperation.round.id !== taskDispatchFence.operationId
      ) {
        app.log.warn(
          {
            chatId: notification.chatId,
            cycleId: taskDispatchFence.cycleId,
            operationId: taskDispatchFence.operationId,
          },
          "Ignored a Task outcome without its claimed operation",
        );
        return;
      }
      try {
        await repository.taskDispatch.heartbeat(taskDispatchFence);
      } catch (error) {
        if (error instanceof TaskDispatchConflictError) {
          app.log.warn(
            {
              chatId: notification.chatId,
              cycleId: taskDispatchFence.cycleId,
              operationId: taskDispatchFence.operationId,
            },
            "Ignored a stale fenced Task outcome",
          );
          return;
        }
        throw error;
      }
    }
    let recoveredOutcomeOk = notification.outcome.ok;
    let recoveredFinalizationOperationId: string | null = null;
    if (taskOperation) {
      if (notification.outcome.ok) {
        try {
          const relayResult = parseTaskOperationRelayResult(
            notification.outcome.result.structuredResult,
            taskOperation.relayRequest,
          );
          await repository.tasks.completeOperation(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
            relayResult,
            notification.outcome.result.turnId ?? null,
          );
          if (taskOperation.round.kind === "finalize") {
            recoveredFinalizationOperationId = taskOperation.round.id;
          }
          const assistantMessage = await appendLiveTaskMessage(
            ownerId,
            notification.chatId,
            relayResult.assistantMessage,
            attribution,
            laneContext.chat,
          );
          if (!assistantMessage) {
            throw new Error("Task Chat was not found.");
          }
          await repository.tasks.attachOperationAssistantMessage(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
            assistantMessage.id,
          );
          publishChatInvalidation(
            notification.chatId,
            "task",
            null,
            laneContext.chat,
          );
        } catch (error) {
          recoveredOutcomeOk = false;
          await repository.tasks.failOperation(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
          );
          publishChatInvalidation(
            notification.chatId,
            "task",
            null,
            laneContext.chat,
          );
        }
      } else {
        recoveredOutcomeOk = false;
        await repository.tasks.failOperation(
          ownerId,
          notification.chatId,
          taskOperation.round.id,
        );
        publishChatInvalidation(
          notification.chatId,
          "task",
          null,
          laneContext.chat,
        );
      }
    }
    if (taskDispatchFence) {
      try {
        await repository.taskDispatch.settle(
          taskDispatchFence,
          recoveredOutcomeOk ? "succeeded" : "failed",
        );
      } catch (error) {
        if (!(error instanceof TaskDispatchConflictError)) throw error;
      }
      queueTaskScheduleTick();
    }
    const assistantKey = `assistant:${notification.clientMessageId}`;
    const errorKey = `error:${notification.clientMessageId}`;
    const taskChat =
      notification.contextKind === "project" &&
      laneContext.chat.experience === "task";
    const existingAssistant = taskChat
      ? null
      : await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          notification.chatId,
          assistantKey,
        );
    const existingError = taskChat
      ? null
      : await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          notification.chatId,
          errorKey,
        );

    if (notification.outcome.ok) {
      await repository.updateChatExecutionLaneRuntime(
        notification.chatId,
        notification.executionLaneId,
        notification.outcome.result.threadId,
        "ready",
      );
      if (taskChat && !taskOperation) {
        try {
          const encrypted = taskMessageRelayResultSchema.parse(
            notification.outcome.result.structuredResult,
          );
          await appendLiveTaskMessage(
            ownerId,
            notification.chatId,
            encrypted.message,
            attribution,
            laneContext.chat,
          );
        } catch {
          recoveredOutcomeOk = false;
        }
      } else if (
        notification.contextKind === "standalone" &&
        !existingAssistant
      ) {
        const encrypted = chatMessageRelayResultSchema.parse(
          notification.outcome.result.structuredResult,
        );
        if (!encrypted.message) {
          throw new Error("Standalone Chat outcome omitted protected content.");
        }
        await appendLiveEncryptedChatMessage(
          ownerId,
          notification.chatId,
          encrypted.message,
          attribution,
        );
      } else if (!taskOperation && !existingAssistant) {
        await upsertLiveChatMessage(
          ownerId,
          notification.chatId,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  notification.outcome.result.text ||
                  "The agent completed without a message.",
                phase: "final_answer",
              },
            ],
            idempotencyKey: existingError ? errorKey : assistantKey,
          },
          attribution,
        );
      }
    } else if (
      notification.contextKind === "project" &&
      !taskChat &&
      !taskOperation &&
      !existingAssistant
    ) {
      await repository.updateChatExecutionLaneRuntime(
        notification.chatId,
        notification.executionLaneId,
        laneContext.lane.codexThreadId,
        "ready",
      );
      await upsertLiveChatMessage(
        ownerId,
        notification.chatId,
        {
          role: "system",
          content: [
            {
              type: "text",
              text: `Agent failed: ${notification.outcome.error}`,
            },
          ],
          idempotencyKey: errorKey,
        },
        attribution,
      );
    }

    await interruptLiveAgentInteractionRequests(
      notification.chatId,
      notification.executionLaneId,
    );
    const finished = logicalRoot
      ? await finishManagedGui({
          repository,
          bridge,
          ownerId,
          workerId,
          receipt: logicalRoot,
          status: recoveredOutcomeOk ? "idle" : "failed",
          onAcknowledgementError: (error) =>
            app.log.warn(
              { err: error, chatId: notification.chatId },
              "Recovered logical completion remains queued for acknowledgment",
            ),
        })
      : await repository.finishChatExecutionLane(
          notification.chatId,
          notification.executionLaneId,
          recoveredOutcomeOk ? "idle" : "failed",
        );
    let recoveredFailedStatus = false;
    if (!logicalRoot && !finished && notification.outcome.ok) {
      const current = await repository.getChatExecutionContext(
        ownerId,
        notification.chatId,
      );
      if (current?.status === "failed" && !current.executionLaneId) {
        await repository.setChatStatus(notification.chatId, "idle");
        recoveredFailedStatus = true;
      }
    }
    publishChatTurnBoundary(
      notification.chatId,
      laneContext.chat.projectId,
      laneContext.chat,
    );
    if (recoveredFinalizationOperationId && recoveredOutcomeOk) {
      try {
        await launchPreparedTaskGoal(
          notification.chatId,
          recoveredFinalizationOperationId,
        );
      } catch (error) {
        await failTaskGoalLaunch(
          notification.chatId,
          recoveredFinalizationOperationId,
          error,
        );
      }
    }
    app.log.info(
      {
        event: "chat.turn.outcome-recovered",
        subsystem: "chat-execution",
        operation: "recover-outcome",
        status: recoveredOutcomeOk ? "completed" : "failed",
        chatId: notification.chatId,
        clientMessageId: notification.clientMessageId,
        executionLaneId: notification.executionLaneId,
        outcome: notification.outcome.ok ? "completed" : "failed",
        ...(notification.outcome.ok
          ? {
              responseCharacterCount: notification.outcome.result.text.length,
              threadId: notification.outcome.result.threadId,
              turnId: notification.outcome.result.turnId,
            }
          : { reasonCode: "worker-reported-failure" }),
        workerId,
      },
      "Recovered agent turn outcome from worker",
    );
    if (finished || recoveredFailedStatus) {
      if (
        notification.contextKind === "standalone" ||
        !(await continuePendingWorktreeTransition(notification.chatId))
      ) {
        void dispatchNextQueuedPrompt(notification.chatId);
      }
    }
  }

  return recoverChatTurnOutcome;
}
