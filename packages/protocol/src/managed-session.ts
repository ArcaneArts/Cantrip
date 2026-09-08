import { z } from "zod";

import { projectRootKindSchema } from "./project-foundation.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
} from "./worker-runtime-support.js";

const common = {
  chatId: z.string().min(1),
  computerUseEnabled: z.boolean(),
};

/** Idle session placement/eligibility is not an execution-lane capability. */
export const managedSessionContextSchema = z.discriminatedUnion("contextKind", [
  z
    .object({
      ...common,
      contextKind: z.literal("project"),
      projectId: z.string().min(1),
      worktreeId: z.string().min(1),
      rootKind: projectRootKindSchema,
      scratchRootId: z.null(),
    })
    .strict(),
  z
    .object({
      ...common,
      contextKind: z.literal("standalone"),
      projectId: z.null(),
      worktreeId: z.null(),
      rootKind: z.null(),
      scratchRootId: z.string().min(1),
    })
    .strict(),
]);

export const managedSessionSubagentDefaultsSchema = z
  .object({
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  })
  .strict();

export type ManagedSessionContext = z.infer<typeof managedSessionContextSchema>;
