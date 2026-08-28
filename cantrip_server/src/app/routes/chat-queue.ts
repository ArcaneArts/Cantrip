import { randomUUID } from "node:crypto";

import {
  encryptedChatPromptSteerResultSchema,
  encryptedQueuedPromptListSchema,
  encryptedQueuedPromptSchema,
  encryptedQueuedPromptUpdateSchema,
  queuedPromptOpaqueContentSchema,
  queuedPromptOrderSchema,
  type ChatMessageOpaqueSummary,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import {
  toChatAttachmentOpaqueSummary,
  type ChatExecutionContext,
  type ModelRuntime,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ChatTurnStarter } from "./chat-turn-contracts.js";

export interface ChatQueueRouteDependencies {
  appendLiveEncryptedChatMessage: (
    ...input: Parameters<ServerRepository["appendEncryptedMessage"]>
  ) => ReturnType<ServerRepository["appendEncryptedMessage"]>;
  applicationOwnerId: () => string;
  beginTurn: ChatTurnStarter;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  deleteLiveQueuedPrompt: (
    ...input: Parameters<ServerRepository["deleteQueuedPrompt"]>
  ) => ReturnType<ServerRepository["deleteQueuedPrompt"]>;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
  reorderLiveQueuedPrompts: (
    ...input: Parameters<ServerRepository["reorderQueuedPrompts"]>
  ) => ReturnType<ServerRepository["reorderQueuedPrompts"]>;
  repository: Pick<
    ServerRepository,
    | "createEncryptedQueuedPrompt"
    | "getChatExecutionContext"
    | "getEncryptedMessageByIdempotencyKey"
    | "getEncryptedQueuedPrompt"
    | "listEncryptedQueuedPrompts"
    | "replaceEncryptedQueuedPrompt"
    | "updateChatWorktree"
  >;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  resolvePromptAttachments: (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => ReturnType<ServerRepository["getChatAttachments"]>;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
}

/** Registers encrypted queued-prompt lifecycle and steering routes. */
export function installChatQueueRoutes(
  app: FastifyInstance,
  {
    appendLiveEncryptedChatMessage,
    applicationOwnerId,
    beginTurn,
    bridge,
    deleteLiveQueuedPrompt,
    dispatchNextQueuedPrompt,
    reorderLiveQueuedPrompts,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  }: ChatQueueRouteDependencies,
): void {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (context?.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      return reply.send(
        encryptedQueuedPromptListSchema.parse(
          await repository.listEncryptedQueuedPrompts(
            applicationOwnerId(),
            request.params.chatId,
          ),
        ),
      );
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const input = queuedPromptOpaqueContentSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      let modelId: string;
      let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
      try {
        modelId = await resolveModelId(context, input.data.modelId);
        attachments = await resolvePromptAttachments(
          context,
          input.data.classification.attachmentIds,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (modelId !== input.data.modelId) {
        return reply.code(409).send({ error: "Selected model was not found." });
      }
      const prompt = await repository.createEncryptedQueuedPrompt(
        applicationOwnerId(),
        context.chatId,
        input.data,
        attachments.map((attachment) =>
          toChatAttachmentOpaqueSummary(attachment),
        ),
      );
      if (!prompt) return reply.code(404).send({ error: "Chat not found." });
      app.log.info(
        {
          event: "chat.queue.enqueued",
          subsystem: "chat-queue",
          operation: "enqueue-prompt",
          status: prompt.frozen ? "frozen" : "queued",
          chatId: context.chatId,
          requestId: prompt.id,
          counts: { attachments: prompt.attachments.length },
        },
        "Chat prompt queued",
      );
      if (!prompt.frozen) void dispatchNextQueuedPrompt(context.chatId);
      return reply.code(201).send(encryptedQueuedPromptSchema.parse(prompt));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue/order",
    async (request, reply) => {
      const input = queuedPromptOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const reordered = await reorderLiveQueuedPrompts(
        applicationOwnerId(),
        request.params.chatId,
        input.data,
      );
      return reordered
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Queued prompt order is invalid." });
    },
  );

  app.patch<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const input = encryptedQueuedPromptUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const current = await repository.getEncryptedQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
      );
      if (!current) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      const promptContext = await repository.getChatExecutionContext(
        applicationOwnerId(),
        current.chatId,
      );
      if (!promptContext) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (promptContext?.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
      try {
        attachments = await resolvePromptAttachments(
          promptContext,
          input.data.prompt.classification.attachmentIds,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      const prompt = await repository.replaceEncryptedQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
        input.data.prompt,
        attachments.map((attachment) =>
          toChatAttachmentOpaqueSummary(attachment),
        ),
      );
      if (!prompt) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      if (!prompt.frozen) void dispatchNextQueuedPrompt(prompt.chatId);
      return reply.send(encryptedQueuedPromptSchema.parse(prompt));
    },
  );

  app.delete<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const prompt = await deleteLiveQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
      );
      return prompt
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Queued prompt not found." });
    },
  );

  app.post<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId/steer",
    async (request, reply) => {
      const queued = await repository.getEncryptedQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
      );
      if (!queued) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      let context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        queued.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }

      try {
        let message: ChatMessageOpaqueSummary;
        if (chatIsExecuting(context.status)) {
          if (queued.classification.mode !== "default") {
            throw new Error(
              "Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.",
            );
          }
          if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
            throw new Error(
              "This prompt is pinned to another worktree and cannot steer the active turn.",
            );
          }
          if (!bridge.isConnected(context.workerId)) {
            throw new Error("The active Codex thread is unavailable.");
          }
          const runtime = await runtimeForContext(context);
          if (!runtime) throw new Error("Selected model was not found.");
          const attachments = await resolvePromptAttachments(
            context,
            queued.classification.attachmentIds,
          );
          await bridge.request(context.workerId, {
            type: "chat.steer",
            executionProfile:
              context.contextKind === "standalone" ? "standalone-chat" : "ide",
            chatId: context.chatId,
            threadId: context.threadId,
            protectedPrompt: queued.pendingMessage,
            attachments: attachments.map((attachment) =>
              toChatAttachmentOpaqueSummary(attachment),
            ),
            model: runtime.model,
            provider: runtime.provider,
          });
          const appended = await appendLiveEncryptedChatMessage(
            applicationOwnerId(),
            context.chatId,
            queued.pendingMessage,
            context.executionLaneId
              ? context.contextKind === "standalone"
                ? {
                    contextKind: "standalone",
                    executionLaneId: context.executionLaneId,
                    worktreeId: null,
                    scratchRootId: context.scratchRootId,
                  }
                : {
                    contextKind: "project",
                    executionLaneId: context.executionLaneId,
                    worktreeId: context.worktreeId,
                    scratchRootId: null,
                  }
              : undefined,
          );
          if (!appended) throw new Error("Chat not found.");
          message = appended;
        } else {
          if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
            if (context.contextKind !== "project") {
              throw new Error(
                "Standalone Chat prompts cannot target project worktrees.",
              );
            }
            await repository.updateChatWorktree(
              applicationOwnerId(),
              context.chatId,
              {
                worktreeId: queued.worktreeId,
                mode: context.worktreeMode,
              },
            );
            const selected = await repository.getChatExecutionContext(
              applicationOwnerId(),
              context.chatId,
            );
            if (!selected) throw new Error("Worktree could not be selected.");
            context = selected;
          }
          await beginTurn(
            context,
            {
              text: "Encrypted queued prompt.",
              attachmentIds: queued.classification.attachmentIds,
              mode: queued.classification.mode,
              modelId: queued.modelId,
              reasoningEffort: queued.reasoningEffort,
              customSubagentModel: queued.customSubagentModel,
              subagentModelId: queued.subagentModelId,
              subagentReasoningEffort: queued.subagentReasoningEffort,
              idempotencyKey: queued.pendingMessage.idempotencyKey,
            },
            {
              encryptedChatMessages: {
                userMessage: queued.pendingMessage,
                response: {
                  id: randomUUID(),
                  idempotencyKey: `assistant:${queued.pendingMessage.id}`,
                },
              },
            },
          );
          const started = await repository.getEncryptedMessageByIdempotencyKey(
            applicationOwnerId(),
            context.chatId,
            queued.pendingMessage.idempotencyKey,
          );
          if (!started)
            throw new Error("Encrypted chat message was not saved.");
          message = started;
        }
        await deleteLiveQueuedPrompt(applicationOwnerId(), queued.id);
        app.log.info(
          {
            event: "chat.queue.steered",
            subsystem: "chat-queue",
            operation: "steer",
            status: "completed",
            chatId: context.chatId,
            projectId: context.projectId,
            workerId: context.workerId,
            requestId: queued.id,
          },
          "Queued prompt steered into chat",
        );
        return reply.send(
          encryptedChatPromptSteerResultSchema.parse({
            steered: true,
            message,
          }),
        );
      } catch (error) {
        return (
          sendModelConfigurationResolutionFailure(reply, error) ??
          reply.code(409).send({ error: errorMessage(error) })
        );
      }
    },
  );
}
