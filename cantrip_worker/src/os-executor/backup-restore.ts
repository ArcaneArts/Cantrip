import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { openPrivateBackup } from "./private-backup-file.js";
import {
  backupFile,
  clearBackupStaging,
  completeBackup,
  expectedArguments,
  forgetGuestStaging,
  guestRecord,
  prepareBackupStaging,
  privateBackupRequest,
  releaseGuestMaintenance,
  type BackupContext,
} from "./backup-context.js";

export async function restoreWorkspace(ctx: BackupContext) {
  const command = ctx.command;
  if (command.type !== "cantrip-os.backup.restore")
    throw new Error("Not a workspace restore.");
  if (
    command.backupScope.ownerId !== command.scope.ownerId ||
    command.backupScope.workerId !== command.scope.workerId ||
    command.backupScope.serverId !== command.scope.serverId
  )
    throw new Error("The backup belongs to another account, Worker or Server.");
  let guest;
  const beforeReceive =
    ctx.checkpoint.phase === "admitted" || ctx.checkpoint.phase === "verifying";
  if (ctx.mode === "new" || (ctx.mode === "continue" && beforeReceive)) {
    await privateBackupRequest(ctx);
    await ctx.assertCurrent();
    ctx.checkpoint.phase = "verifying";
    await ctx.save();
    await clearBackupStaging(ctx);
    const destination = await prepareBackupStaging(ctx);
    const verified = await openPrivateBackup({
      source: backupFile(ctx.directory, command.backupScope, command.backupId),
      destination,
      keys: ctx.keys,
      context: {
        ownerId: command.scope.ownerId,
        serverId: command.scope.serverId,
        backupId: command.backupId,
      },
    });
    const provenance = z
      .object({ cantrip: z.object({ scope: z.unknown() }) })
      .passthrough()
      .parse(verified.metadata.manifest);
    if (!isDeepStrictEqual(provenance.cantrip.scope, command.backupScope))
      throw new Error("Backup captured placement differs from its admission.");
    await ctx.assertCurrent();
    ctx.checkpoint.archiveSha256 = verified.metadata.archiveSha256;
    ctx.checkpoint.phase = "receiving";
    await ctx.save();
    guest = await ctx.ports.control({
      transport: command.transport,
      args: [
        ...expectedArguments(command, true, ctx.mutationScope),
        "receive",
        command.operationId,
        command.workspace.guestWorkspaceId,
        "--request",
        JSON.stringify({
          archive_bytes: verified.metadata.archiveBytes,
          archive_sha256: verified.metadata.archiveSha256,
          replace: command.replace,
        }),
      ],
      input: createReadStream(destination),
    });
  } else {
    guest = await releaseGuestMaintenance(ctx, await guestRecord(ctx));
  }
  if (guest.operation_id !== command.operationId || guest.action !== "restore")
    throw new Error("Misrouted guest restore receipt.");
  if (
    guest.state === "received" &&
    (ctx.mode === "new" || ctx.mode === "continue")
  ) {
    await ctx.assertCurrent();
    ctx.checkpoint.phase = "activating";
    await ctx.save();
    guest = await ctx.ports.control({
      transport: command.transport,
      args: [
        ...expectedArguments(command, true, ctx.mutationScope),
        "restore",
        command.operationId,
      ],
    });
  }
  if (
    (guest.state === "restored" || guest.state === "forgotten") &&
    guest.receipt
  ) {
    const receipt = z
      .object({
        workspace: z
          .object({
            id: z.string(),
            uid: z.number(),
            gid: z.number(),
            home: z.string(),
          })
          .passthrough(),
        runtime_handles_restored: z.literal(false),
        archive_sha256: z.string(),
        retained_original_home: z.string(),
      })
      .passthrough()
      .parse(guest.receipt);
    if (
      !isDeepStrictEqual(
        {
          id: receipt.workspace.id,
          uid: receipt.workspace.uid,
          gid: receipt.workspace.gid,
          home: receipt.workspace.home,
        },
        {
          id: command.workspace.guestWorkspaceId,
          uid: command.workspace.uid,
          gid: command.workspace.gid,
          home: command.workspace.homeGuestPath,
        },
      )
    )
      throw new Error("Restored account differs from its canonical admission.");
    if (receipt.archive_sha256 !== ctx.checkpoint.archiveSha256)
      throw new Error(
        "Restored archive differs from its verified backup admission.",
      );
    const cleanupWarnings =
      ctx.mode === "observe"
        ? [
            "Guest transfer staging cleanup was not requested during observation.",
          ]
        : await forgetGuestStaging(ctx);
    try {
      await clearBackupStaging(ctx);
    } catch {
      cleanupWarnings.push(
        "Worker restore staging cleanup could not be confirmed.",
      );
    }
    return completeBackup(ctx, {
      action: "restore",
      backupId: command.backupId,
      receipt,
      cleanupWarnings,
    });
  }
  if (
    guest.state === "failed" &&
    (!guest.maintenance || guest.maintenance.released)
  ) {
    ctx.record.state = "failed";
    await clearBackupStaging(ctx);
  } else if (guest.active && guest.state !== "received")
    ctx.record.state = "running";
  else ctx.checkpoint.phase = "recovery-required";
  return null;
}

export async function rollbackWorkspace(ctx: BackupContext) {
  const command = ctx.command;
  if (command.type !== "cantrip-os.backup.rollback")
    throw new Error("Not a workspace rollback.");
  let guest;
  if (
    ctx.mode === "new" ||
    (ctx.mode === "continue" && ctx.checkpoint.phase === "admitted")
  ) {
    await privateBackupRequest(ctx);
    await ctx.assertCurrent();
    ctx.checkpoint.phase = "rolling-back";
    await ctx.save();
    guest = await ctx.ports.control({
      transport: command.transport,
      args: [
        ...expectedArguments(command, true, ctx.mutationScope),
        "rollback",
        command.operationId,
        command.restoreOperationId,
      ],
    });
  } else guest = await releaseGuestMaintenance(ctx, await guestRecord(ctx));
  if (guest.operation_id !== command.operationId || guest.action !== "rollback")
    throw new Error("Misrouted guest rollback receipt.");
  if (guest.state === "rolled-back" && guest.receipt) {
    const receipt = z
      .object({
        restore_operation_id: z.string(),
        workspace: z.string(),
        runtime_handles_restored: z.literal(false),
      })
      .passthrough()
      .parse(guest.receipt);
    if (
      receipt.restore_operation_id !== command.restoreOperationId ||
      receipt.workspace !== command.workspace.guestWorkspaceId
    )
      throw new Error("Rollback restored a different admission.");
    return completeBackup(ctx, {
      action: "rollback",
      restoreOperationId: command.restoreOperationId,
      receipt,
      cleanupWarnings: [],
    });
  }
  if (
    guest.state === "failed" &&
    (!guest.maintenance || guest.maintenance.released)
  )
    ctx.record.state = "failed";
  else if (guest.active) ctx.record.state = "running";
  else ctx.checkpoint.phase = "recovery-required";
  return null;
}
