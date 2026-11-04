import { z } from "zod";
import { cantripOsExecutionSchema } from "./worker-command-cantrip-os.js";
import { cantripOsGuestPathSchema } from "./cantrip-os.js";
import {
  runConfigurationDefinitionWorkerCommandSchemas,
  runConfigurationOperationResponseSchema,
} from "./run-configuration-operations.js";
import {
  runConfigurationRuntimeLaunchIdentitySchema,
  runConfigurationRuntimeWorkerIdentitySchema,
  runConfigurationRuntimeOutputWorkerCommandSchema,
  RUN_CONFIGURATION_RUNTIME_LIST_LIMIT,
} from "./run-configuration-runtime.js";
import { runConfigurationProtectedSecretListSchema } from "./run-configuration-secrets.js";

// Paths in these requests exist only inside the authenticated guest helper.
// The owning Worker receives an explicit Linux execution descriptor instead.
// Deletion joins the runtime lifecycle path so active Runs are stopped before
// their definition and surfaces are removed.
export const cantripOsRunDefinitionRequestSchema = z.discriminatedUnion(
  "type",
  [
    runConfigurationDefinitionWorkerCommandSchemas[0].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[1].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[2].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[3].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[4].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[5].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[6].omit({
      sourcePath: true,
    }),
    runConfigurationDefinitionWorkerCommandSchemas[7].omit({
      sourcePath: true,
    }),
  ],
);
export const cantripOsRunDefinitionWorkerCommandSchema = z
  .object({
    type: z.literal("cantrip-os.run-definition"),
    execution: cantripOsExecutionSchema,
    request: cantripOsRunDefinitionRequestSchema,
  })
  .strict();
export const cantripOsRunDefinitionApiSchema = z
  .object({
    bindingGeneration: z.uuid().optional(),
    attachmentGeneration: z.uuid().optional(),
    runtimeGeneration: z.uuid(),
    request: cantripOsRunDefinitionRequestSchema,
  })
  .strict();
export const cantripOsRunPrimarySchema = z
  .object({
    bindingId: z.uuid(),
    worktreeId: z.uuid(),
    projectSourceId: z.uuid(),
    runtimeGeneration: z.uuid(),
    guestPath: cantripOsGuestPathSchema,
  })
  .strict();
export const cantripOsRunDefinitionResponseSchema = z
  .object({
    source: cantripOsRunPrimarySchema,
    result: runConfigurationOperationResponseSchema,
  })
  .strict();
export type CantripOsRunDefinitionRequest = z.infer<
  typeof cantripOsRunDefinitionRequestSchema
>;

export const cantripOsRunRootsSchema = z
  .object({
    definitions: cantripOsExecutionSchema,
    target: cantripOsExecutionSchema,
  })
  .strict();
export const cantripOsRunLaunchSchema = cantripOsRunRootsSchema
  .extend({
    identity: runConfigurationRuntimeLaunchIdentitySchema,
    protectedSecrets: runConfigurationProtectedSecretListSchema,
  })
  .strict();
export const cantripOsRunCaptureSchema = cantripOsRunRootsSchema
  .extend({
    identity: runConfigurationRuntimeWorkerIdentitySchema,
  })
  .strict();
export const workerCantripOsRunCommandSchemas = [
  cantripOsRunLaunchSchema
    .extend({ type: z.literal("cantrip-os.run-runtime.start") })
    .strict(),
  cantripOsRunLaunchSchema
    .extend({ type: z.literal("cantrip-os.run-runtime.restart") })
    .strict(),
  cantripOsRunRootsSchema
    .extend({
      type: z.literal("cantrip-os.run-runtime.stop"),
      identity: runConfigurationRuntimeLaunchIdentitySchema,
    })
    .strict(),
  cantripOsRunCaptureSchema
    .extend({ type: z.literal("cantrip-os.run-runtime.status") })
    .strict(),
  cantripOsRunCaptureSchema
    .extend({
      type: z.literal("cantrip-os.run-runtime.output"),
      requestOperationId:
        runConfigurationRuntimeOutputWorkerCommandSchema.shape
          .requestOperationId,
      serverId: runConfigurationRuntimeOutputWorkerCommandSchema.shape.serverId,
      tail: runConfigurationRuntimeOutputWorkerCommandSchema.shape.tail,
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.run-runtime.reconcile"),
      captures: z
        .array(cantripOsRunCaptureSchema)
        .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
    })
    .strict(),
] as const;
export type CantripOsRunLaunch = z.infer<typeof cantripOsRunLaunchSchema>;
export type CantripOsRunRoots = z.infer<typeof cantripOsRunRootsSchema>;
export type CantripOsRunCapture = z.infer<typeof cantripOsRunCaptureSchema>;
export type CantripOsRunWorkerCommand = z.infer<
  (typeof workerCantripOsRunCommandSchemas)[number]
>;
