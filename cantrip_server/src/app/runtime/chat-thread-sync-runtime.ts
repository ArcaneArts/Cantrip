import { agentThreadSyncSchema } from "@cantrip/protocol";

import type { ChatThreadChangeNotification } from "../../chats/thread-change-reconciliation.js";
import { canonicalMessagesFromThreadSync } from "../../chats/thread-sync.js";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import type { createChatRecoveryRuntime } from "./chat-recovery-runtime.js";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

type ChatRecoveryRuntime = ReturnType<typeof createChatRecoveryRuntime>;
type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;
type ReconcileObservedChatThread = (
  chatId: string,
  workerId: string,
  threadId: string,
  changes: ChatThreadChangeNotification["changes"],
) => Promise<void>;

export interface ChatThreadSyncRuntimeDependencies {
  applicationOwnerId: () => string;
  bridge: WorkerCommandBus;
  continuePendingWorktreeTransition: ChatRecoveryRuntime["continuePendingWorktreeTransition"];
  dispatchNextQueuedPrompt: ChatRecoveryRuntime["dispatchNextQueuedPrompt"];
  publishChatInvalidation: LiveMutationRuntime["publishChatInvalidation"];
  publishChatSummary: LiveMutationRuntime["publishChatSummary"];
  recordRuntimeTokenUsage: ModelRoutingRuntime["recordRuntimeTokenUsage"];
  repository: ServerRepository;
  runtimeForContext: ModelRoutingRuntime["runtimeForContext"];
  upsertLiveChatMessage: LiveMutationRuntime["upsertLiveChatMessage"];
}

/** Reconciles protected server chat state with an external Codex thread. */
export function createChatThreadSyncRuntime({
  applicationOwnerId,
  bridge,
  continuePendingWorktreeTransition,
  dispatchNextQueuedPrompt,
  publishChatInvalidation,
  publishChatSummary,
  recordRuntimeTokenUsage,
  repository,
  runtimeForContext,
  upsertLiveChatMessage,
}: ChatThreadSyncRuntimeDependencies) {
  const reconcileChatThread = async (
    context: ChatExecutionContext,
    resolvedRuntime?: ModelRuntime,
  ) => {
    if (context.contextKind !== "project") {
      throw new Error(
        "Standalone Chats cannot synchronize with an external Codex console.",
      );
    }
    if (!context.threadId) {
      return agentThreadSyncSchema.parse({
        threadId: "unavailable",
        status: "idle",
        turns: [],
      });
    }
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const runtime = resolvedRuntime ?? (await runtimeForContext(context));
    if (!runtime) throw new Error("Selected model was not found.");
    const sync = agentThreadSyncSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.sync",
        executionProfile: "ide",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      }),
    );
    let syncExecution = context;
    if (sync.status === "running" && !context.executionLaneId) {
      const acquired = await repository.startChatExecutionLane(
        applicationOwnerId(),
        context.chatId,
        "agent",
        "Linked Codex console turn",
      );
      if (acquired?.contextKind === "project") {
        syncExecution = acquired;
        publishChatSummary(acquired.chatId, acquired.projectId);
      }
    }
    const syncAttribution: ChatExecutionAttribution | undefined =
      syncExecution.executionLaneId
        ? {
            contextKind: "project",
            executionLaneId: syncExecution.executionLaneId,
            worktreeId: syncExecution.worktreeId,
            scratchRootId: null,
          }
        : undefined;
    const canonicalMessages = canonicalMessagesFromThreadSync(sync, {
      idempotencyPrefix: "codex-sync",
      interruptedMessage: "Turn interrupted in the Codex console.",
      failedMessage: "The Codex console turn failed.",
    });
    for (const entry of canonicalMessages) {
      if (entry.activity?.type === "usage") {
        const usageTurnId = entry.activity.correlation?.turnId ?? entry.turnId;
        await recordRuntimeTokenUsage(
          `chat:${context.chatId}:${usageTurnId}`,
          context.projectId,
          context.chatId,
          runtime,
          entry.activity.last,
          {
            workerId: context.workerId,
            turnId: usageTurnId,
            executionAttemptId: `console-sync:${context.chatId}:${usageTurnId}`,
            attemptKind: "console-sync",
            attemptStatus: sync.status === "running" ? "running" : "completed",
          },
        );
      }
      await upsertLiveChatMessage(
        applicationOwnerId(),
        context.chatId,
        entry.message,
        syncAttribution,
      );
    }
    if (sync.turns.length > 0) {
      if (syncExecution.executionLaneId && sync.status !== "running") {
        await repository.finishChatExecutionLane(
          context.chatId,
          syncExecution.executionLaneId,
          sync.status,
        );
      } else {
        await repository.setChatStatus(context.chatId, sync.status);
      }
      publishChatSummary(context.chatId, context.projectId);
      if (sync.status === "idle") {
        if (!(await continuePendingWorktreeTransition(context.chatId))) {
          void dispatchNextQueuedPrompt(context.chatId);
        }
      }
    }
    return sync;
  };

  const reconcileObservedChatThread: ReconcileObservedChatThread = async (
    chatId,
    workerId,
    threadId,
    changes,
  ) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.experience !== "agent" ||
      context.workerId !== workerId ||
      context.threadId !== threadId
    ) {
      return;
    }
    await reconcileChatThread(context);
    if (changes.includes("goal")) {
      publishChatInvalidation(chatId, "chat-goal", null, context);
    }
    if (changes.includes("queue")) {
      publishChatInvalidation(chatId, "chat-queue");
    }
    if (changes.includes("plan")) {
      publishChatInvalidation(chatId, "chat-plan", null, context);
    }
  };

  return { reconcileChatThread, reconcileObservedChatThread };
}
