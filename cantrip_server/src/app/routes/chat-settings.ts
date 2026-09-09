import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { installChatNativeSettingsRoutes } from "./chat-native-settings.js";
import {
  installChatRuntimeConfigurationRoutes,
  type ChatRuntimeConfigurationRouteDependencies,
} from "./chat-runtime-configuration.js";

/** Keep desired configuration and native observation routes in the same installation. */
export function installChatSettingsRoutes(
  app: FastifyInstance,
  dependencies: ChatRuntimeConfigurationRouteDependencies & {
    repository: Pick<ServerRepository, "nativeCommands">;
    publishChatInvalidation(chatId: string, resource: "chat"): void;
  },
): void {
  installChatRuntimeConfigurationRoutes(app, dependencies);
  installChatNativeSettingsRoutes(app, dependencies);
}
