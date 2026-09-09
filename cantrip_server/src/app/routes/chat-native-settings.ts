import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import {
  nativeSettingsUpdateRequestSchema,
  nativeSettingsUpdateReceiptSchema,
} from "@cantrip/protocol";

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
    "/api/chats/:chatId/native-settings/update",
    async (request, reply) => {
      const parsed = nativeSettingsUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-native-settings-update" });
      try {
        const binding =
          await repository.nativeCommands.resolveSettingsWriteBinding(
            applicationOwnerId(),
            request.params.chatId,
            parsed.data.bindingId,
          );
        // Resolving routing does not authorize input. The owning worker opens
        // the patch and requests durable admission before any native mutation.
        const receipt = nativeSettingsUpdateReceiptSchema.parse(
          await bridge.request(binding.workerId, {
            ...parsed.data,
            type: "chat.settings.update",
            binding,
          }),
        );
        if (receipt.operationId !== parsed.data.operationId)
          throw new Error(
            "Native settings response belongs to another operation.",
          );
        dependencies.publishChatInvalidation(request.params.chatId, "chat");
        return receipt;
      } catch (error) {
        if (error instanceof NativeCommandError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, error: error.message });
        throw error;
      }
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
