import { z } from "zod";
import {
  cantripOsGuestPathSchema,
  cantripOsTransportSchema,
} from "./cantrip-os.js";
import { cantripOsDispatchScopeSchema } from "./worker-command-cantrip-os.js";

export const cantripOsDesktopActionSchema = z.enum([
  "start",
  "stop",
  "restart",
]);
const evidence = z.enum(["acknowledged-and-observed", "observed-state"]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const cantripOsGuestDesktopTargetSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  user: z.string().regex(/^ctw-[a-z][a-z0-9-]{0,23}$/),
  uid: z.number().int().positive().safe(),
  gid: z.number().int().positive().safe(),
  home: cantripOsGuestPathSchema,
  display: z.number().int().positive().safe(),
  generation: z.number().int().nonnegative().safe(),
  desktop_generation: hash.nullable(),
  status: z.enum(["running", "stopped"]),
});
export const cantripOsDesktopScopeSchema = cantripOsDispatchScopeSchema
  .extend({
    workspaceId: z.uuid(),
    guestWorkspaceId: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
    uid: z.number().int().positive().safe(),
    gid: z.number().int().positive().safe(),
    homeGuestPath: cantripOsGuestPathSchema,
  })
  .strict();
export type CantripOsDesktopScope = z.infer<typeof cantripOsDesktopScopeSchema>;
export type CantripOsGuestDesktopTarget = z.infer<
  typeof cantripOsGuestDesktopTargetSchema
>;

export const cantripOsGuestDesktopRequestSchema = z.strictObject({
  operation_id: z.uuid(),
  action: cantripOsDesktopActionSchema,
  scope_key: hash,
  target: cantripOsGuestDesktopTargetSchema,
});
export const cantripOsGuestDesktopReceiptSchema = z.strictObject({
  completion: evidence,
  before: cantripOsGuestDesktopTargetSchema,
  after: cantripOsGuestDesktopTargetSchema,
});
export const cantripOsGuestDesktopResultSchema = z.strictObject({
  version: z.literal(1),
  request: cantripOsGuestDesktopRequestSchema,
  state: z.enum(["reserved", "dispatched", "ready", "failed", "unknown"]),
  started_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  error: z.string().nullable(),
  receipt: cantripOsGuestDesktopReceiptSchema.nullable(),
  current: cantripOsGuestDesktopTargetSchema.nullable(),
  current_error: z.string().nullable(),
});
const capture = z.strictObject({
  scope: cantripOsDesktopScopeSchema,
  transport: cantripOsTransportSchema,
});
export const workerCantripOsDesktopCommandSchemas = [
  capture.extend({ type: z.literal("cantrip-os.desktop.status") }).strict(),
  capture
    .extend({
      type: z.literal("cantrip-os.desktop.operation"),
      mode: z.enum(["execute", "observe"]),
      operationId: z.uuid(),
      action: cantripOsDesktopActionSchema,
      targetGeneration: z.uuid(),
      desktopTarget: cantripOsGuestDesktopTargetSchema,
    })
    .strict(),
] as const;
export const cantripOsDesktopWorkerCommandSchema = z.discriminatedUnion(
  "type",
  workerCantripOsDesktopCommandSchemas,
);
export type CantripOsDesktopWorkerCommand = z.infer<
  typeof cantripOsDesktopWorkerCommandSchema
>;

export const cantripOsDesktopReceiptSchema = z.strictObject({
  targetGeneration: z.uuid(),
  before: cantripOsGuestDesktopTargetSchema,
  after: cantripOsGuestDesktopTargetSchema,
  completionEvidence: evidence,
});
const result = z.strictObject({
  operationId: z.uuid(),
  action: cantripOsDesktopActionSchema,
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  observation: cantripOsGuestDesktopTargetSchema.nullable(),
  observationError: z.string().max(4000).nullable(),
});
export const cantripOsDesktopOperationResultSchema = z.discriminatedUnion(
  "state",
  [
    result
      .extend({
        state: z.literal("ready"),
        error: z.null(),
        receipt: cantripOsDesktopReceiptSchema,
      })
      .strict(),
    result
      .extend({
        state: z.enum(["running", "failed", "unknown"]),
        error: z.string().max(4000).nullable(),
        receipt: z.null(),
      })
      .strict(),
  ],
);
export type CantripOsDesktopOperationResult = z.infer<
  typeof cantripOsDesktopOperationResultSchema
>;
export const cantripOsDesktopCreateSchema = z.strictObject({
  operationId: z.uuid(),
  action: cantripOsDesktopActionSchema,
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
  targetGeneration: z.uuid(),
});
export type CantripOsDesktopCreate = z.infer<
  typeof cantripOsDesktopCreateSchema
>;
export const cantripOsDesktopTargetSummarySchema = z.strictObject({
  generation: z.uuid(),
  instanceId: z.uuid(),
  workspaceId: z.uuid(),
  workerId: z.string().min(1),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
  verifiedAt: z.iso.datetime(),
});
export const cantripOsDesktopStatusSchema = z.strictObject({
  target: cantripOsDesktopTargetSummarySchema.nullable(),
  observation: z
    .strictObject({ status: z.enum(["running", "stopped"]) })
    .nullable(),
  error: z.string().max(4000).nullable(),
});
export const cantripOsDesktopSummarySchema = z.strictObject({
  operationId: z.uuid(),
  instanceId: z.uuid(),
  workspaceId: z.uuid(),
  workerId: z.string().min(1),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
  targetGeneration: z.uuid(),
  action: cantripOsDesktopActionSchema,
  state: z.enum(["admitted", "running", "ready", "failed", "unknown"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: z.string().max(4000).nullable(),
  completionEvidence: evidence.nullable(),
});
export const cantripOsDesktopListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export const cantripOsDesktopPageSchema = z.strictObject({
  items: z.array(cantripOsDesktopSummarySchema),
  nextCursor: z.uuid().nullable(),
});
