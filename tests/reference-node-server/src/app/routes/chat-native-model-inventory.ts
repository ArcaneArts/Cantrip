import { isDeepStrictEqual } from "node:util";
import {
  nativeChatModelInventorySchema,
  nativeChatModelInventoryQuerySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import {
  readNativeModelInventory,
  type NativeModelInventoryRepository,
} from "../../models/native-model-inventory.js";

export interface ChatNativeModelInventoryDependencies {
  applicationOwnerId(): string;
  repository: NativeModelInventoryRepository &
    Pick<ServerRepository, "nativeCommands" | "getModelRuntimeByRoute">;
}

/** Public inventory follows the chat's current provider/account. It neither
 * starts a runtime nor treats a native model string as a provider identity. */
export function installChatNativeModelInventoryRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ChatNativeModelInventoryDependencies,
): void {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/native-settings/models",
    async (request, reply) => {
      const query = nativeChatModelInventoryQuerySchema.safeParse(
        request.query,
      );
      if (!query.success)
        return reply.code(400).send({ code: "invalid-native-model-inventory" });
      const ownerId = applicationOwnerId();
      const chatId = request.params.chatId;
      try {
        const binding =
          await repository.nativeCommands.resolveSettingsWriteBinding(
            ownerId,
            chatId,
            query.data.bindingId,
          );
        const runtime = binding.modelRouteId
          ? await repository.getModelRuntimeByRoute(
              ownerId,
              binding.modelRouteId,
            )
          : null;
        if (!runtime)
          throw new NativeCommandError(
            "native-model-route-unavailable",
            "The bound model route is no longer available.",
          );
        const inventory = await readNativeModelInventory(repository, ownerId, {
          workerId: binding.workerId,
          providerId: runtime.provider.id,
          providerAccountId: binding.providerAccountId,
        });
        if (!inventory)
          throw new NativeCommandError(
            "native-model-inventory-unavailable",
            "The bound provider/account inventory is unavailable.",
          );
        const current =
          await repository.nativeCommands.resolveSettingsWriteBinding(
            ownerId,
            chatId,
            binding.bindingId,
          );
        const currentRuntime = current.modelRouteId
          ? await repository.getModelRuntimeByRoute(
              ownerId,
              current.modelRouteId,
            )
          : null;
        if (
          !isDeepStrictEqual(current, binding) ||
          currentRuntime?.provider.id !== runtime.provider.id ||
          currentRuntime?.provider.kind !== runtime.provider.kind
        )
          throw new NativeCommandError(
            "settings-binding-replaced",
            "The native model inventory source changed while it was being read.",
          );
        return nativeChatModelInventorySchema.parse({
          ...inventory,
          bindingId: binding.bindingId,
        });
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
