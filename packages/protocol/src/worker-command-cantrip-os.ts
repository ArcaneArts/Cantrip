import { z } from "zod";
import { repositoryOperationOpaqueSchema } from "./repository-operation.js";
import {
  cantripOsDependencyOverlaysSchema,
  cantripOsGuestPathSchema,
  cantripOsTransportSchema,
  cantripOsWorkspaceObservationSchema,
} from "./cantrip-os.js";

const id = z.string().min(1).max(200);
const scope = z
  .object({
    ownerId: id,
    workerId: id,
    serverId: z.string().min(1).max(2_000),
    instanceId: z.uuid(),
    guestInstanceId: z.uuid(),
    attachmentGeneration: z.uuid(),
    runtimeGeneration: z.uuid(),
  })
  .strict();

export const cantripOsDispatchScopeSchema = scope;

const sourceScope = scope
  .extend({
    bindingId: z.uuid(),
    bindingGeneration: z.uuid(),
    projectId: id,
    projectSourceId: z.uuid(),
    sourceKind: z.enum(["git", "folder"]),
    worktreeId: z.uuid(),
    workspaceId: z.uuid(),
    guestWorkspaceId: id,
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    homeGuestPath: cantripOsGuestPathSchema,
    guestPath: cantripOsGuestPathSchema,
    dependencyOverlays: cantripOsDependencyOverlaysSchema,
  })
  .strict();

export const cantripOsSourceDispatchScopeSchema = z.discriminatedUnion("mode", [
  sourceScope
    .extend({ mode: z.literal("linked"), linkedWorkerPath: z.string().min(1) })
    .strict(),
  sourceScope
    .extend({ mode: z.literal("linux-owned"), linkedWorkerPath: z.null() })
    .strict(),
]);

/** Execution is admitted on the existing authenticated worker connection. The
 * worker supplies that connection's verified logical Server identity. */
export const cantripOsExecutionScopeSchema = z.discriminatedUnion("mode", [
  sourceScope
    .omit({ serverId: true })
    .extend({ mode: z.literal("linked"), linkedWorkerPath: z.string().min(1) })
    .strict(),
  sourceScope
    .omit({ serverId: true })
    .extend({ mode: z.literal("linux-owned"), linkedWorkerPath: z.null() })
    .strict(),
]);
export const cantripOsExecutionSchema = z
  .object({
    kind: z.literal("cantrip-os"),
    scope: cantripOsExecutionScopeSchema,
    transport: cantripOsTransportSchema,
  })
  .strict();
export type CantripOsExecution = z.infer<typeof cantripOsExecutionSchema>;

export const cantripOsProvisionIntentSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("linked"),
      workerPath: z.string().min(1),
      dependencyOverlays: cantripOsDependencyOverlaysSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("linux-owned"),
      source: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("git"),
            repositoryUrl: z.string().min(1).max(32_768),
            revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
          })
          .strict(),
        z.object({ kind: z.literal("folder") }).strict(),
      ]),
    })
    .strict(),
]);

/** Repository URLs and private placement arguments use the existing protected
 * repository-content channel, bound to this admitted source operation. */
export const cantripOsProvisionRequestContentSchema = z
  .object({
    type: z.literal("cantrip-os.source.provision"),
    instanceId: z.uuid(),
    workspaceId: z.uuid(),
    bindingId: z.uuid(),
    bindingGeneration: z.uuid(),
    intent: cantripOsProvisionIntentSchema,
  })
  .strict();

/** Administrative commands are admitted by the owning Server. They do not
 * carry a model provider, arbitrary program/argv, or browser authorization. */
export const workerCantripOsCommandSchemas = [
  z
    .object({
      type: z.literal("cantrip-os.inspect"),
      ownerId: id,
      workerId: id,
      transport: cantripOsTransportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.attach"),
      scope,
      transport: cantripOsTransportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.workspaces.list"),
      scope,
      transport: cantripOsTransportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.workspaces.create"),
      scope,
      transport: cantripOsTransportSchema,
      guestWorkspaceId: id,
      operationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.source.provision"),
      scope: cantripOsSourceDispatchScopeSchema,
      transport: cantripOsTransportSchema,
      operationId: z.uuid(),
      protectedRequest: repositoryOperationOpaqueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.source.inspect"),
      scope: cantripOsSourceDispatchScopeSchema,
      transport: cantripOsTransportSchema,
      sourceKind: z.enum(["git", "folder"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("cantrip-os.operation.inspect"),
      scope,
      operationId: z.uuid(),
    })
    .strict(),
] as const;

export const cantripOsObservedInstanceSchema = z
  .object({
    guestInstanceId: z.uuid(),
    runtimeGeneration: z.uuid(),
    attachment: z.object({ ownerId: id, workerId: id }).strict().nullable(),
    workspaces: z.array(cantripOsWorkspaceObservationSchema),
  })
  .strict();

export const cantripOsSourceReceiptSchema = z
  .object({
    bindingId: z.uuid(),
    workspaceId: z.uuid(),
    guestWorkspaceId: id,
    mode: z.enum(["linked", "linux-owned"]),
    guestPath: cantripOsGuestPathSchema,
    runtimeGeneration: z.uuid(),
    uid: z.number().int().positive(),
    homeGuestPath: cantripOsGuestPathSchema,
    head: z.string().nullable(),
    branch: z.string().nullable(),
    detached: z.boolean(),
    repositoryFingerprint: id.nullable(),
    gitCommonGuestPath: cantripOsGuestPathSchema.nullable(),
    recreated: z.boolean(),
    interruptedGuestWorkspaces: z.array(id),
    dependencyOverlays: cantripOsDependencyOverlaysSchema,
    cleanupWarnings: z.array(z.string().max(4_000)),
  })
  .strict();

const operationReceipt = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      workspace: cantripOsWorkspaceObservationSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("source"), source: cantripOsSourceReceiptSchema })
    .strict(),
]);
const operationBase = z
  .object({
    operationId: z.uuid(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const cantripOsOperationResultSchema = z.discriminatedUnion("state", [
  operationBase
    .extend({
      state: z.literal("ready"),
      error: z.null(),
      receipt: operationReceipt,
    })
    .strict(),
  operationBase
    .extend({
      state: z.enum(["running", "failed", "unknown"]),
      error: z.string().max(4_000).nullable(),
      receipt: operationReceipt.nullable(),
    })
    .strict(),
]);

export type CantripOsDispatchScope = z.infer<
  typeof cantripOsDispatchScopeSchema
>;
export type CantripOsSourceDispatchScope = z.infer<
  typeof cantripOsSourceDispatchScopeSchema
>;
export type CantripOsProvisionIntent = z.infer<
  typeof cantripOsProvisionIntentSchema
>;
export type CantripOsSourceReceipt = z.infer<
  typeof cantripOsSourceReceiptSchema
>;
