import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import {
  nativeAccountDefaultsRequestSchema,
  nativeAccountDefaultsResponseSchema,
} from "@cantrip/protocol";

export function installChatNativeAccountDefaultsRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId(): string;
    repository: Pick<ServerRepository, "nativeCommands">;
    bridge: Pick<WorkerCommandBus, "request">;
  },
) {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/native-account-defaults",
    async (request, reply) => {
      const parsed = nativeAccountDefaultsRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ code: "invalid-native-account-defaults" });
      const ownerId = dependencies.applicationOwnerId();
      const resolve = () =>
        dependencies.repository.nativeCommands.resolveSettingsWriteBinding(
          ownerId,
          request.params.chatId,
          parsed.data.bindingId,
        );
      try {
        const binding = await resolve();
        const response = nativeAccountDefaultsResponseSchema.parse(
          await dependencies.bridge.request(binding.workerId, {
            type: "chat.account-defaults",
            binding,
            request: parsed.data,
          }),
        );
        if (
          response.operationId !== parsed.data.operationId ||
          response.bindingId !== binding.bindingId
        )
          throw new Error(
            "Account defaults response belongs to another operation.",
          );
        // The route may change during native I/O. Never publish a retired source as current.
        await resolve();
        return response;
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
