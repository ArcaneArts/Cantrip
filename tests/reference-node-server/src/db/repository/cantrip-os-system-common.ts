import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  cantripOsSystemSummarySchema,
  cantripOsSystemStatusSchema,
  cantripOsInstanceSummarySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";
export type SystemTx = Parameters<
  Parameters<RepositoryDatabase["transaction"]>[0]
>[0];
export type SystemInstance = typeof schema.cantripOsInstances.$inferSelect;
export type SystemOperationRow =
  typeof schema.cantripOsSystemOperations.$inferSelect;
export type SystemTargetRow = typeof schema.cantripOsSystemTargets.$inferSelect;
export function systemFail(message: string): never {
  throw new CantripOsPlacementError(message);
}
export const systemScope = (i: SystemInstance, serverId: string) => ({
  ownerId: i.ownerId,
  serverId,
  workerId: i.workerId,
  instanceId: i.id,
  guestInstanceId: i.guestInstanceId,
  attachmentGeneration: i.attachmentGeneration,
});
export function systemInstanceSummary(row: SystemInstance) {
  const {
    workerProcessGeneration: _process,
    powerEpoch: _epoch,
    ...fields
  } = row;
  return cantripOsInstanceSummarySchema.parse({
    ...fields,
    lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function ownedSystemInstance(
  tx: SystemTx,
  ownerId: string,
  instanceId: string,
) {
  const i = schema.cantripOsInstances,
    w = schema.workers;
  const [row] = await tx
    .select({ instance: i })
    .from(i)
    .innerJoin(w, eq(w.id, i.workerId))
    .where(
      and(
        eq(i.id, instanceId),
        eq(i.ownerId, ownerId),
        eq(w.ownerId, ownerId),
        isNull(w.unlinkedAt),
      ),
    )
    .for("update", { of: i });
  return row?.instance ?? systemFail("Owned OS attachment not found.");
}
/** This checks actual durable admissions, not inferred helper health. */
export async function hasActiveSystem(
  tx: SystemTx,
  instanceId: string,
  except?: string,
) {
  const o = schema.cantripOsSystemOperations;
  const [row] = await tx
    .select({ id: o.operationId })
    .from(o)
    .where(
      and(
        eq(o.instanceId, instanceId),
        isNull(o.retiredBy),
        inArray(o.state, ["admitted", "running", "unknown"]),
        except ? ne(o.operationId, except) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}
export async function assertNoActiveSystem(
  tx: SystemTx,
  instanceId: string,
  except?: string,
) {
  if (await hasActiveSystem(tx, instanceId, except))
    systemFail(
      "Another system operation remains active or uncertain. Observe its original admission first.",
    );
}
export function systemSummary(row: SystemOperationRow) {
  const c = row.command;
  return cantripOsSystemSummarySchema.parse({
    operationId: row.operationId,
    instanceId: row.instanceId,
    workerId: row.workerId,
    attachmentGeneration: row.fenceGeneration,
    targetGeneration: row.targetGeneration,
    request: row.request,
    context: {
      ...c.scope,
      operationId: c.operationId,
      targetGeneration: c.target.generation,
      containerId: c.target.containerId,
    },
    state: row.state,
    dispatchStage: row.dispatchStage,
    phase:
      row.state === "rejected"
        ? "not-dispatched"
        : (row.result?.phase ?? "admitted"),
    retiredBy: row.retiredBy,
    recoveryGeneration: row.recoveryGeneration,
    root: row.result?.root ?? null,
    protectedResult: row.result?.protectedResult ?? null,
    error:
      row.result?.error ??
      (row.state === "rejected"
        ? "The system transition was not dispatched. Refresh system status before submitting a new operation."
        : row.state === "unknown"
          ? "System delivery is unknown. Observe the original operation; no claimed effect was repeated."
          : null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export function systemStatus(instance: SystemInstance, row: SystemTargetRow) {
  const c = row.catalog;
  return cantripOsSystemStatusSchema.parse({
    supported: c?.supported ?? instance.transport.kind === "docker",
    target:
      c?.target && row.verifiedAt
        ? {
            generation: c.target.generation,
            instanceId: instance.id,
            workerId: instance.workerId,
            attachmentGeneration: instance.attachmentGeneration,
            architecture: c.target.architecture,
            running: c.running,
            verifiedAt: row.verifiedAt.toISOString(),
          }
        : null,
    bases: c?.bases ?? [],
    error: c?.error ?? null,
  });
}
