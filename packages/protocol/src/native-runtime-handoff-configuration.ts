import { z } from "zod";
import { nativeRuntimeHandoffStateSchema } from "./native-runtime-handoff.js";
import {
  managedSessionContextSchema,
  managedSessionSubagentDefaultsSchema,
} from "./managed-session.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
} from "./worker-runtime-support.js";
import { mcpServerOpaqueRuntimeSchema } from "./protected-secrets.js";
import { planModeSchema } from "./chat-runtime.js";
import { permissionProfileIdSchema } from "./permission-profiles.js";

export const nativeRuntimeHandoffConfigurationRequestSchema = z
  .object({
    workerId: z.string().min(1),
    chatId: z.string().min(1),
    operationId: z.string().uuid(),
    side: z.enum(["source", "destination"]),
  })
  .strict();
export const nativeRuntimeHandoffConfigurationSchema = z
  .object({
    state: nativeRuntimeHandoffStateSchema,
    side: z.enum(["source", "destination"]),
    configuration: z
      .object({
        session: managedSessionContextSchema,
        threadId: z.string().min(1),
        cwd: z.string().min(1),
        model: workerRuntimeModelSchema,
        provider: workerRuntimeProviderSchema,
        subagentDefaults: managedSessionSubagentDefaultsSchema.nullable(),
        mcpServers: z.array(mcpServerOpaqueRuntimeSchema),
        planMode: planModeSchema,
        permissionProfileId: permissionProfileIdSchema,
      })
      .strict(),
  })
  .strict();
export type NativeRuntimeHandoffConfiguration = z.infer<
  typeof nativeRuntimeHandoffConfigurationSchema
>;
export type NativeRuntimeHandoffConfigurationRequest = z.infer<
  typeof nativeRuntimeHandoffConfigurationRequestSchema
>;
