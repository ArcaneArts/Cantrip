import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { createManagedChatPreparation } from "../runtime/managed-chat-preparation.js";
export function installManagedChatPreparationRoutes(
  app: FastifyInstance,
  deps: {
    applicationOwnerId(): string;
    repository: ServerRepository;
    preparation: ReturnType<typeof createManagedChatPreparation>;
  },
) {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/preparation",
    async (request, reply) => {
      const ownerId = deps.applicationOwnerId();
      if (
        !(await deps.repository.getChatExecutionContext(
          ownerId,
          request.params.chatId,
        ))
      )
        return reply.code(404).send({ error: "Chat not found." });
      return {
        preparation: await deps.repository.managedChatPreparations.get(
          ownerId,
          request.params.chatId,
        ),
      };
    },
  );
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/preparation",
    async (request, reply) => {
      const state = await deps.preparation.request(
        deps.applicationOwnerId(),
        request.params.chatId,
      );
      return state
        ? reply.code(202).send({ preparation: state })
        : reply.code(404).send({
            error: "This chat does not support a managed CLI session.",
          });
    },
  );
}
