import { z } from "zod";
import {
  cantripOsGuestPathSchema,
  cantripOsTransportSchema,
} from "./cantrip-os.js";
import { cantripOsDispatchScopeSchema } from "./worker-command-cantrip-os.js";
import {
  cantripOsBackupArchiveMetadataSchema,
  cantripOsBackupFrameSchema,
} from "./cantrip-os-backup.js";

export const cantripOsBackupRequestSequence = 1;
export const cantripOsBackupResponseSequence = 2;
export const cantripOsBackupRequestEnvelopeSchema =
  cantripOsBackupFrameSchema.extend({
    kind: z.literal("metadata"),
    sequence: z.literal(1),
  });
export const cantripOsBackupResponseEnvelopeSchema =
  cantripOsBackupFrameSchema.extend({
    kind: z.literal("metadata"),
    sequence: z.literal(2),
  });
export const cantripOsBackupWorkspaceSchema = z
  .object({
    id: z.uuid(),
    guestWorkspaceId: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    homeGuestPath: cantripOsGuestPathSchema,
  })
  .strict();
export const cantripOsBackupSourceSchema = z
  .object({
    bindingId: z.uuid(),
    projectId: z.string().min(1).max(200),
    projectSourceId: z.uuid(),
    worktreeId: z.uuid(),
    mode: z.enum(["linked", "linux-owned"]),
    guestPath: cantripOsGuestPathSchema,
    gitCommonGuestPath: cantripOsGuestPathSchema.nullable(),
  })
  .strict();

export const cantripOsBackupPrivateRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("capture"),
        workspaceId: z.uuid(),
        label: z.string().max(160),
        exclusions: z.array(z.string().min(1).max(8192)).max(1000),
      })
      .strict(),
    z
      .object({
        action: z.literal("restore"),
        workspaceId: z.uuid(),
        backupId: z.uuid(),
        replace: z.boolean(),
      })
      .strict(),
    z
      .object({
        action: z.literal("rollback"),
        workspaceId: z.uuid(),
        restoreOperationId: z.uuid(),
      })
      .strict(),
  ],
);

const base = z.object({
  operationId: z.uuid(),
  scope: cantripOsDispatchScopeSchema,
  transport: cantripOsTransportSchema,
  workspace: cantripOsBackupWorkspaceSchema,
  protectedRequest: cantripOsBackupRequestEnvelopeSchema,
});
export const cantripOsBackupCaptureCommandSchema = base
  .extend({
    type: z.literal("cantrip-os.backup.capture"),
    sources: z.array(cantripOsBackupSourceSchema).max(10000),
  })
  .strict();
export const cantripOsBackupRestoreCommandSchema = base
  .extend({
    type: z.literal("cantrip-os.backup.restore"),
    backupId: z.uuid(),
    backupScope: cantripOsDispatchScopeSchema,
    replace: z.boolean(),
  })
  .strict();
export const cantripOsBackupRollbackCommandSchema = base
  .extend({
    type: z.literal("cantrip-os.backup.rollback"),
    restoreOperationId: z.uuid(),
  })
  .strict();
export const cantripOsBackupObserveCommandSchema = z
  .object({
    type: z.literal("cantrip-os.backup.observe"),
    scope: cantripOsDispatchScopeSchema,
    operationId: z.uuid(),
    action: z.enum(["capture", "restore", "rollback"]),
    mode: z.enum(["observe", "recover", "continue"]),
  })
  .strict();
export const workerCantripOsBackupCommandSchemas = [
  cantripOsBackupCaptureCommandSchema,
  cantripOsBackupRestoreCommandSchema,
  cantripOsBackupRollbackCommandSchema,
  cantripOsBackupObserveCommandSchema,
] as const;
export const cantripOsBackupWorkerCommandSchema = z.discriminatedUnion(
  "type",
  workerCantripOsBackupCommandSchemas,
);
export const cantripOsBackupPhaseSchema = z.enum([
  "admitted",
  "capturing",
  "sealing",
  "verifying",
  "receiving",
  "activating",
  "rolling-back",
  "complete",
  "recovery-required",
]);
const operationResultBase = z
  .object({
    operationId: z.uuid(),
    action: z.enum(["capture", "restore", "rollback"]),
    phase: cantripOsBackupPhaseSchema,
    startedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    error: z.string().max(1000).nullable(),
  })
  .strict();
export const cantripOsBackupOperationResultSchema = z.discriminatedUnion(
  "state",
  [
    operationResultBase
      .extend({
        state: z.literal("ready"),
        protectedResult: cantripOsBackupResponseEnvelopeSchema,
        error: z.null(),
      })
      .strict(),
    operationResultBase
      .extend({
        state: z.enum(["running", "failed", "unknown"]),
        protectedResult: cantripOsBackupResponseEnvelopeSchema.nullable(),
      })
      .strict(),
  ],
);
export const cantripOsBackupPrivateResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("error"),
        operationAction: z.enum(["capture", "restore", "rollback"]),
        message: z.string().max(8192),
      })
      .strict(),
    z
      .object({
        action: z.literal("capture"),
        metadata: cantripOsBackupArchiveMetadataSchema,
        cleanupWarnings: z.array(z.string().max(1000)),
      })
      .strict(),
    z
      .object({
        action: z.literal("restore"),
        backupId: z.uuid(),
        receipt: z.record(z.string(), z.unknown()),
        cleanupWarnings: z.array(z.string().max(1000)),
      })
      .strict(),
    z
      .object({
        action: z.literal("rollback"),
        restoreOperationId: z.uuid(),
        receipt: z.record(z.string(), z.unknown()),
        cleanupWarnings: z.array(z.string().max(1000)),
      })
      .strict(),
  ],
);
export type CantripOsBackupWorkerCommand = z.infer<
  typeof cantripOsBackupWorkerCommandSchema
>;
export type CantripOsBackupOperationResult = z.infer<
  typeof cantripOsBackupOperationResultSchema
>;
export type CantripOsBackupPrivateResult = z.infer<
  typeof cantripOsBackupPrivateResultSchema
>;
export type CantripOsBackupWorkspace = z.infer<
  typeof cantripOsBackupWorkspaceSchema
>;
