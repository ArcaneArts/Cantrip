import { installInternalNativeQueueRoutes } from "./internal-native-queue.js";
import { installChatRuntimeHandoffRoutes } from "./chat-runtime-handoffs.js";
import { runtimeHandoffConfiguration } from "../../terminals/runtime-handoff-configuration.js";
import { installInternalNativeModelInventoryRoutes } from "./internal-native-model-inventory.js";
import type { FastifyInstance } from "fastify";
import { installInternalNativeCommandRoutes } from "./internal-native-commands.js";
import { installInternalNativeSettingsRoutes } from "./internal-native-settings.js";
import { installInternalNativeRuntimeHandoffRoutes } from "./internal-native-runtime-handoffs.js";

export function installManagedNativeRoutes(
  app: FastifyInstance,
  dependencies: Parameters<typeof installInternalNativeSettingsRoutes>[1] &
    Parameters<typeof installInternalNativeModelInventoryRoutes>[1] &
    Parameters<typeof installInternalNativeRuntimeHandoffRoutes>[1] &
    Omit<
      Parameters<typeof installInternalNativeQueueRoutes>[1],
      "publishChatInvalidation"
    > &
    Parameters<typeof runtimeHandoffConfiguration>[3] & {
      applicationOwnerId(): string;
    },
) {
  installInternalNativeQueueRoutes(app, {
    ...dependencies,
    publishChatInvalidation: dependencies.live.publishChatInvalidation,
  });
  installInternalNativeModelInventoryRoutes(app, dependencies);
  installInternalNativeCommandRoutes(app, dependencies);
  installInternalNativeSettingsRoutes(app, dependencies);
  installInternalNativeRuntimeHandoffRoutes(app, {
    ...dependencies,
    configuration: (ownerId, state, side) =>
      runtimeHandoffConfiguration(ownerId, state, side, dependencies),
  });
  return installChatRuntimeHandoffRoutes(app, {
    applicationOwnerId: dependencies.applicationOwnerId,
    repository: dependencies.repository,
    bridge: dependencies.bridge,
    publishChatInvalidation: dependencies.live.publishChatInvalidation,
  });
}
