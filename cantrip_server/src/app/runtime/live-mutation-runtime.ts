import { randomUUID } from "node:crypto";

import {
  appLiveEventPayloadSchema,
  chatMessageOpaqueContentSchema,
  chatMessageSchema,
  type AppLiveResource,
  type ChatMessage,
  type ChatMessageOpaqueContent,
  type ChatMessageOpaqueSummary,
  type InferenceProgressUpdate,
  type ReasoningEffort,
} from "@cantrip/protocol";
import {
  taskMessageOpaqueSummarySchema,
  type TaskMessageOpaqueContent,
  type TaskMessageOpaqueSummary,
} from "@cantrip/protocol/tasks";
import type { FastifyInstance } from "fastify";

import type {
  ChatExecutionAttribution,
  ChatLiveRouting,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type { AppLiveHub } from "../../live/hub.js";
import {
  isTaskWorkloadLiveResource,
  type TaskLiveInvalidationRouter,
} from "../../live/task-live-routing.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { ChatLiveResource } from "../shared/live-resources.js";

export interface LiveMutationRuntimeDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  liveHub: Pick<AppLiveHub, "publish">;
  livePublishingEnabled: () => boolean;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  taskLiveInvalidationRouter: TaskLiveInvalidationRouter;
}

/**
 * Owns live chat/task publication and repository mutation wrappers that keep
 * chat, queue, plan, interaction, and automation clients current.
 */
export function createLiveMutationRuntime({
  app,
  applicationOwnerId,
  bridge,
  liveHub,
  livePublishingEnabled,
  publishLiveInvalidation,
  repository,
  taskLiveInvalidationRouter,
}: LiveMutationRuntimeDependencies) {
  const publishProjectAutomationChange = (
    projectId: string,
    automationId: string,
  ): void => {
    publishLiveInvalidation("project-automation", {
      entityId: automationId,
      projectId,
    });
  };
  const publishChatInvalidation = (
    chatId: string,
    resource: ChatLiveResource,
    entityId: string | null = null,
    routing?: ChatLiveRouting,
  ): void => {
    if (!livePublishingEnabled()) return;
    const ownerId = applicationOwnerId();
    try {
      liveHub.publish({
        ownerId,
        scope: { kind: "chat", chatId },
        resource,
        action: "invalidated",
        entityId,
        revision: null,
        payload: null,
      });
    } catch (error) {
      app.log.error(
        { chatId, err: error, resource },
        "Could not publish chat live invalidation",
      );
    }
    if (isTaskWorkloadLiveResource(resource)) {
      void taskLiveInvalidationRouter
        .route({ chatId, entityId, ownerId, resource, routing })
        .catch((error) => {
          app.log.warn(
            { chatId, err: error, resource },
            "Could not publish Task workload invalidation",
          );
        });
    }
  };
  const publishChatMessage = (message: ChatMessage): void => {
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(
          chatMessageSchema.parse(message),
        ),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish persisted chat message",
      );
    }
  };
  const publishInferenceProgress = (
    chatId: string,
    progress: InferenceProgressUpdate,
  ): void => {
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId },
        resource: "inference-progress",
        action: progress.kind === "clear" ? "deleted" : "updated",
        entityId: progress.requestId,
        revision: progress.sequence,
        payload:
          progress.kind === "clear"
            ? null
            : appLiveEventPayloadSchema.parse(progress),
      });
    } catch (error) {
      app.log.error(
        { chatId, err: error, requestId: progress.requestId },
        "Could not publish inference progress",
      );
    }
  };
  const publishTaskMessage = (
    message: TaskMessageOpaqueSummary,
    routing?: ChatLiveRouting,
  ): void => {
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(
          taskMessageOpaqueSummarySchema.parse(message),
        ),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish encrypted Task message",
      );
    }
    publishChatInvalidation(message.chatId, "task", message.id, routing);
  };
  const publishEncryptedChatMessage = (
    message: ChatMessageOpaqueSummary,
  ): void => {
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(message),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish encrypted chat message",
      );
    }
  };
  const appendLiveChatMessage = async (
    ...input: Parameters<typeof repository.appendMessage>
  ): Promise<ChatMessageOpaqueSummary | null> => {
    const [ownerId, chatId, content, attribution] = input;
    if (!content.idempotencyKey) {
      throw new Error("Encrypted chat messages require an idempotency key.");
    }
    const existing = await repository.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      content.idempotencyKey,
    );
    if (existing) return existing;
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (!context || context.experience !== "agent") return null;
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const protectedMessage = chatMessageOpaqueContentSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.message.protect",
        message: {
          ...content,
          id: randomUUID(),
          idempotencyKey: content.idempotencyKey,
        },
        attachments: [],
      }),
    );
    const message = await repository.appendEncryptedMessage(
      ownerId,
      chatId,
      protectedMessage,
      attribution,
    );
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const upsertLiveChatMessage = async (
    ...input: Parameters<typeof repository.upsertMessage>
  ): Promise<ChatMessageOpaqueSummary | null> => {
    const [ownerId, chatId, content, attribution] = input;
    const existing = await repository.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      content.idempotencyKey,
    );
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (!context || context.experience !== "agent") return null;
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const protectedMessage = chatMessageOpaqueContentSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.message.protect",
        message: {
          ...content,
          id: existing?.id ?? randomUUID(),
          idempotencyKey: content.idempotencyKey,
        },
        attachments: [],
      }),
    );
    const message = await repository.upsertEncryptedMessage(
      ownerId,
      chatId,
      protectedMessage,
      attribution,
    );
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const setLiveChatMessageModelRoute = async (
    ...input: Parameters<typeof repository.setMessageModelRoute>
  ): ReturnType<typeof repository.setMessageModelRoute> => {
    const message = await repository.setMessageModelRoute(...input);
    if (message) publishChatMessage(message);
    return message;
  };
  const appendLiveTaskMessage = async (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => {
    const saved = await repository.appendTaskMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishTaskMessage(saved, routing);
    return saved;
  };
  const upsertLiveTaskMessage = async (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => {
    const saved = await repository.upsertTaskMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishTaskMessage(saved, routing);
    return saved;
  };
  const setLiveTaskMessageModelRoute = async (
    ownerId: string,
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
    reasoning?: {
      appliedReasoningEffort: ReasoningEffort | null;
      reasoningAdjusted: boolean;
    },
    routing?: ChatLiveRouting,
  ) => {
    const message = await repository.setTaskMessageModelRoute(
      ownerId,
      messageId,
      modelId,
      runtime,
      reasoning,
    );
    if (message) publishTaskMessage(message, routing);
    return message;
  };
  const appendLiveEncryptedChatMessage = async (
    ownerId: string,
    chatId: string,
    message: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ) => {
    const saved = await repository.appendEncryptedMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishEncryptedChatMessage(saved);
    return saved;
  };
  const upsertLiveEncryptedChatMessage = async (
    ownerId: string,
    chatId: string,
    message: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ) => {
    const saved = await repository.upsertEncryptedMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishEncryptedChatMessage(saved);
    return saved;
  };
  const setLiveEncryptedChatMessageModelRoute = async (
    ...input: Parameters<typeof repository.setEncryptedMessageModelRoute>
  ) => {
    const message = await repository.setEncryptedMessageModelRoute(...input);
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const taskMessageServerStub = (
    message: TaskMessageOpaqueSummary | ChatMessageOpaqueSummary,
  ): ChatMessage => ({
    id: message.id,
    chatId: message.chatId,
    contextKind: "scratchRootId" in message ? message.contextKind : "project",
    worktreeId: message.worktreeId,
    scratchRootId: "scratchRootId" in message ? message.scratchRootId : null,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    content: [],
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    createdAt: message.createdAt,
  });
  const publishChatSummary = (
    chatId: string,
    projectId: string | null,
  ): void => {
    if (projectId) {
      publishLiveInvalidation("chat", { entityId: chatId, projectId });
    } else {
      publishLiveInvalidation("chat", { entityId: chatId });
    }
  };
  const publishChatTurnBoundary = (
    chatId: string,
    projectId: string | null,
    routing?: ChatLiveRouting,
  ): void => {
    publishChatSummary(chatId, projectId);
    publishChatInvalidation(chatId, "chat");
    publishChatInvalidation(chatId, "chat-goal", null, routing);
    publishChatInvalidation(chatId, "chat-plan", null, routing);
  };
  const recordLiveAgentInteractionRequest = async (
    ...input: Parameters<typeof repository.recordAgentInteractionRequest>
  ): ReturnType<typeof repository.recordAgentInteractionRequest> => {
    const interaction = await repository.recordAgentInteractionRequest(
      ...input,
    );
    if (interaction.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const recordLiveEncryptedAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.recordEncryptedAgentInteractionRequest
    >
  ): ReturnType<typeof repository.recordEncryptedAgentInteractionRequest> => {
    const interaction = await repository.recordEncryptedAgentInteractionRequest(
      ...input,
    );
    if (interaction.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const resolveLiveAgentInteractionRequest = async (
    ...input: Parameters<typeof repository.resolveAgentInteractionRequest>
  ): ReturnType<typeof repository.resolveAgentInteractionRequest> => {
    const interaction = await repository.resolveAgentInteractionRequest(
      ...input,
    );
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const resolveLiveEncryptedAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.resolveEncryptedAgentInteractionRequest
    >
  ): ReturnType<typeof repository.resolveEncryptedAgentInteractionRequest> => {
    const interaction =
      await repository.resolveEncryptedAgentInteractionRequest(...input);
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const terminalizeLiveAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.terminalizeAgentInteractionRequestFromWorker
    >
  ): ReturnType<
    typeof repository.terminalizeAgentInteractionRequestFromWorker
  > => {
    const interaction =
      await repository.terminalizeAgentInteractionRequestFromWorker(...input);
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const interruptLiveAgentInteractionRequests = async (
    ...input: Parameters<typeof repository.interruptAgentInteractionRequests>
  ): ReturnType<typeof repository.interruptAgentInteractionRequests> => {
    const interactions = await repository.interruptAgentInteractionRequests(
      ...input,
    );
    const chatId = input[0];
    publishChatInvalidation(chatId, "agent-interaction");
    const projectId = interactions[0]?.projectId;
    if (projectId) publishChatSummary(chatId, projectId);
    return interactions;
  };
  const expireLiveAgentInteractionRequests = async (
    ...input: Parameters<typeof repository.expireAgentInteractionRequests>
  ): ReturnType<typeof repository.expireAgentInteractionRequests> => {
    const interactions = await repository.expireAgentInteractionRequests(
      ...input,
    );
    const chats = new Map<string, string | null>();
    for (const interaction of interactions) {
      if (interaction.provenance.chatId) {
        chats.set(interaction.provenance.chatId, interaction.projectId);
      }
    }
    for (const [chatId, projectId] of chats) {
      publishChatInvalidation(chatId, "agent-interaction");
      publishChatSummary(chatId, projectId);
    }
    return interactions;
  };
  const updateLiveChatPlanMode = async (
    ...input: Parameters<typeof repository.updateChatPlanMode>
  ): ReturnType<typeof repository.updateChatPlanMode> => {
    const state = await repository.updateChatPlanMode(...input);
    if (state) publishChatInvalidation(input[1], "chat-plan");
    return state;
  };
  const updateLiveEncryptedChatPlanState = async (
    ...input: Parameters<typeof repository.updateEncryptedChatPlanState>
  ): ReturnType<typeof repository.updateEncryptedChatPlanState> => {
    const result = await repository.updateEncryptedChatPlanState(...input);
    publishChatInvalidation(input[0], "chat-plan");
    return result;
  };
  const deleteLiveQueuedPrompt = async (
    ...input: Parameters<typeof repository.deleteQueuedPrompt>
  ): ReturnType<typeof repository.deleteQueuedPrompt> => {
    const prompt = await repository.deleteQueuedPrompt(...input);
    if (prompt) publishChatInvalidation(prompt.chatId, "chat-queue", prompt.id);
    return prompt;
  };
  const reorderLiveQueuedPrompts = async (
    ...input: Parameters<typeof repository.reorderQueuedPrompts>
  ): ReturnType<typeof repository.reorderQueuedPrompts> => {
    const reordered = await repository.reorderQueuedPrompts(...input);
    if (reordered) publishChatInvalidation(input[1], "chat-queue");
    return reordered;
  };

  return {
    appendLiveChatMessage,
    appendLiveEncryptedChatMessage,
    appendLiveTaskMessage,
    deleteLiveQueuedPrompt,
    expireLiveAgentInteractionRequests,
    interruptLiveAgentInteractionRequests,
    publishChatInvalidation,
    publishChatSummary,
    publishChatTurnBoundary,
    publishInferenceProgress,
    publishProjectAutomationChange,
    recordLiveAgentInteractionRequest,
    recordLiveEncryptedAgentInteractionRequest,
    reorderLiveQueuedPrompts,
    resolveLiveAgentInteractionRequest,
    resolveLiveEncryptedAgentInteractionRequest,
    setLiveChatMessageModelRoute,
    setLiveEncryptedChatMessageModelRoute,
    setLiveTaskMessageModelRoute,
    taskMessageServerStub,
    terminalizeLiveAgentInteractionRequest,
    updateLiveChatPlanMode,
    updateLiveEncryptedChatPlanState,
    upsertLiveChatMessage,
    upsertLiveEncryptedChatMessage,
    upsertLiveTaskMessage,
  };
}
