import {
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatExecutionControlRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  interruptLiveAgentInteractionRequests: (
    ...input: Parameters<ServerRepository["interruptAgentInteractionRequests"]>
  ) => ReturnType<ServerRepository["interruptAgentInteractionRequests"]>;
  repository: Pick<ServerRepository, "getChatExecutionContext">;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
}

/** Registers worker-backed Chat compaction and interruption controls. */
export function installChatExecutionControlRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    interruptLiveAgentInteractionRequests,
    repository,
    runtimeForContext,
  }: ChatExecutionControlRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/compact",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(context.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (!context.threadId) {
        return reply
          .code(409)
          .send({ error: "Send a message before compacting this chat." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const compactionStartedAtMs = Date.now();
      app.log.info(
        {
          event: "chat.compaction.started",
          subsystem: "chat-execution",
          operation: "compact",
          status: "running",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        "Chat compaction started",
      );
      const result = await bridge.request(context.workerId, {
        type: "chat.compact",
        executionProfile:
          context.contextKind === "standalone" ? "standalone-chat" : "ide",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
      });
      app.log.info(
        {
          event: "chat.compaction.completed",
          subsystem: "chat-execution",
          operation: "compact",
          status: "completed",
          durationMs: Date.now() - compactionStartedAtMs,
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        "Chat compaction completed",
      );
      return reply.send(chatCompactAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/interrupt",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      const chatCanBeInterrupted =
        context.status === "running" ||
        context.status === "waiting-for-approval";
      if (!chatCanBeInterrupted) {
        return reply.send(
          chatInterruptAcceptedSchema.parse({ interrupted: false }),
        );
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const result = await bridge.request(context.workerId, {
        type: "chat.interrupt",
        executionProfile:
          context.contextKind === "standalone" ? "standalone-chat" : "ide",
        chatId: context.chatId,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      });
      const parsedResult = chatInterruptAcceptedSchema.parse(result);
      if (
        parsedResult.interrupted &&
        context.status === "waiting-for-approval"
      ) {
        await interruptLiveAgentInteractionRequests(context.chatId);
      }
      app.log.info(
        {
          event: "chat.interrupt.requested",
          subsystem: "chat-execution",
          operation: "interrupt",
          status: parsedResult.interrupted ? "accepted" : "not-active",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        parsedResult.interrupted
          ? "Agent turn interruption accepted"
          : "Agent turn was not active",
      );
      return reply.send(parsedResult);
    },
  );
}
