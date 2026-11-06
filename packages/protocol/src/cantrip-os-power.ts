import { z } from "zod";
import { cantripOsDispatchScopeSchema } from "./worker-command-cantrip-os.js";
import {
  cantripOsPowerActionSchema,
  cantripOsPowerEvidenceSchema,
  cantripOsPowerObservationSchema,
  cantripOsPowerTargetSchema,
} from "./cantrip-os-power-state.js";
export * from "./cantrip-os-power-state.js";

const transport = z
  .object({ kind: z.literal("docker"), container: z.string().min(1).max(200) })
  .strict();
const target = z
  .object({
    scope: cantripOsDispatchScopeSchema,
    transport,
    powerTarget: cantripOsPowerTargetSchema,
  })
  .strict();
export const workerCantripOsPowerCommandSchemas = [
  target.extend({ type: z.literal("cantrip-os.power.status") }).strict(),
  target
    .extend({
      type: z.literal("cantrip-os.power.operation"),
      mode: z.enum(["execute", "observe"]),
      operationId: z.uuid(),
      action: cantripOsPowerActionSchema,
    })
    .strict(),
] as const;
export const cantripOsPowerWorkerCommandSchema = z.discriminatedUnion(
  "type",
  workerCantripOsPowerCommandSchemas,
);
export type CantripOsPowerWorkerCommand = z.infer<
  typeof cantripOsPowerWorkerCommandSchema
>;

export const cantripOsPowerReceiptSchema = z
  .object({
    targetGeneration: z.uuid(),
    containerId: z.string().min(1).max(200),
    before: cantripOsPowerObservationSchema,
    after: cantripOsPowerObservationSchema,
    completionEvidence: cantripOsPowerEvidenceSchema,
  })
  .strict();
const outcome = z
  .object({
    operationId: z.uuid(),
    action: cantripOsPowerActionSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    observation: cantripOsPowerObservationSchema.nullable(),
    observationError: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsPowerOperationResultSchema = z.discriminatedUnion(
  "state",
  [
    outcome
      .extend({
        state: z.literal("ready"),
        error: z.null(),
        receipt: cantripOsPowerReceiptSchema,
      })
      .strict(),
    outcome
      .extend({
        state: z.enum(["running", "failed", "unknown"]),
        error: z.string().max(4000).nullable(),
        receipt: z.null(),
      })
      .strict(),
  ],
);
export type CantripOsPowerOperationResult = z.infer<
  typeof cantripOsPowerOperationResultSchema
>;

export const cantripOsPowerCreateSchema = z
  .object({
    operationId: z.uuid(),
    action: cantripOsPowerActionSchema,
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
  })
  .strict();
export type CantripOsPowerCreate = z.infer<typeof cantripOsPowerCreateSchema>;

export const cantripOsPowerTargetSummarySchema = z
  .object({
    kind: z.literal("docker"),
    generation: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1),
    attachmentGeneration: z.uuid(),
    verifiedAt: z.iso.datetime(),
  })
  .strict();
export const cantripOsPowerStatusSchema = z
  .object({
    target: cantripOsPowerTargetSummarySchema.nullable(),
    observation: cantripOsPowerObservationSchema
      .omit({ containerId: true })
      .nullable(),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsPowerSummarySchema = z
  .object({
    operationId: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    action: cantripOsPowerActionSchema,
    state: z.enum(["admitted", "running", "ready", "failed", "unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    error: z.string().max(4000).nullable(),
    completionEvidence: cantripOsPowerEvidenceSchema.nullable(),
    powerState: cantripOsPowerObservationSchema
      .omit({ containerId: true })
      .nullable(),
  })
  .strict();
export const cantripOsPowerListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.uuid().optional(),
  })
  .strict();
export const cantripOsPowerPageSchema = z
  .object({
    items: z.array(cantripOsPowerSummarySchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
