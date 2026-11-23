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
import { cantripOsExecutionSchema } from "./worker-command-cantrip-os.js";
import { projectRootKindSchema } from "./project-foundation.js";

export const nativeRuntimeHandoffConfigurationRequestSchema = z
  .object({
    workerId: z.string().min(1),
    chatId: z.string().min(1),
    operationId: z.string().uuid(),
    side: z.enum(["source", "destination"]),
  })
  .strict();
const commonConfiguration = z.object({
  threadId: z.string().min(1),
  cwd: z.string().min(1),
  model: workerRuntimeModelSchema,
  provider: workerRuntimeProviderSchema,
  subagentDefaults: managedSessionSubagentDefaultsSchema.nullable(),
  mcpServers: z.array(mcpServerOpaqueRuntimeSchema),
  planMode: planModeSchema,
  permissionProfileId: permissionProfileIdSchema,
});
export const nativeRuntimeHandoffTaskContextSchema = z
  .object({
    chatId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    rootKind: projectRootKindSchema,
    osExecution: cantripOsExecutionSchema.optional(),
    computerUseEnabled: z.boolean(),
    cycleId: z.string().uuid(),
    orderEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    goalEpoch: z.string().min(1).max(4096),
  })
  .strict();
export const nativeRuntimeHandoffConfigurationSchema = z
  .object({
    state: nativeRuntimeHandoffStateSchema,
    side: z.enum(["source", "destination"]),
    configuration: z.union([
      commonConfiguration
        .extend({ session: managedSessionContextSchema })
        .strict(),
      commonConfiguration
        .extend({ task: nativeRuntimeHandoffTaskContextSchema })
        .strict(),
    ]),
  })
  .strict();
export type NativeRuntimeHandoffConfiguration = z.infer<
  typeof nativeRuntimeHandoffConfigurationSchema
>;
export type NativeRuntimeHandoffConfigurationRequest = z.infer<
  typeof nativeRuntimeHandoffConfigurationRequestSchema
>;
