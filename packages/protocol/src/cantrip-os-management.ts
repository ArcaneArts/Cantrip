import { z } from "zod";
import {
  cantripOsDependencyOverlaysSchema,
  cantripOsInstanceSummarySchema,
  cantripOsTransportSchema,
  cantripOsWorkspaceSummarySchema,
} from "./cantrip-os.js";
import { repositoryOperationOpaqueSchema } from "./repository-operation.js";

/** Recovery observes this exact attachment; it never changes chat placement. */
export const cantripOsRecoveryRequestSchema = z
  .object({
    attachmentGeneration: z.uuid(),
    runtimeGeneration: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const cantripOsRecoveryResultSchema = z
  .object({
    instance: cantripOsInstanceSummarySchema,
    workspaces: z.array(cantripOsWorkspaceSummarySchema),
    recovery: z
      .object({
        kind: z.enum([
          "same-runtime",
          "runtime-changed",
          "first-observation",
          "unavailable",
          "identity-changed",
        ]),
        previousRuntimeGeneration: z.string().min(1).max(200).nullable(),
        observedRuntimeGeneration: z.string().min(1).max(200).nullable(),
        message: z.string().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();

export const cantripOsInspectSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    transport: cantripOsTransportSchema,
  })
  .strict();

export const cantripOsWorkspaceCreateSchema = z
  .object({
    guestWorkspaceId: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
    operationId: z.uuid(),
  })
  .strict();

export const cantripOsBindingCreateSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("linked"),
      workspaceId: z.uuid(),
      worktreeId: z.uuid(),
      dependencyOverlays: cantripOsDependencyOverlaysSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("linux-owned"),
      workspaceId: z.uuid(),
      sourceKind: z.enum(["git", "folder"]),
    })
    .strict(),
  z
    .object({
      mode: z.literal("linux-worktree"),
      sourceBindingId: z.uuid(),
      expectedRuntimeGeneration: z.uuid(),
      operationId: z.uuid(),
    })
    .strict(),
]);

export const cantripOsProvisionSchema = z
  .object({
    operationId: z.uuid(),
    bindingGeneration: z.uuid(),
    protectedRequest: repositoryOperationOpaqueSchema,
  })
  .strict();
