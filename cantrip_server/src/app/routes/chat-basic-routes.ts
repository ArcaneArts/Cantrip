import {
  chatRuntimeSelectionSchema,
  contextualChatWireSummarySchema,
  encryptedChatComposerDraftUpdateSchema,
  encryptedChatComposerDraftWireStateSchema,
  encryptedChatUpdateSchema,
} from "@cantrip/protocol";
import {
  standaloneChatFileWireRequestSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol/surface-stream";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatBasicRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  publishChatFilesChange: (chatId: string) => void;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  repository: Pick<
    ServerRepository,
    | "acknowledgeChatCompletion"
    | "getChatComposerDraftWireState"
    | "getChatExecutionContext"
    | "getWorker"
    | "updateChat"
    | "updateChatComposerDraft"
  >;
  serverId: string;
}

/** Registers basic Chat metadata, file, completion, and draft routes. */
export function installChatBasicRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatFilesChange,
    publishChatSummary,
    repository,
    serverId,
  }: ChatBasicRouteDependencies,
): void {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/runtime-selection",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      return context
        ? reply.send(
            chatRuntimeSelectionSchema.parse({
              modelRouteId: context.modelRouteId,
              providerAccountId: context.providerAccountId,
            }),
          )
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const input = encryptedChatUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const chat = await repository.updateChat(
        applicationOwnerId(),
        request.params.chatId,
        input.data,
      );
      return chat
        ? reply.send(contextualChatWireSummarySchema.parse(chat))
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/files/operation",
    { bodyLimit: 4 * 1_024 * 1_024 },
    async (request, reply) => {
      const input = standaloneChatFileWireRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getChatExecutionContext(
        ownerId,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (context.contextKind !== "standalone" || !context.scratchRootId) {
        return reply.code(409).send({
          error: "Chat files are available only for standalone Chats.",
        });
      }
      const worker = await repository.getWorker(ownerId, context.workerId);
      if (!worker?.standaloneChat.files[input.data.intent]) {
        return reply.code(409).send({
          error: `The Chat worker does not support ${input.data.intent} file operations.`,
        });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Chat worker is offline." });
      }
      try {
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(context.workerId, {
            type: "chat.scratch.files.operation",
            rootId: context.scratchRootId,
            chatId: context.chatId,
            serverId,
            root: context.cwd,
            intent: input.data.intent,
            operationId: input.data.operationId,
            sequence: input.data.sequence,
            protectedRequest: input.data.protectedRequest,
          }),
        );
        if (input.data.intent === "write" || input.data.intent === "remove") {
          publishChatFilesChange(request.params.chatId);
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/completion/read",
    async (request, reply) => {
      const chat = await repository.acknowledgeChatCompletion(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!chat) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      publishChatSummary(chat.id, chat.projectId);
      return reply.send(contextualChatWireSummarySchema.parse(chat));
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/composer-draft",
    async (request, reply) => {
      const draft = await repository.getChatComposerDraftWireState(
        applicationOwnerId(),
        request.params.chatId,
      );
      return draft
        ? reply.send(encryptedChatComposerDraftWireStateSchema.parse(draft))
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.put<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/composer-draft",
    async (request, reply) => {
      const input = encryptedChatComposerDraftUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const draft = await repository.updateChatComposerDraft(
        applicationOwnerId(),
        request.params.chatId,
        input.data.state,
      );
      return draft
        ? reply.send(encryptedChatComposerDraftWireStateSchema.parse(draft))
        : reply.code(404).send({ error: "Chat not found." });
    },
  );
}
