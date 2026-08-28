import { randomUUID } from "node:crypto";

import {
  encryptedChatPromptSubmitResultSchema,
  encryptedChatTurnCreateSchema,
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

export interface ChatTurnSubmissionRouteDependencies {
  applicationOwnerId: () => string;
  beginTurn: ChatTurnStarter;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  repository: Pick<
    ServerRepository,
    | "createEncryptedQueuedPrompt"
    | "getChatExecutionContext"
    | "getEncryptedMessageByIdempotencyKey"
    | "getLatestEncryptedUserMessage"
    | "listEncryptedQueuedPrompts"
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

/** Registers encrypted Chat turn submission and latest-message retry routes. */
export function installChatTurnSubmissionRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    beginTurn,
    bridge,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  }: ChatTurnSubmissionRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/turns",
    async (request, reply) => {
      const input = encryptedChatTurnCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found" });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Task turns must use the encrypted Task operation flow.",
        });
      }
      const existing = await repository.getEncryptedMessageByIdempotencyKey(
        applicationOwnerId(),
        context.chatId,
        input.data.message.idempotencyKey,
      );
      if (existing) {
        return reply.send(
          encryptedChatPromptSubmitResultSchema.parse({
            status: "started",
            message: existing,
          }),
        );
      }
      if (
        context.contextKind === "standalone" &&
        !bridge.isConnected(context.workerId)
      ) {
        return reply.code(503).send({
          code: "standalone-worker-offline",
          error: "This Chat's worker is offline. History remains available.",
        });
      }
      if (
        context.contextKind === "standalone" &&
        (context.status === "offline" || context.status === "failed")
      ) {
        return reply.code(409).send({
          code: "standalone-scratch-unavailable",
          error:
            context.status === "failed"
              ? "This Chat's scratch folder could not be prepared. Retry provisioning before sending."
              : "This Chat's scratch folder is still being prepared.",
        });
      }
      if (context.automationPaused || chatIsExecuting(context.status)) {
        let modelId: string;
        let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
        try {
          modelId = await resolveModelId(context, input.data.modelId);
          attachments = await resolvePromptAttachments(
            context,
            input.data.queuedPrompt.classification.attachmentIds,
          );
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
        const prompt = await repository.createEncryptedQueuedPrompt(
          applicationOwnerId(),
          context.chatId,
          input.data.queuedPrompt,
          attachments.map((attachment) =>
            toChatAttachmentOpaqueSummary(attachment),
          ),
        );
        if (prompt) {
          app.log.info(
            {
              event: "chat.queue.enqueued",
              subsystem: "chat-queue",
              operation: "enqueue-prompt",
              status: "queued",
              chatId: context.chatId,
              projectId: context.projectId,
              workerId: context.workerId,
              requestId: prompt.id,
              counts: { attachments: prompt.attachments.length },
              reasonCode: context.automationPaused
                ? "automation-paused"
                : "turn-active",
            },
            "Chat prompt queued behind active work",
          );
        }
        return prompt
          ? reply.code(202).send(
              encryptedChatPromptSubmitResultSchema.parse({
                status: "queued",
                prompt,
              }),
            )
          : reply.code(404).send({ error: "Chat not found." });
      }

      try {
        await beginTurn(
          context,
          {
            text: "Encrypted prompt.",
            attachmentIds: input.data.message.classification.attachmentIds,
            mode: input.data.message.classification.mode,
            modelId: input.data.modelId,
            reasoningEffort: input.data.message.reasoningEffort,
            customSubagentModel: input.data.queuedPrompt.customSubagentModel,
            subagentModelId: input.data.queuedPrompt.subagentModelId,
            subagentReasoningEffort:
              input.data.queuedPrompt.subagentReasoningEffort,
            idempotencyKey: input.data.message.idempotencyKey,
          },
          {
            encryptedChatMessages: {
              userMessage: input.data.message,
              response: {
                id: randomUUID(),
                idempotencyKey: `assistant:${input.data.message.id}`,
              },
            },
          },
        );
        const message = await repository.getEncryptedMessageByIdempotencyKey(
          applicationOwnerId(),
          context.chatId,
          input.data.message.idempotencyKey,
        );
        if (!message) throw new Error("Encrypted chat message was not saved.");
        return reply.code(202).send(
          encryptedChatPromptSubmitResultSchema.parse({
            status: "started",
            message,
          }),
        );
      } catch (error) {
        const resolution = sendModelConfigurationResolutionFailure(
          reply,
          error,
        );
        if (resolution) return resolution;
        const message = errorMessage(error);
        const status = message.includes("offline")
          ? 503
          : message.includes("model") ||
              message.includes("Model") ||
              message.includes("Cantrip Code") ||
              message.includes("unsaved")
            ? 409
            : 400;
        return reply.code(status).send({ error: message });
      }
    },
  );

  app.post<{ Params: { chatId: string; messageId: string } }>(
    "/api/chats/:chatId/turns/:messageId/retry",
    async (request, reply) => {
      const input = encryptedChatTurnCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getChatExecutionContext(
        ownerId,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Task messages cannot be edited from the agent transcript.",
        });
      }
      const existing = await repository.getEncryptedMessageByIdempotencyKey(
        ownerId,
        context.chatId,
        input.data.message.idempotencyKey,
      );
      if (existing) {
        return reply.send(
          encryptedChatPromptSubmitResultSchema.parse({
            status: "started",
            message: existing,
          }),
        );
      }
      if (context.automationPaused) {
        return reply.code(409).send({
          error: "Resume the chat before editing its latest message.",
        });
      }
      if (chatIsExecuting(context.status)) {
        return reply.code(409).send({
          error: "Interrupt or finish the active turn before editing it.",
        });
      }
      if (!context.threadId) {
        return reply.code(409).send({
          error: "This chat does not have a Codex turn to edit.",
        });
      }
      const [latest, queuedPrompts] = await Promise.all([
        repository.getLatestEncryptedUserMessage(ownerId, context.chatId),
        repository.listEncryptedQueuedPrompts(ownerId, context.chatId),
      ]);
      if (!latest || latest.id !== request.params.messageId) {
        return reply.code(409).send({
          error: "Only the latest user message can be edited and sent again.",
        });
      }
      if (queuedPrompts.length > 0) {
        return reply.code(409).send({
          error: "Remove queued prompts before editing the latest message.",
        });
      }
      const replacement = input.data.message;
      if (
        replacement.classification.role !== "user" ||
        replacement.classification.mode !== latest.mode ||
        replacement.reasoningEffort !== latest.reasoningEffort ||
        JSON.stringify(replacement.classification.attachmentIds) !==
          JSON.stringify(latest.attachmentIds) ||
        input.data.modelId !== latest.modelId
      ) {
        return reply.code(409).send({
          error:
            "An edited message must keep its original mode, model, reasoning, and attachments.",
        });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      let runtime: ModelRuntime | null;
      try {
        runtime = await runtimeForContext(context);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (
        !runtime ||
        runtime.model.id !== latest.modelId ||
        runtime.routeId !== latest.modelRouteId
      ) {
        return reply.code(409).send({
          error: "The original model route is unavailable for this message.",
        });
      }

      try {
        await beginTurn(
          context,
          {
            text: "Edited encrypted prompt.",
            attachmentIds: replacement.classification.attachmentIds,
            mode: replacement.classification.mode,
            modelId: input.data.modelId,
            reasoningEffort: replacement.reasoningEffort,
            customSubagentModel: input.data.queuedPrompt.customSubagentModel,
            subagentModelId: input.data.queuedPrompt.subagentModelId,
            subagentReasoningEffort:
              input.data.queuedPrompt.subagentReasoningEffort,
            idempotencyKey: replacement.idempotencyKey,
          },
          {
            encryptedChatMessages: {
              userMessage: replacement,
              response: {
                id: randomUUID(),
                idempotencyKey: `assistant:${replacement.id}`,
              },
            },
            retryMessageId: latest.id,
            runtimes: [runtime],
          },
        );
        const message = await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          context.chatId,
          replacement.idempotencyKey,
        );
        if (!message) throw new Error("Encrypted chat message was not saved.");
        return reply.code(202).send(
          encryptedChatPromptSubmitResultSchema.parse({
            status: "started",
            message,
          }),
        );
      } catch (error) {
        const resolution = sendModelConfigurationResolutionFailure(
          reply,
          error,
        );
        if (resolution) return resolution;
        const message = errorMessage(error);
        return reply
          .code(message.includes("offline") ? 503 : 409)
          .send({ error: message });
      }
    },
  );
}
