import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { nativeHistoryTurnReadRequestSchema } from "@cantrip/protocol";
import { NativeHistoryError } from "../../db/repository/native-history-bindings.js";
export function installChatNativeHistoryTurnRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId(): string;
    repository: Pick<ServerRepository, "nativeHistoryArchive">;
  },
) {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/native-history/turns/read",
    async (request, reply) => {
      const parsed = nativeHistoryTurnReadRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ code: "invalid-native-history-turn-read" });
      try {
        return await dependencies.repository.nativeHistoryArchive.readForChat(
          dependencies.applicationOwnerId(),
          request.params.chatId,
          parsed.data,
        );
      } catch (error) {
        if (error instanceof NativeHistoryError)
          return reply.code(error.statusCode).send({ code: error.code });
        throw error;
      }
    },
  );
}
