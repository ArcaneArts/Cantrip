import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { cantripOsBackupArchiveMetadataSchema } from "@cantrip/protocol/cantrip-os-backup";
import {
  sealPrivateBackup,
  verifyPrivateBackup,
} from "./private-backup-file.js";
import { OsExecutorDeliveryError } from "./connection.js";
import {
  backupFile,
  completeBackup,
  expectedArguments,
  forgetGuestStaging,
  guestRecord,
  privateBackupRequest,
  prepareBackupDirectory,
  releaseGuestMaintenance,
  type BackupContext,
} from "./backup-context.js";

export async function captureWorkspace(ctx: BackupContext) {
  const command = ctx.command;
  if (command.type !== "cantrip-os.backup.capture")
    throw new Error("Not a workspace capture.");
  const context = {
    ownerId: command.scope.ownerId,
    serverId: command.scope.serverId,
    backupId: command.operationId,
  };
  const destination = backupFile(
    ctx.directory,
    command.scope,
    command.operationId,
  );
  let metadata;
  // Observe the actual authenticated file, not just its existence or a saved
  // phase flag. This also recovers publication before its Worker receipt saved.
  if (ctx.mode !== "new") {
    try {
      metadata = (
        await verifyPrivateBackup({
          context,
          keys: ctx.keys,
          source: destination,
        })
      ).metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (metadata) {
    const provenance = z
      .object({
        cantrip: z.object({ scope: z.unknown(), workspace: z.unknown() }),
      })
      .passthrough()
      .parse(metadata.manifest);
    if (
      !isDeepStrictEqual(provenance.cantrip.scope, command.scope) ||
      !isDeepStrictEqual(provenance.cantrip.workspace, command.workspace)
    )
      throw new Error("Published backup has a different captured placement.");
    return completeBackup(ctx, {
      action: "capture",
      metadata,
      cleanupWarnings:
        ctx.mode === "observe"
          ? [
              "Guest transfer staging cleanup was not requested during observation.",
            ]
          : await forgetGuestStaging(ctx),
    });
  }
  let guest;
  if (ctx.mode === "new") {
    await ctx.assertCurrent();
    const request = await privateBackupRequest(ctx);
    if (request.action !== "capture") throw new Error("Wrong capture intent.");
    ctx.checkpoint.phase = "capturing";
    await ctx.save();
    guest = await ctx.ports.control({
      transport: command.transport,
      args: [
        ...expectedArguments(command, true),
        "capture",
        command.operationId,
        command.workspace.guestWorkspaceId,
        "--request",
        JSON.stringify({
          exclusions: request.exclusions,
          sources: command.sources.map((source) => ({
            mode: source.mode,
            guestPath: source.guestPath,
            bindingId: source.bindingId,
            projectSourceId: source.projectSourceId,
            worktreeId: source.worktreeId,
            ...(source.mode === "linux-owned" && source.gitCommonGuestPath
              ? { gitMetadataPaths: [source.gitCommonGuestPath] }
              : {}),
          })),
        }),
      ],
    });
  } else guest = await releaseGuestMaintenance(ctx, await guestRecord(ctx));
  if (guest.operation_id !== command.operationId || guest.action !== "capture")
    throw new Error("Misrouted guest capture receipt.");
  if (guest.state !== "captured" || !guest.maintenance?.released) {
    if (guest.state === "failed") ctx.record.state = "failed";
    else if (guest.active) ctx.record.state = "running";
    return null;
  }
  const request = await privateBackupRequest(ctx);
  if (request.action !== "capture") throw new Error("Wrong capture intent.");
  const captured = z
    .object({
      archive_bytes: z.number().int().nonnegative(),
      archive_sha256: z.string(),
      manifest: z
        .object({
          workspace: z
            .object({
              id: z.string(),
              uid: z.number(),
              gid: z.number(),
              home: z.string(),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(guest.receipt);
  if (
    !isDeepStrictEqual(
      {
        id: captured.manifest.workspace.id,
        uid: captured.manifest.workspace.uid,
        gid: captured.manifest.workspace.gid,
        home: captured.manifest.workspace.home,
      },
      {
        id: command.workspace.guestWorkspaceId,
        uid: command.workspace.uid,
        gid: command.workspace.gid,
        home: command.workspace.homeGuestPath,
      },
    )
  )
    throw new Error("Captured workspace account differs from its admission.");
  metadata = cantripOsBackupArchiveMetadataSchema.parse({
    version: 1,
    archiveBytes: captured.archive_bytes,
    archiveSha256: captured.archive_sha256,
    manifest: {
      ...captured.manifest,
      cantrip: {
        scope: command.scope,
        workspace: command.workspace,
        sources: command.sources,
        label: request.label,
      },
    },
  });
  ctx.checkpoint.phase = "sealing";
  await ctx.save();
  await prepareBackupDirectory(ctx, path.dirname(destination));
  try {
    await sealPrivateBackup({
      context,
      keys: ctx.keys,
      destination,
      metadata,
      archive: ctx.ports.exportArchive({
        transport: command.transport,
        args: [...expectedArguments(command), "export", command.operationId],
      }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (
      await verifyPrivateBackup({
        context,
        keys: ctx.keys,
        source: destination,
      })
    ).metadata;
    if (!isDeepStrictEqual(existing, metadata))
      throw new OsExecutorDeliveryError(
        "A different backup occupies this admission's destination.",
      );
  }
  return completeBackup(ctx, {
    action: "capture",
    metadata,
    cleanupWarnings:
      ctx.mode === "observe"
        ? [
            "Guest transfer staging cleanup was not requested during observation.",
          ]
        : await forgetGuestStaging(ctx),
  });
}
