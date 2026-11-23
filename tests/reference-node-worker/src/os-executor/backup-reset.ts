import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cantripOsResetPathsSchema } from "@cantrip/protocol/cantrip-os-backup-operations";
import {
  completeBackup,
  expectedArguments,
  guestRecord,
  privateBackupRequest,
  releaseGuestMaintenance,
  type BackupContext,
} from "./backup-context.js";

const receiptSchema = z
  .object({
    workspace: z
      .object({
        id: z.string(),
        uid: z.number().int().positive(),
        gid: z.number().int().positive(),
        home: z.string(),
      })
      .strict(),
    reset_paths: cantripOsResetPathsSchema,
    retained_original_home: z.string().startsWith("/"),
    shared_system_state_changed: z.literal(false),
    runtime_handles_restored: z.literal(false),
  })
  .passthrough();

/** The only reset dispatch is the first admitted attempt. Recovery observes the
 * exact guest journal and releases interrupted maintenance; it never resets again. */
export async function resetWorkspace(ctx: BackupContext) {
  const command = ctx.command;
  if (command.type !== "cantrip-os.backup.reset")
    throw new Error("Not a workspace reset.");
  const intent = await privateBackupRequest(ctx);
  if (intent.action !== "reset")
    throw new Error("Not a private reset request.");
  let guest;
  if (ctx.mode === "new") {
    await ctx.assertCurrent();
    ctx.checkpoint.phase = "resetting";
    await ctx.save();
    guest = await ctx.ports.control({
      transport: command.transport,
      args: [
        ...expectedArguments(command, true, ctx.mutationScope),
        "reset",
        command.operationId,
        command.workspace.guestWorkspaceId,
        "--request",
        JSON.stringify({ paths: intent.paths }),
      ],
    });
  } else {
    guest = await releaseGuestMaintenance(ctx, await guestRecord(ctx));
  }
  if (guest.operation_id !== command.operationId || guest.action !== "reset")
    throw new Error("Misrouted guest reset receipt.");
  if (
    guest.state === "reset" &&
    guest.receipt &&
    guest.maintenance?.released === true
  ) {
    const receipt = receiptSchema.parse(guest.receipt);
    if (
      !isDeepStrictEqual(receipt.workspace, {
        id: command.workspace.guestWorkspaceId,
        uid: command.workspace.uid,
        gid: command.workspace.gid,
        home: command.workspace.homeGuestPath,
      }) ||
      !isDeepStrictEqual(receipt.reset_paths, intent.paths)
    )
      throw new Error(
        "The reset receipt differs from its admitted paths or workspace account.",
      );
    return completeBackup(ctx, {
      action: "reset",
      receipt,
      interruption: guest.maintenance,
      cleanupWarnings: [],
    });
  }
  if (
    guest.state === "failed" &&
    (!guest.maintenance || guest.maintenance.released)
  ) {
    ctx.record.state = "failed";
    ctx.record.error =
      guest.error ??
      "The guest reset failed; its retained original was preserved.";
  } else if (guest.active) ctx.record.state = "running";
  else ctx.checkpoint.phase = "recovery-required";
  return null;
}
