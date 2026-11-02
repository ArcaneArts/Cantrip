import { createChatTurnOutcomeRuntime } from "./chat-turn-outcome-runtime.js";
import {
  managedConsoleSessionContext,
  prepareManagedConsoleLaunch,
} from "../../terminals/managed-session.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { randomUUID } from "node:crypto";
import { protectChatInput } from "./protect-chat-input.js";

import { worktreeStatusResultSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
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
  "availableModelRuntimes" | "resolveModelId" | "routePairsForConfiguration"
> {}

export interface ChatRecoveryRuntimeDependencies
  extends ChatRecoveryMutationDependencies, ChatRecoveryModelDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  beginTurn: BeginChatTurn;
  prepareQueuedAccount?: (
    context: ChatExecutionContext,
  ) => Promise<ChatExecutionContext>;
  continueTaskGoalInWorktree?: (
    context: ChatExecutionContext,
    input: { text: string; idempotencyKey: string },
  ) => Promise<boolean>;
  recoverTaskExecution?: (chatId: string) => Promise<boolean>;
  reconcileTaskExecutions?: (ownerId: string) => Promise<void>;
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
  prepareQueuedAccount,
  continueTaskGoalInWorktree,
  recoverTaskExecution,
  reconcileTaskExecutions,
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
  routePairsForConfiguration,
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
      // Native Goals may keep working while server state is being recovered.
      // Observe/adopt them before an old pending handoff changes placement.
      if (
        current.experience === "task" &&
        (current.status === "offline" || current.status === "failed") &&
        (await recoverTaskExecution?.(chatId))
      )
        return true;

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
        const input = {
          text: transitionText,
          mode: "default" as const,
          idempotencyKey: `worktree-continuation:${pending.lane.id}`,
        };
        if (
          next.experience === "task" &&
          (await continueTaskGoalInWorktree?.(next, input))
        )
          return true;
        const protectedMessage = await protectChatInput(
          bridge,
          next.workerId,
          input,
          [],
          next.reasoningEffort,
          "system",
        );
        const response = {
          id: randomUUID(),
          idempotencyKey: `assistant:${protectedMessage.id}`,
        };
        await beginTurn(next, input, {
          // beginTurn converts Task conversation inputs on the worker and
          // forwards their authenticated mode instead of defaulting to Goal.
          encryptedChatMessages: { userMessage: protectedMessage, response },
          acquiringActor: "agent",
          messageRole: "system",
          purpose: `Controlled ${applied.transitionKind} continuation`,
        });
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
    await runAsOwner(ownerId, () => reconcileTaskExecutions?.(ownerId));
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

  const dispatchNextQueuedPrompt = async (chatId: string): Promise<void> => {
    if (dispatchingChats.has(chatId)) {
      pendingQueueDispatches.add(chatId);
      return;
    }
    dispatchingChats.add(chatId);
    let managedClaim: import("@cantrip/protocol").ManagedQueueClaim | null =
      null;
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
      const managed = managedConsoleSessionContext(context) !== undefined;
      // Transfer an exhausted account before a queue claim takes ownership of
      // its next input. The native handoff and claim serialize on the chat lock.
      if (
        managed &&
        prepareQueuedAccount &&
        (
          await repository.listEncryptedQueuedPrompts(
            applicationOwnerId(),
            chatId,
          )
        ).some((prompt) => !prompt.frozen)
      )
        context = await prepareQueuedAccount(context);
      managedClaim = managed
        ? await repository.managedQueue.claimNext(applicationOwnerId(), chatId)
        : null;
      if (managed && !managedClaim) return;
      const prompt = managedClaim
        ? await repository.getEncryptedQueuedPrompt(
            applicationOwnerId(),
            managedClaim.promptId,
          )
        : (
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
      const executionMethod =
        prompt.executionMethod ??
        (prompt.classification.mode === "goal"
          ? "thread/goal/set"
          : "turn/start");
      if (managedClaim && executionMethod !== "turn/start") {
        const configuration = {
          modelId: prompt.modelId,
          reasoningEffort: prompt.reasoningEffort,
          customSubagentModel: prompt.customSubagentModel,
          subagentModelId: prompt.subagentModelId,
          subagentReasoningEffort: prompt.subagentReasoningEffort,
        };
        await repository.setChatModelConfiguration(
          applicationOwnerId(),
          chatId,
          configuration,
        );
        context = (await repository.getChatExecutionContext(
          applicationOwnerId(),
          chatId,
        ))!;
        const [runtime] = await availableModelRuntimes(context, prompt.modelId);
        if (!runtime)
          throw new Error("The queued action model is unavailable.");
        const launch = await prepareManagedConsoleLaunch(context, runtime, {
          ownerId: applicationOwnerId(),
          repository,
          bridge,
          routePairsForConfiguration,
        });
        await appendLiveEncryptedChatMessage(
          applicationOwnerId(),
          chatId,
          prompt.pendingMessage,
        );
        await bridge.request(context.workerId, {
          type: "chat.queue.execute",
          attachments: prompt.attachments,
          session: launch.session!,
          subagentDefaults: launch.subagentDefaults ?? null,
          mcpServers: launch.mcpServers ?? [],
          planMode: launch.planMode ?? "default",
          executionProfile: "ide",
          chatId,
          cwd: context.cwd,
          threadId: launch.threadId!,
          model: launch.model,
          provider: launch.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
          queueClaim: {
            id: managedClaim.id,
            promptRevision: managedClaim.promptRevision,
          },
          queuedPromptId: prompt.id,
          protectedNativeInput: prompt.protectedNativeInput,
          nativeClientUserMessageId: prompt.nativeClientUserMessageId,
          protectedPrompt: prompt.pendingMessage,
          nativeAction: prompt.nativeAction,
          executionMethod,
        });
        return;
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
          ...(managedClaim
            ? {
                managedQueueClaim: {
                  id: managedClaim.id,
                  promptRevision: managedClaim.promptRevision,
                },
                protectedNativeInput: prompt.protectedNativeInput,
                nativeClientUserMessageId: prompt.nativeClientUserMessageId,
                queuedPromptId: prompt.id,
              }
            : {}),
          encryptedChatMessages: {
            userMessage: prompt.pendingMessage,
            response: {
              id: randomUUID(),
              idempotencyKey: `assistant:${prompt.pendingMessage.id}`,
            },
          },
        },
      );
      if (!managedClaim)
        await deleteLiveQueuedPrompt(applicationOwnerId(), prompt.id);
    } catch (error) {
      if (managedClaim)
        await repository.managedQueue.releaseUnadmitted(
          applicationOwnerId(),
          chatId,
          managedClaim.id,
        );
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

  const recoverChatTurnOutcome = createChatTurnOutcomeRuntime({
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
  });

  return {
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    recoverChatTurnOutcome,
    resolvePromptAttachments,
    resumePendingWorktreeTransitionsForWorker,
  };
}
