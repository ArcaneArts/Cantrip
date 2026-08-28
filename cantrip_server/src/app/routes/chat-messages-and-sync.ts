import {
  chatMessageOpaqueContentSchema,
  chatMessagePageQuerySchema,
  chatMessageWireListSchema,
  chatMessageWirePageSchema,
  type AgentThreadSync,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatSyncAndMessageReadRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  reconcileChatThread: (
    context: ChatExecutionContext,
    resolvedRuntime?: ModelRuntime,
  ) => Promise<AgentThreadSync>;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "listEncryptedMessagePage"
    | "listEncryptedMessages"
    | "listTaskMessagePage"
    | "listTaskMessages"
  >;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
}

export interface ChatMessageCreateRouteDependencies {
  applicationOwnerId: () => string;
  appendLiveEncryptedChatMessage: (
    ...input: Parameters<ServerRepository["appendEncryptedMessage"]>
  ) => ReturnType<ServerRepository["appendEncryptedMessage"]>;
  repository: Pick<ServerRepository, "getChatExecutionContext">;
}

/** Registers Chat thread synchronization and encrypted message reads. */
export function installChatSyncAndMessageReadRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    reconcileChatThread,
    repository,
    runtimeForContext,
  }: ChatSyncAndMessageReadRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/sync",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Encrypted Task reconstruction uses worker relocation.",
        });
      }
      if (!context.threadId) {
        return reply.send(await reconcileChatThread(context));
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      return reply.send(await reconcileChatThread(context, runtime));
    },
  );

  app.get<{
    Params: { chatId: string };
    Querystring: { beforeSequence?: string; limit?: string };
  }>("/api/chats/:chatId/messages", async (request, reply) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      request.params.chatId,
    );
    if (!context) {
      return reply.code(404).send({ error: "Chat source not found." });
    }
    const task = context.experience === "task";
    const paginated =
      request.query.beforeSequence !== undefined ||
      request.query.limit !== undefined;
    if (paginated) {
      const query = chatMessagePageQuerySchema.parse(request.query);
      const result = task
        ? await repository.listTaskMessagePage(
            applicationOwnerId(),
            request.params.chatId,
            query,
          )
        : await repository.listEncryptedMessagePage(
            applicationOwnerId(),
            request.params.chatId,
            query,
          );
      return reply.send(
        chatMessageWirePageSchema.parse({
          kind: task ? "task-encrypted" : "chat-encrypted",
          messages: result.messages,
          page: result.page,
        }),
      );
    }
    const messages = task
      ? await repository.listTaskMessages(
          applicationOwnerId(),
          request.params.chatId,
        )
      : await repository.listEncryptedMessages(
          applicationOwnerId(),
          request.params.chatId,
        );
    return reply.send(
      chatMessageWireListSchema.parse(
        task
          ? { kind: "task-encrypted", messages }
          : { kind: "chat-encrypted", messages },
      ),
    );
  });
}

/** Registers encrypted Chat message creation at its original route anchor. */
export function installChatMessageCreateRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    appendLiveEncryptedChatMessage,
    repository,
  }: ChatMessageCreateRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/messages",
    async (request, reply) => {
      const input = chatMessageOpaqueContentSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat not found" });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Task messages must be encrypted by a trusted endpoint.",
        });
      }
      const message = await appendLiveEncryptedChatMessage(
        applicationOwnerId(),
        request.params.chatId,
        input.data,
      );
      if (!message) {
        return reply.code(404).send({ error: "Chat not found" });
      }
      return reply.code(201).send(message);
    },
  );
}
