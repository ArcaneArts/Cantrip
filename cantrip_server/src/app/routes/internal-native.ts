import { installInternalNativeModelInventoryRoutes } from "./internal-native-model-inventory.js";
import type { FastifyInstance } from "fastify";
import { installInternalNativeCommandRoutes } from "./internal-native-commands.js";
import { installInternalNativeSettingsRoutes } from "./internal-native-settings.js";
import { installInternalNativeRuntimeHandoffRoutes } from "./internal-native-runtime-handoffs.js";

export function installManagedNativeRoutes(
  app: FastifyInstance,
  dependencies: Parameters<typeof installInternalNativeSettingsRoutes>[1] &
    Parameters<typeof installInternalNativeModelInventoryRoutes>[1] &
    Parameters<typeof installInternalNativeRuntimeHandoffRoutes>[1],
): void {
  installInternalNativeModelInventoryRoutes(app, dependencies);
  installInternalNativeCommandRoutes(app, dependencies);
  installInternalNativeSettingsRoutes(app, dependencies);
  installInternalNativeRuntimeHandoffRoutes(app, dependencies);
}
