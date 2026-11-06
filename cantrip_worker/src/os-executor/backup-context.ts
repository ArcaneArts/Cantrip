import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  clearSensitiveBytes,
  decryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import {
  cantripOsBackupWorkerCommandSchema,
  cantripOsBackupPhaseSchema,
  cantripOsBackupPrivateRequestSchema,
  cantripOsBackupResponseEnvelopeSchema,
  type CantripOsBackupWorkerCommand,
  type CantripOsBackupPrivateResult,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import type { CantripOsDispatchScope } from "@cantrip/protocol";
import type { OsOperationRecord } from "./operations.js";
import type { BackupKeyAccess } from "./private-backup-file.js";
import { protectBackupResult } from "./backup-result.js";
import {
  recoveryControl,
  exportRecoveryArchive,
  type RecoveryGuestRecord,
} from "./recovery-carrier.js";

export type MutableBackupCommand = Exclude<
  CantripOsBackupWorkerCommand,
  { type: "cantrip-os.backup.observe" }
>;
export const backupCheckpointSchema = z
  .object({
    version: z.literal(1),
    command: cantripOsBackupWorkerCommandSchema,
    phase: cantripOsBackupPhaseSchema,
    archiveSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type BackupCheckpoint = z.infer<typeof backupCheckpointSchema>;
export const backupReceiptSchema = z
  .object({
    kind: z.literal("backup-result"),
    action: z.enum(["capture", "restore", "rollback"]),
    protectedResult: cantripOsBackupResponseEnvelopeSchema,
  })
  .strict();
export interface BackupPorts {
  control: typeof recoveryControl;
  exportArchive: typeof exportRecoveryArchive;
}
export const backupPorts: BackupPorts = {
  control: recoveryControl,
  exportArchive: exportRecoveryArchive,
};
export interface BackupContext {
  directory: string;
  command: MutableBackupCommand;
  keys: BackupKeyAccess;
  ports: BackupPorts;
  record: OsOperationRecord;
  checkpoint: BackupCheckpoint;
  save: () => Promise<void>;
  mode: "new" | "observe" | "recover" | "continue";
  mutationScope: CantripOsDispatchScope;
  assertCurrent: () => Promise<void>;
}

export function backupFile(
  directory: string,
  scope: CantripOsDispatchScope,
  backupId: string,
) {
  z.uuid().parse(backupId);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.ownerId,
        scope.workerId,
        scope.instanceId,
        scope.guestInstanceId,
      ]),
    )
    .digest("hex");
  return path.join(
    directory,
    "cantrip-os-backups",
    key,
    backupId,
    "archive.ctos",
  );
}
export function backupStaging(ctx: BackupContext) {
  return path.join(
    path.dirname(
      backupFile(ctx.directory, ctx.command.scope, ctx.command.operationId),
    ),
    "restore-staging",
  );
}
export async function prepareBackupDirectory(
  ctx: BackupContext,
  directory: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const boundary = path.resolve(ctx.directory);
  for (let current = path.resolve(directory); ;) {
    const handle = await open(current, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error("Backup directory is outside its Worker storage.");
    current = parent;
  }
}
export function expectedArguments(
  command: MutableBackupCommand,
  mutation = false,
  scope = command.scope,
) {
  return [
    "--expect",
    JSON.stringify({
      guestInstanceId: scope.guestInstanceId,
      ownerId: scope.ownerId,
      workerId: scope.workerId,
      ...(mutation ? { runtimeGeneration: scope.runtimeGeneration } : {}),
    }),
    ...(mutation
      ? [
          "--expect-workspace",
          JSON.stringify({
            uid: command.workspace.uid,
            gid: command.workspace.gid,
            home: command.workspace.homeGuestPath,
          }),
        ]
      : []),
  ];
}
export function assertBackupAccount(
  keys: BackupKeyAccess,
  scope: CantripOsDispatchScope,
) {
  if (
    keys.ownerId() !== scope.ownerId ||
    keys.serverIdentity() !== scope.serverId
  )
    throw new Error("The backup account or logical Server changed.");
}
export async function privateBackupRequest(
  ctx: Pick<BackupContext, "command" | "keys">,
) {
  const { command, keys } = ctx;
  assertBackupAccount(keys, command.scope);
  const material = keys.componentKey(
    "repository-content",
    command.protectedRequest.envelope.keyRevision,
  );
  try {
    const plaintext = await decryptCantripOsBackupMessage({
      ...command.scope,
      operationId: command.operationId,
      componentKey: material.key,
      keyRevision: material.keyRevision,
      direction: "request",
      frame: command.protectedRequest,
    });
    try {
      const request = cantripOsBackupPrivateRequestSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
      if (
        request.workspaceId !== command.workspace.id ||
        `cantrip-os.backup.${request.action}` !== command.type ||
        (command.type === "cantrip-os.backup.restore" &&
          (request.action !== "restore" ||
            request.backupId !== command.backupId ||
            request.replace !== command.replace)) ||
        (command.type === "cantrip-os.backup.rollback" &&
          (request.action !== "rollback" ||
            request.restoreOperationId !== command.restoreOperationId))
      )
        throw new Error(
          "Private backup intent does not match its canonical admission.",
        );
      return request;
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(material.key);
  }
}
export async function completeBackup(
  ctx: BackupContext,
  value: Exclude<CantripOsBackupPrivateResult, { action: "error" }>,
) {
  const envelope = await protectBackupResult(
    ctx.keys,
    ctx.command.scope,
    ctx.command.operationId,
    value,
  );
  ctx.record.receipt = backupReceiptSchema.parse({
    kind: "backup-result",
    action: value.action,
    protectedResult: envelope,
  });
  ctx.record.state = "ready";
  ctx.record.error = null;
  ctx.checkpoint.phase = "complete";
  await ctx.save();
  return ctx.record.receipt;
}
export async function guestRecord(ctx: BackupContext) {
  const result = await ctx.ports.control({
    transport: ctx.command.transport,
    args: [
      ...expectedArguments(ctx.command),
      "inspect",
      ctx.command.operationId,
    ],
  });
  const action = ctx.command.type.slice("cantrip-os.backup.".length);
  if (
    result.operation_id !== ctx.command.operationId ||
    result.action !== action
  )
    throw new Error("Guest recovery receipt belongs to another operation.");
  return result;
}
export async function releaseGuestMaintenance(
  ctx: BackupContext,
  guest: RecoveryGuestRecord,
) {
  const unfinished =
    guest.state === "unknown" ||
    guest.state === "restoring" ||
    Boolean(guest.maintenance && !guest.maintenance.released);
  if (!unfinished) return guest;
  if (guest.active) {
    ctx.record.state = "running";
    return guest;
  }
  if (ctx.mode === "observe") {
    ctx.checkpoint.phase = "recovery-required";
    return guest;
  }
  return ctx.ports.control({
    transport: ctx.command.transport,
    args: [
      ...expectedArguments(ctx.command),
      "recover",
      ctx.command.operationId,
    ],
  });
}
export async function forgetGuestStaging(ctx: BackupContext) {
  try {
    await ctx.ports.control({
      transport: ctx.command.transport,
      args: [
        ...expectedArguments(ctx.command),
        "forget",
        ctx.command.operationId,
      ],
    });
    return [];
  } catch {
    return ["Guest transfer staging cleanup could not be confirmed."];
  }
}
export async function clearBackupStaging(ctx: BackupContext) {
  await rm(backupStaging(ctx), { recursive: true, force: true });
}
export async function prepareBackupStaging(ctx: BackupContext) {
  const directory = backupStaging(ctx);
  await prepareBackupDirectory(ctx, directory);
  return path.join(directory, "verified.tar");
}
