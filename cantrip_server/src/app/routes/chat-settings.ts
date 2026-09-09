import { installChatNativeHistoryTurnRoutes } from "./chat-native-history-turns.js";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { installChatNativeSettingsRoutes } from "./chat-native-settings.js";
import {
  installChatNativeModelInventoryRoutes,
  type ChatNativeModelInventoryDependencies,
} from "./chat-native-model-inventory.js";
import {
  installChatRuntimeConfigurationRoutes,
  type ChatRuntimeConfigurationRouteDependencies,
} from "./chat-runtime-configuration.js";

/** Keep desired configuration and native observation routes in the same installation. */
export function installChatSettingsRoutes(
  app: FastifyInstance,
  dependencies: ChatRuntimeConfigurationRouteDependencies &
    ChatNativeModelInventoryDependencies & {
      repository: Pick<
        ServerRepository,
        "nativeCommands" | "nativeHistoryArchive"
      >;
      publishChatInvalidation(chatId: string, resource: "chat"): void;
    },
): void {
  installChatRuntimeConfigurationRoutes(app, dependencies);
  installChatNativeSettingsRoutes(app, dependencies);
  installChatNativeHistoryTurnRoutes(app, dependencies);
  installChatNativeModelInventoryRoutes(app, dependencies);
}
