import { randomUUID } from "node:crypto";

import {
  chatMessageRelayResultSchema,
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationResultSchema,
  worktreeStatusResultSchema,
  type ChatMessage,
  type WorkerNotification,
} from "@cantrip/protocol";
import { taskMessageRelayResultSchema } from "@cantrip/protocol/tasks";
import type { FastifyInstance } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import {
  outcomeBelongsToLatestLaneTurn,
  shouldRecoverChatTurnOutcome,
} from "../../chats/turn-outcome-recovery.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { parseTaskOperationRelayResult } from "../../tasks/encrypted-relay.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";
import type { BeginChatTurn } from "./chat-turn-runtime.js";

type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;

type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;

interface ChatRecoveryMutationDependencies extends Pick<
  LiveMutationRuntime,
  | "appendLiveChatMessage"
  | "appendLiveEncryptedChatMessage"
  | "appendLiveTaskMessage"
  | "deleteLiveQueuedPrompt"
  | "interruptLiveAgentInteractionRequests"
  | "publishChatInvalidation"
  | "publishChatTurnBoundary"
  | "upsertLiveChatMessage"
> {}

interface ChatRecoveryModelDependencies extends Pick<
  ModelRoutingRuntime,
  "availableModelRuntimes" | "resolveModelId"
> {}

export interface ChatRecoveryRuntimeDependencies
  extends ChatRecoveryMutationDependencies, ChatRecoveryModelDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  beginTurn: BeginChatTurn;
  bridge: LimitedWorkerCommandBus;
  failTaskGoalLaunch: (
    chatId: string,
    operationId: string,
    error: unknown,
  ) => Promise<void>;
  launchPreparedTaskGoal: (
    chatId: string,
    operationId: string,
  ) => Promise<unknown>;
  queueTaskScheduleTick: () => void;
  repository: ServerRepository;
  runAsOwner: OwnerRunner;
}

/**
 * Owns queued prompt dispatch, pending lane transitions, editor preparation,
 * and durable worker turn-outcome recovery.
 */
export function createChatRecoveryRuntime({
  app,
  appendLiveChatMessage,
  appendLiveEncryptedChatMessage,
  appendLiveTaskMessage,
  applicationOwnerId,
  availableModelRuntimes,
  beginTurn,
  bridge,
  deleteLiveQueuedPrompt,
  failTaskGoalLaunch,
  interruptLiveAgentInteractionRequests,
  launchPreparedTaskGoal,
  publishChatInvalidation,
  publishChatTurnBoundary,
  queueTaskScheduleTick,
  repository,
  resolveModelId,
  runAsOwner,
  upsertLiveChatMessage,
}: ChatRecoveryRuntimeDependencies) {
  const dispatchingChats = new Set<string>();
  const pendingQueueDispatches = new Set<string>();
  const progressingWorktreeTransitions = new Set<string>();
  const continuePendingWorktreeTransition = async (
    chatId: string,
  ): Promise<boolean> => {
    if (progressingWorktreeTransitions.has(chatId)) return true;
    progressingWorktreeTransitions.add(chatId);
    try {
      const pending = await repository.getPendingChatWorktreeTransition(
        applicationOwnerId(),
        chatId,
      );
      if (!pending) return false;
      const current = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (!current || chatIsExecuting(current.status)) return true;
      if (current.contextKind !== "project") return false;
      if (current.automationPaused) return true;
      if (!bridge.isConnected(pending.worktree.workerId)) return true;

      try {
        const modelId = await resolveModelId(current);
        await availableModelRuntimes(current, modelId);
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not prepare a pending worktree continuation",
        );
        return true;
      }

      if (pending.lane.transitionKind === "release") {
        const source = await repository.getProjectWorktreeContext(
          applicationOwnerId(),
          current.projectId,
          current.worktreeId,
        );
        if (!source) return true;
        try {
          const status = worktreeStatusResultSchema.parse(
            await bridge.request(source.workerId, {
              type: "worktree.status",
              sourcePath: source.sourcePath,
              worktreePath: source.worktree.path,
            }),
          );
          if (status.status.files.length > 0) {
            await repository.cancelChatWorktreeTransition(
              applicationOwnerId(),
              chatId,
              pending.lane.id,
            );
            await appendLiveChatMessage(applicationOwnerId(), chatId, {
              role: "system",
              content: [
                {
                  type: "text",
                  text: "Worktree release was cancelled because new uncommitted changes appeared before the turn finished.",
                },
              ],
              idempotencyKey: `transition-cancelled:${pending.lane.id}`,
            });
            return false;
          }
        } catch (error) {
          app.log.error(
            { chatId, err: error },
            "Could not verify a pending worktree release",
          );
          return true;
        }
      }
      const applied = await repository.applyChatWorktreeTransition(
        applicationOwnerId(),
        chatId,
        pending.lane.id,
      );
      if (!applied) return true;
      const next = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (!next) return true;
      const transitionText =
        applied.transitionKind === "release"
          ? `Returned to Primary after releasing the previous worktree. Continue the user's request from this checkout.`
          : `Continued in ${applied.worktree.name}${applied.worktree.branch ? ` (${applied.worktree.branch})` : ""}. Continue the user's request from this checkout.`;
      try {
        await beginTurn(
          next,
          {
            text: transitionText,
            idempotencyKey: `worktree-continuation:${pending.lane.id}`,
          },
          {
            acquiringActor: "agent",
            messageRole: "system",
            purpose: `Controlled ${applied.transitionKind} continuation`,
          },
        );
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not start a worktree continuation",
        );
        await appendLiveChatMessage(
          applicationOwnerId(),
          chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: `The chat moved to ${applied.worktree.name}, but its automatic continuation could not start: ${errorMessage(error)}`,
              },
            ],
            idempotencyKey: `worktree-continuation-error:${pending.lane.id}`,
          },
          {
            executionLaneId: pending.lane.id,
            worktreeId: applied.worktree.id,
          },
        );
      }
      return true;
    } finally {
      progressingWorktreeTransitions.delete(chatId);
    }
  };

  const resumePendingWorktreeTransitionsForWorker = async (
    ownerId: string,
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const chatIds = await repository.listPendingWorktreeTransitionChatIds(
      ownerId,
      workerId,
    );
    await Promise.allSettled(
      chatIds.map(async (chatId) => {
        try {
          await runAsOwner(ownerId, () =>
            continuePendingWorktreeTransition(chatId),
          );
        } catch (error) {
          app.log.error(
            { chatId, err: error, workerId },
            "Could not recover a pending worktree transition",
          );
        }
      }),
    );
  };

  const resolvePromptAttachments = async (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => {
    const attachments = await repository.getChatAttachments(
      applicationOwnerId(),
      context.chatId,
      attachmentIds,
    );
    if (attachments.length !== attachmentIds.length) {
      throw new Error("One or more attachments are unavailable.");
    }
    if (attachments.some(({ workerId }) => workerId !== context.workerId)) {
      throw new Error("Attachments belong to another worker.");
    }
    return attachments;
  };

  const prepareCodeEditorsForTurn = async (
    context: ChatExecutionContext,
    timeoutMs?: number | null,
  ): Promise<void> => {
    const result = codeAgentTurnPreparationResultSchema.parse(
      await bridge.request(
        context.workerId,
        {
          type: "code.prepareAgentTurn",
          cwd: context.cwd,
        },
        timeoutMs === undefined ? undefined : { timeoutMs },
      ),
    );
    if (result.prepared) return;
    const blocked = result.sessions.filter((session) => !session.allowed);
    const files = [
      ...new Set(
        blocked.flatMap((session) =>
          session.dirtyEditors.map(
            (editor) => editor.relativePath ?? editor.uri,
          ),
        ),
      ),
    ];
    const reason =
      blocked.find((session) => session.reason)?.reason ??
      "Cantrip Code could not establish a saved-file boundary.";
    app.log.warn(
      {
        event: "code.agent-turn-preparation-blocked",
        subsystem: "code",
        operation: "prepare-agent-turn",
        status: "blocked",
        reasonCode: "saved-file-boundary-unavailable",
        chatId: context.chatId,
        projectId: context.projectId,
        workerId: context.workerId,
        counts: {
          blockedSessions: blocked.length,
          dirtyEditors: files.length,
          failedEditors: blocked.reduce(
            (total, session) => total + session.failed.length,
            0,
          ),
        },
        err: new Error(reason),
      },
      "Cantrip Code blocked agent turn preparation",
    );
    throw new Error(
      `${reason}${files.length ? ` Dirty editors: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}.` : ""}`,
    );
  };

  const notifyCodeAgentState = async (
    context: Pick<ChatExecutionContext, "chatId" | "cwd" | "workerId">,
    phase: "started" | "completed" | "failed",
    paths: Iterable<string> = [],
  ): Promise<void> => {
    try {
      codeAgentTurnNotificationResultSchema.parse(
        await bridge.request(context.workerId, {
          type: "code.agentTurnState",
          cwd: context.cwd,
          phase,
          paths: [...paths].slice(0, 5_000),
        }),
      );
    } catch (error) {
      app.log.warn(
        { chatId: context.chatId, err: error, phase },
        "Could not synchronize the agent turn with Cantrip Code",
      );
    }
  };

  const dispatchNextQueuedPrompt = async (chatId: string): Promise<void> => {
    if (dispatchingChats.has(chatId)) {
      pendingQueueDispatches.add(chatId);
      return;
    }
    dispatchingChats.add(chatId);
    try {
      let context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (
        !context ||
        context.automationPaused ||
        chatIsExecuting(context.status)
      )
        return;
      const prompt = (
        await repository.listEncryptedQueuedPrompts(
          applicationOwnerId(),
          chatId,
        )
      ).find((candidate) => !candidate.frozen);
      if (!prompt) return;
      app.log.info(
        {
          event: "chat.queue.dispatching",
          subsystem: "chat-queue",
          operation: "dispatch-prompt",
          status: "dispatching",
          chatId,
          requestId: prompt.id,
        },
        "Queued prompt is being dispatched",
      );
      if (
        context.contextKind === "project" &&
        prompt.worktreeId &&
        prompt.worktreeId !== context.worktreeId
      ) {
        await repository.updateChatWorktree(applicationOwnerId(), chatId, {
          worktreeId: prompt.worktreeId,
          mode: context.worktreeMode,
        });
        context = await repository.getChatExecutionContext(
          applicationOwnerId(),
          chatId,
        );
        if (!context) return;
      }
      await beginTurn(
        context,
        {
          text: "Encrypted queued prompt.",
          attachmentIds: prompt.classification.attachmentIds,
          mode: prompt.classification.mode,
          modelId: prompt.modelId,
          reasoningEffort: prompt.reasoningEffort,
          customSubagentModel: prompt.customSubagentModel,
          subagentModelId: prompt.subagentModelId,
          subagentReasoningEffort: prompt.subagentReasoningEffort,
          idempotencyKey: prompt.pendingMessage.idempotencyKey,
        },
        {
          encryptedChatMessages: {
            userMessage: prompt.pendingMessage,
            response: {
              id: randomUUID(),
              idempotencyKey: `assistant:${prompt.pendingMessage.id}`,
            },
          },
        },
      );
      await deleteLiveQueuedPrompt(applicationOwnerId(), prompt.id);
    } catch (error) {
      app.log.error(
        {
          event: "chat.queue.dispatch-failed",
          subsystem: "chat-queue",
          operation: "dispatch-prompt",
          reasonCode: "dispatch-failed",
          status: "failed",
          chatId,
          err: error,
        },
        "Queued prompt dispatch failed",
      );
    } finally {
      dispatchingChats.delete(chatId);
      if (pendingQueueDispatches.delete(chatId)) {
        void dispatchNextQueuedPrompt(chatId);
      }
    }
  };

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
    if (
      !laneContext ||
      !shouldRecoverChatTurnOutcome(
        {
          ...laneContext.lane,
          scratchRootId: laneContext.lane.scratchRootId ?? null,
        },
        workerId,
        notification.worktreeId,
        notification.scratchRootId,
      )
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

    await interruptLiveAgentInteractionRequests(notification.chatId);
    const finished = await repository.finishChatExecutionLane(
      notification.chatId,
      notification.executionLaneId,
      recoveredOutcomeOk ? "idle" : "failed",
    );
    let recoveredFailedStatus = false;
    if (!finished && notification.outcome.ok) {
      const current = await repository.getChatExecutionContext(
        ownerId,
        notification.chatId,
      );
      if (current?.status === "failed" && !current.executionLaneId) {
        await repository.setChatStatus(notification.chatId, "idle");
        recoveredFailedStatus = true;
      }
    }
    if (notification.contextKind === "project" && "worktree" in laneContext) {
      await notifyCodeAgentState(
        {
          chatId: notification.chatId,
          cwd: laneContext.worktree.path,
          workerId,
        },
        recoveredOutcomeOk ? "completed" : "failed",
      );
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

  return {
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    notifyCodeAgentState,
    prepareCodeEditorsForTurn,
    recoverChatTurnOutcome,
    resolvePromptAttachments,
    resumePendingWorktreeTransitionsForWorker,
  };
}
