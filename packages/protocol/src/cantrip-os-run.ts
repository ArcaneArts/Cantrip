import { z } from "zod";
import { cantripOsExecutionSchema } from "./worker-command-cantrip-os.js";
import { cantripOsGuestPathSchema } from "./cantrip-os.js";
import {
  runConfigurationDefinitionWorkerCommandSchemas,
  runConfigurationOperationResponseSchema,
} from "./run-configuration-operations.js";

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
