import { chatPauseStateSchema, chatPauseUpdateSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { invalidBody } from "../../http/request-helpers.js";
import {
  ChatAutomationPauseError,
  createChatAutomationPauseRuntime,
  type ChatAutomationPauseRouteDependencies,
} from "../runtime/chat-automation-pause-runtime.js";

export type { ChatAutomationPauseRouteDependencies } from "../runtime/chat-automation-pause-runtime.js";

/** Registers durable Chat automation pause and resume orchestration. */
export function installChatAutomationPauseRoute(
  app: FastifyInstance,
  dependencies: ChatAutomationPauseRouteDependencies,
): void {
  const setChatAutomationPause = createChatAutomationPauseRuntime(
    dependencies,
    app,
  );
  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/pause",
    async (request, reply) => {
      const input = chatPauseUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await setChatAutomationPause(
          dependencies.applicationOwnerId(),
          request.params.chatId,
          input.data.paused,
        );
        return reply.send(chatPauseStateSchema.parse(result));
      } catch (error) {
        if (error instanceof ChatAutomationPauseError)
          return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    },
  );
}
