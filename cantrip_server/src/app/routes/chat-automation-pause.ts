import { chatPauseStateSchema, chatPauseUpdateSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface ChatAutomationPauseRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  repository: Pick<
    ServerRepository,
    "getChatExecutionContext" | "listQueuedPrompts" | "setChatAutomationPaused"
  >;
  resumeChatAutomation: (chatId: string) => Promise<void>;
}

/** Registers durable Chat automation pause and resume orchestration. */
export function installChatAutomationPauseRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    repository,
    resumeChatAutomation,
  }: ChatAutomationPauseRouteDependencies,
): void {
  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/pause",
    async (request, reply) => {
      const input = chatPauseUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }

      if (
        !input.data.paused &&
        !bridge.isConnected(context.workerId) &&
        (context.threadId ||
          (
            await repository.listQueuedPrompts(
              applicationOwnerId(),
              context.chatId,
            )
          ).length > 0)
      ) {
        return reply.code(503).send({
          error:
            "The project worker is offline. This chat remains paused so its next action is not lost.",
        });
      }

      const workerConnected = bridge.isConnected(context.workerId);
      if (!input.data.paused && workerConnected) {
        try {
          await bridge.request(
            context.workerId,
            {
              type: "chat.pause.set",
              chatId: context.chatId,
              paused: false,
            },
            { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
          );
        } catch (error) {
          return reply.code(502).send({
            error: `The worker could not resume this chat: ${errorMessage(error)}`,
          });
        }
      }

      if (input.data.paused && workerConnected) {
        try {
          await bridge.request(
            context.workerId,
            {
              type: "chat.pause.set",
              chatId: context.chatId,
              paused: true,
            },
            { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
          );
        } catch (error) {
          return reply.code(502).send({
            error: `The worker could not pause this chat at a safe boundary: ${errorMessage(error)}`,
          });
        }
      }

      const updated = await repository.setChatAutomationPaused(
        applicationOwnerId(),
        context.chatId,
        input.data.paused,
      );
      if (!updated) {
        if (workerConnected) {
          await bridge
            .request(
              context.workerId,
              {
                type: "chat.pause.set",
                chatId: context.chatId,
                paused: !input.data.paused,
              },
              { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
            )
            .catch(() => undefined);
        }
        return reply.code(404).send({ error: "Chat source not found." });
      }

      publishChatSummary(context.chatId, context.projectId);

      if (!input.data.paused) {
        try {
          await resumeChatAutomation(context.chatId);
        } catch (error) {
          await repository.setChatAutomationPaused(
            applicationOwnerId(),
            context.chatId,
            true,
          );
          publishChatSummary(context.chatId, context.projectId);
          if (bridge.isConnected(context.workerId)) {
            await bridge
              .request(context.workerId, {
                type: "chat.pause.set",
                chatId: context.chatId,
                paused: true,
              })
              .catch(() => undefined);
          }
          return reply.code(409).send({
            error: `This chat remains paused because its next action could not start: ${errorMessage(error)}`,
          });
        }
      }

      app.log.info(
        {
          event: input.data.paused
            ? "chat.automation.paused"
            : "chat.automation.resumed",
          subsystem: "chat-execution",
          operation: input.data.paused ? "pause" : "resume",
          status: input.data.paused ? "paused" : "active",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        input.data.paused
          ? "Chat automation paused"
          : "Chat automation resumed",
      );

      return reply.send(
        chatPauseStateSchema.parse({ paused: input.data.paused }),
      );
    },
  );
}
