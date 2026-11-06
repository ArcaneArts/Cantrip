import { z } from "zod";
import {
  cantripOsBackupOperationResultSchema,
  cantripOsBackupRequestEnvelopeSchema,
} from "./cantrip-os-backup-operations.js";

const admission = z.object({
  operationId: z.uuid(),
  workspaceId: z.uuid(),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
  protectedRequest: cantripOsBackupRequestEnvelopeSchema,
});
export const cantripOsBackupAdmissionSchema = z.discriminatedUnion("action", [
  admission.extend({ action: z.literal("capture") }).strict(),
  admission
    .extend({
      action: z.literal("restore"),
      backupId: z.uuid(),
      replace: z.boolean(),
    })
    .strict(),
  admission
    .extend({ action: z.literal("rollback"), restoreOperationId: z.uuid() })
    .strict(),
]);
export const cantripOsBackupRecoverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.enum(["observe", "recover"]) }).strict(),
  z
    .object({
      mode: z.literal("continue"),
      attachmentGeneration: z.uuid(),
      runtimeGeneration: z.uuid(),
    })
    .strict(),
]);
export const cantripOsBackupListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.uuid().optional(),
  })
  .strict();
export const cantripOsBackupSummarySchema = z
  .object({
    operationId: z.uuid(),
    action: z.enum(["capture", "restore", "rollback"]),
    instanceId: z.uuid(),
    workspaceId: z.uuid(),
    workerId: z.string().min(1),
    backupId: z.uuid().nullable(),
    restoreOperationId: z.uuid().nullable(),
    protectedRequest: cantripOsBackupRequestEnvelopeSchema,
    result: cantripOsBackupOperationResultSchema.nullable(),
    workerConnected: z.boolean(),
    archiveAvailability: z.enum(["not-checked", "worker-offline"]).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const cantripOsBackupPageSchema = z
  .object({
    items: z.array(cantripOsBackupSummarySchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export type CantripOsBackupAdmission = z.infer<
  typeof cantripOsBackupAdmissionSchema
>;
export type CantripOsBackupListQuery = z.infer<
  typeof cantripOsBackupListQuerySchema
>;
