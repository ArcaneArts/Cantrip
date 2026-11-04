import { z } from "zod";
import {
  cantripOsDependencyOverlaysSchema,
  cantripOsTransportSchema,
} from "./cantrip-os.js";
import { repositoryOperationOpaqueSchema } from "./repository-operation.js";

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
]);

export const cantripOsProvisionSchema = z
  .object({
    operationId: z.uuid(),
    bindingGeneration: z.uuid(),
    protectedRequest: repositoryOperationOpaqueSchema,
  })
  .strict();
