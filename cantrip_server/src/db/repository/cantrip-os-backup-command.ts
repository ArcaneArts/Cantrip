import { eq, and, isNull } from "drizzle-orm";
import {
  cantripOsBackupWorkerCommandSchema,
  type CantripOsBackupAdmission,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";

/** Resolve accounts, source roots and transport inside the admission transaction.
 * Caller-supplied IDs and opaque intent never become arbitrary guest paths. */
export async function backupCommand(
  tx: RepositoryTransaction,
  ownerId: string,
  instanceId: string,
  serverId: string,
  input: CantripOsBackupAdmission,
) {
  const [target] = await tx
    .select({
      instance: schema.cantripOsInstances,
      workspace: schema.cantripOsWorkspaces,
    })
    .from(schema.cantripOsInstances)
    .innerJoin(
      schema.cantripOsWorkspaces,
      eq(schema.cantripOsWorkspaces.instanceId, schema.cantripOsInstances.id),
    )
    .innerJoin(
      schema.workers,
      and(
        eq(schema.workers.id, schema.cantripOsInstances.workerId),
        eq(schema.workers.ownerId, ownerId),
        isNull(schema.workers.unlinkedAt),
      ),
    )
    .where(
      and(
        eq(schema.cantripOsInstances.id, instanceId),
        eq(schema.cantripOsInstances.ownerId, ownerId),
        eq(schema.cantripOsWorkspaces.id, input.workspaceId),
      ),
    )
    .for("update");
  if (
    !target ||
    target.instance.attachmentGeneration !== input.attachmentGeneration ||
    target.instance.runtimeGeneration !== input.runtimeGeneration
  )
    throw new CantripOsPlacementError(
      "The selected OS workspace or runtime changed before backup admission.",
    );
  const { instance: i, workspace: w } = target;
  const scope = {
    ownerId,
    serverId,
    workerId: i.workerId,
    instanceId: i.id,
    guestInstanceId: i.guestInstanceId,
    attachmentGeneration: i.attachmentGeneration,
    runtimeGeneration: i.runtimeGeneration,
  };
  const base = {
    operationId: input.operationId,
    scope,
    transport: i.transport,
    protectedRequest: input.protectedRequest,
    workspace: {
      id: w.id,
      guestWorkspaceId: w.guestWorkspaceId,
      uid: w.uid,
      gid: w.gid,
      homeGuestPath: w.homeGuestPath,
    },
  };
  if (input.action === "capture") {
    const rows = await tx
      .select({
        binding: schema.cantripOsSourceBindings,
        common: schema.cantripOsProjectSources.gitCommonGuestPath,
      })
      .from(schema.cantripOsSourceBindings)
      .leftJoin(
        schema.cantripOsProjectSources,
        eq(
          schema.cantripOsProjectSources.id,
          schema.cantripOsSourceBindings.projectSourceId,
        ),
      )
      .where(
        and(
          eq(schema.cantripOsSourceBindings.ownerId, ownerId),
          eq(schema.cantripOsSourceBindings.workspaceId, w.id),
          isNull(schema.cantripOsSourceBindings.retiredAt),
        ),
      )
      .orderBy(schema.cantripOsSourceBindings.id);
    return cantripOsBackupWorkerCommandSchema.parse({
      ...base,
      type: "cantrip-os.backup.capture",
      sources: rows.map(({ binding: b, common }) => ({
        bindingId: b.id,
        projectId: b.projectId,
        projectSourceId: b.projectSourceId,
        worktreeId: b.worktreeId,
        mode: b.mode,
        guestPath: b.guestPath,
        gitCommonGuestPath: b.mode === "linux-owned" ? common : null,
      })),
    });
  }
  const referenceId =
    input.action === "restore" ? input.backupId : input.restoreOperationId;
  const [reference] = await tx
    .select()
    .from(schema.cantripOsBackupOperations)
    .where(
      and(
        eq(schema.cantripOsBackupOperations.operationId, referenceId),
        eq(schema.cantripOsBackupOperations.ownerId, ownerId),
      ),
    );
  if (
    !reference ||
    reference.workerId !== i.workerId ||
    reference.action !== (input.action === "restore" ? "capture" : "restore")
  )
    throw new CantripOsPlacementError(
      "The referenced backup operation belongs to another target or storage Worker.",
    );
  if (input.action === "restore")
    return cantripOsBackupWorkerCommandSchema.parse({
      ...base,
      type: "cantrip-os.backup.restore",
      backupId: input.backupId,
      backupScope: reference.command.scope,
      replace: input.replace,
    });
  if (reference.instanceId !== i.id || reference.workspaceId !== w.id)
    throw new CantripOsPlacementError(
      "Rollback must target the original restore workspace.",
    );
  return cantripOsBackupWorkerCommandSchema.parse({
    ...base,
    type: "cantrip-os.backup.rollback",
    restoreOperationId: input.restoreOperationId,
  });
}
