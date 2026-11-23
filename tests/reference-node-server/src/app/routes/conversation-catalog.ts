import {
  conversationCatalogQuerySchema,
  conversationCatalogWirePageSchema,
  conversationUsageSchema,
  conversationUsageResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import {
  ConversationCursorError,
  ConversationUsageConflictError,
  type ConversationCatalogRepository,
} from "../../db/repository/conversation-catalog.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installConversationCatalogRoutes(
  app: FastifyInstance,
  ownerId: () => string,
  repository: ConversationCatalogRepository,
) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/conversations",
    async (request, reply) => {
      const input = conversationCatalogQuerySchema.safeParse(request.query);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const page = await repository.list(
          ownerId(),
          request.params.projectId,
          input.data,
        );
        return page
          ? reply.send(conversationCatalogWirePageSchema.parse(page))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (error instanceof ConversationCursorError)
          return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/usage",
    async (request, reply) => {
      const input = conversationUsageSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const result = await repository.recordUsage(
          ownerId(),
          request.params.chatId,
          input.data,
        );
        return result
          ? reply.send(conversationUsageResultSchema.parse(result))
          : reply.code(404).send({ error: "Agent conversation not found." });
      } catch (error) {
        if (error instanceof ConversationUsageConflictError)
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
}
