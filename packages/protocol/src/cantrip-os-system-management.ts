import { z } from "zod";
import {
  cantripOsSystemBaseImageSchema,
  cantripOsSystemOperationContextSchema,
  cantripOsSystemProtectedOperationResultSchema,
  cantripOsSystemRootReceiptSchema,
} from "./cantrip-os-system-operations.js";

const request = z
  .object({
    operationId: z.uuid(),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
  })
  .strict();
export const cantripOsSystemCreateSchema = z.discriminatedUnion("action", [
  request
    .extend({
      action: z.literal("capture"),
      resumeOriginal: z.boolean().default(true),
    })
    .strict(),
  request
    .extend({
      action: z.literal("replace"),
      startTarget: z.boolean().default(true),
      source: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("checkpoint"), operationId: z.uuid() })
          .strict(),
        z
          .object({
            kind: z.literal("base"),
            imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      ]),
    })
    .strict(),
  request
    .extend({
      action: z.literal("rollback"),
      replacementOperationId: z.uuid(),
      startTarget: z.boolean().default(true),
    })
    .strict(),
]);
/** The current Server fence, not the immutable command's original attachment. */
export const cantripOsSystemControlSchema = z
  .object({
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
  })
  .strict();
export const cantripOsSystemTargetSummarySchema = z
  .object({
    generation: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1).max(200),
    attachmentGeneration: z.uuid(),
    architecture: z.string().min(1).max(200).nullable(),
    running: z.boolean().nullable(),
    verifiedAt: z.iso.datetime(),
  })
  .strict();
export const cantripOsSystemStatusSchema = z
  .object({
    supported: z.boolean(),
    target: cantripOsSystemTargetSummarySchema.nullable(),
    bases: z.array(cantripOsSystemBaseImageSchema).max(256),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsSystemSummarySchema = z
  .object({
    operationId: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1).max(200),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    request: cantripOsSystemCreateSchema,
    context: cantripOsSystemOperationContextSchema,
    state: z.enum([
      "admitted",
      "running",
      "ready",
      "failed",
      "unknown",
      "rejected",
    ]),
    dispatchStage: z.enum(["preparing", "executing"]),
    phase: z.string().min(1).max(200),
    retiredBy: z.uuid().nullable(),
    recoveryGeneration: z.uuid().nullable(),
    root: cantripOsSystemRootReceiptSchema.nullable(),
    protectedResult: cantripOsSystemProtectedOperationResultSchema.nullable(),
    error: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const cantripOsSystemListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
export const cantripOsSystemPageSchema = z
  .object({
    items: z.array(cantripOsSystemSummarySchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export type CantripOsSystemCreate = z.infer<typeof cantripOsSystemCreateSchema>;
export type CantripOsSystemControl = z.infer<
  typeof cantripOsSystemControlSchema
>;
