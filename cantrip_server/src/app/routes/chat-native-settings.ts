import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";

export function installChatNativeSettingsRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId: () => string;
    repository: Pick<ServerRepository, "nativeCommands">;
    bridge: Pick<WorkerCommandBus, "request">;
    publishChatInvalidation(chatId: string, resource: "chat"): void;
  },
) {
  const { applicationOwnerId, repository, bridge } = dependencies;
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/native-settings",
    async (request, reply) => {
      const state = await repository.nativeCommands.settingsState(
        applicationOwnerId(),
        request.params.chatId,
      );
      return state
        ? reply.send(state)
        : reply.code(404).send({ error: "Chat not found." });
    },
  );
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/native-settings/refresh",
    async (request, reply) => {
      try {
        const state = await repository.nativeCommands.refreshSettingsState(
          applicationOwnerId(),
          request.params.chatId,
          (scope) =>
            bridge.request(scope.workerId, {
              type: "chat.settings.read",
              scope,
            }),
        );
        dependencies.publishChatInvalidation(request.params.chatId, "chat");
        return state;
      } catch (error) {
        if (error instanceof NativeCommandError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, error: error.message });
        throw error;
      }
    },
  );
}
