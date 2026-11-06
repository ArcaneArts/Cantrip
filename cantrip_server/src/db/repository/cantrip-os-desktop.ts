import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cantripOsDesktopWorkerCommandSchema,
  cantripOsDesktopOperationResultSchema,
  cantripOsDesktopSummarySchema,
  cantripOsDesktopTargetSummarySchema,
  cantripOsGuestDesktopTargetSchema,
  type CantripOsDesktopCreate,
  type CantripOsDesktopScope,
  type CantripOsGuestDesktopTarget,
  type cantripOsDesktopListQuerySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";

const instances = schema.cantripOsInstances,
  workspaces = schema.cantripOsWorkspaces;
const targets = schema.cantripOsDesktopTargets,
  operations = schema.cantripOsDesktopOperations;
const active = ["admitted", "running", "unknown"] as const;
export type DesktopOperationRow = typeof operations.$inferSelect;
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};
type Context = {
  instance: typeof instances.$inferSelect;
  workspace: typeof workspaces.$inferSelect;
};
export function desktopScope(
  context: Context,
  ownerId: string,
  serverId: string,
): CantripOsDesktopScope {
  const { instance: i, workspace: w } = context;
  if (!i.runtimeGeneration)
    return fail("The OS runtime has not been verified.");
  return {
    ownerId,
    serverId,
    workerId: i.workerId,
    instanceId: i.id,
    guestInstanceId: i.guestInstanceId,
    attachmentGeneration: i.attachmentGeneration,
    runtimeGeneration: i.runtimeGeneration,
    workspaceId: w.id,
    guestWorkspaceId: w.guestWorkspaceId,
    uid: w.uid,
    gid: w.gid,
    homeGuestPath: w.homeGuestPath,
  };
}
function assertAccount(
  w: Context["workspace"],
  target: CantripOsGuestDesktopTarget,
) {
  if (
    target.id !== w.guestWorkspaceId ||
    target.user !== `ctw-${w.guestWorkspaceId}` ||
    target.uid !== w.uid ||
    target.gid !== w.gid ||
    target.home !== w.homeGuestPath ||
    (target.status === "running" && target.desktop_generation === null)
  )
    fail("The desktop observation belongs to another workspace account.");
}
export function desktopSummary(row: DesktopOperationRow) {
  return cantripOsDesktopSummarySchema.parse({
    operationId: row.operationId,
    instanceId: row.instanceId,
    workspaceId: row.workspaceId,
    workerId: row.workerId,
    attachmentGeneration: row.attachmentGeneration,
    runtimeGeneration: row.runtimeGeneration,
    targetGeneration: row.targetGeneration,
    action: row.action,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    error:
      row.result?.error ??
      (row.state === "unknown"
        ? "Desktop delivery is unknown. Observe this original operation before continuing."
        : null),
    completionEvidence: row.result?.receipt?.completionEvidence ?? null,
  });
}

/** Desktop authority is independent of shell/source authority. No desktop result
 * changes the instance runtime, connectivity or a source binding. */
export class CantripOsDesktopRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async context(ownerId: string, instanceId: string, workspaceId: string) {
    const [row] = await this.database
      .select({ instance: instances, workspace: workspaces, target: targets })
      .from(instances)
      .innerJoin(workspaces, eq(workspaces.instanceId, instances.id))
      .leftJoin(targets, eq(targets.workspaceId, workspaces.id))
      .where(
        and(
          eq(instances.ownerId, ownerId),
          eq(instances.id, instanceId),
          eq(workspaces.id, workspaceId),
        ),
      );
    if (!row) return fail("Owned OS workspace not found.");
    const target =
      row.target?.attachmentGeneration === row.instance.attachmentGeneration &&
      row.target.runtimeGeneration === row.instance.runtimeGeneration
        ? row.target
        : null;
    return { ...row, target };
  }
  targetSummary(
    context: Awaited<ReturnType<CantripOsDesktopRepository["context"]>>,
  ) {
    return context.target
      ? cantripOsDesktopTargetSummarySchema.parse({
          generation: context.target.generation,
          instanceId: context.instance.id,
          workspaceId: context.workspace.id,
          workerId: context.instance.workerId,
          attachmentGeneration: context.target.attachmentGeneration,
          runtimeGeneration: context.target.runtimeGeneration,
          verifiedAt: context.target.verifiedAt.toISOString(),
        })
      : null;
  }
  async recordTarget(ownerId: string, expected: Context, raw: unknown) {
    const snapshot = cantripOsGuestDesktopTargetSchema.parse(raw);
    assertAccount(expected.workspace, snapshot);
    return this.database.transaction(async (tx) => {
      const [i] = await tx
        .select()
        .from(instances)
        .where(
          and(
            eq(instances.id, expected.instance.id),
            eq(instances.ownerId, ownerId),
            eq(
              instances.attachmentGeneration,
              expected.instance.attachmentGeneration,
            ),
            eq(
              instances.runtimeGeneration,
              expected.instance.runtimeGeneration!,
            ),
            eq(instances.powerEpoch, expected.instance.powerEpoch),
          ),
        )
        .for("update");
      const [w] = await tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, expected.workspace.id),
            eq(workspaces.instanceId, expected.instance.id),
            eq(workspaces.desktopEpoch, expected.workspace.desktopEpoch),
          ),
        )
        .for("update");
      if (!i || !w || !isDeepStrictEqual(w, expected.workspace))
        return fail(
          "The desktop authority changed while its observation was in flight. Observe it again.",
        );
      const [old] = await tx
        .select()
        .from(targets)
        .where(eq(targets.workspaceId, w.id));
      const generation =
        old?.attachmentGeneration === i.attachmentGeneration &&
        old.runtimeGeneration === i.runtimeGeneration &&
        isDeepStrictEqual(old.snapshot, snapshot)
          ? old.generation
          : randomUUID();
      const value = {
        workspaceId: w.id,
        generation,
        attachmentGeneration: i.attachmentGeneration,
        runtimeGeneration: i.runtimeGeneration!,
        snapshot,
        verifiedAt: new Date(),
      };
      await tx
        .insert(targets)
        .values(value)
        .onConflictDoUpdate({ target: targets.workspaceId, set: value });
      // Fence parallel observations as well as observations predating an admission.
      await tx
        .update(workspaces)
        .set({ desktopEpoch: sql`${workspaces.desktopEpoch}+1` })
        .where(eq(workspaces.id, w.id));
      return value;
    });
  }
  async get(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    operationId: string,
  ) {
    const [row] = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.workspaceId, workspaceId),
          eq(operations.operationId, operationId),
        ),
      );
    return row ?? null;
  }
  async admit(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    serverId: string,
    input: CantripOsDesktopCreate,
  ) {
    return this.database.transaction(async (tx) => {
      const [owned] = await tx
        .select({ instance: instances })
        .from(instances)
        .innerJoin(schema.workers, eq(schema.workers.id, instances.workerId))
        .where(
          and(
            eq(instances.id, instanceId),
            eq(instances.ownerId, ownerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update", { of: instances });
      if (!owned) return fail("Owned OS attachment not found.");
      const [w] = await tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.instanceId, instanceId),
          ),
        )
        .for("update");
      if (!w) return fail("Owned OS workspace not found.");
      const [old] = await tx
        .select()
        .from(operations)
        .where(eq(operations.operationId, input.operationId));
      if (old) {
        if (
          old.ownerId !== ownerId ||
          old.instanceId !== instanceId ||
          old.workspaceId !== workspaceId ||
          !isDeepStrictEqual(old.request, input)
        )
          return fail(
            "This desktop operation ID belongs to another admission.",
          );
        return { row: old, created: false };
      }
      const i = owned.instance;
      const [target] = await tx
        .select()
        .from(targets)
        .where(eq(targets.workspaceId, workspaceId));
      if (
        i.status !== "connected" ||
        !target ||
        i.attachmentGeneration !== input.attachmentGeneration ||
        i.runtimeGeneration !== input.runtimeGeneration ||
        target.attachmentGeneration !== input.attachmentGeneration ||
        target.runtimeGeneration !== input.runtimeGeneration ||
        target.generation !== input.targetGeneration
      )
        return fail(
          "The selected desktop authority changed. Verify the intended runtime and observe its desktop.",
        );
      const [power] = await tx
        .select({ id: schema.cantripOsPowerOperations.operationId })
        .from(schema.cantripOsPowerOperations)
        .innerJoin(
          schema.cantripOsPowerTargets,
          and(
            eq(
              schema.cantripOsPowerTargets.instanceId,
              schema.cantripOsPowerOperations.instanceId,
            ),
            eq(
              schema.cantripOsPowerTargets.generation,
              schema.cantripOsPowerOperations.targetGeneration,
            ),
          ),
        )
        .where(
          and(
            eq(schema.cantripOsPowerOperations.instanceId, instanceId),
            eq(
              schema.cantripOsPowerOperations.attachmentGeneration,
              i.attachmentGeneration,
            ),
            inArray(schema.cantripOsPowerOperations.state, [...active]),
          ),
        )
        .limit(1);
      if (power)
        return fail(
          "An instance power operation remains unresolved. Observe its original outcome first.",
        );
      const [pending] = await tx
        .select({ id: operations.operationId })
        .from(operations)
        .where(
          and(
            eq(operations.workspaceId, workspaceId),
            eq(operations.attachmentGeneration, input.attachmentGeneration),
            eq(operations.runtimeGeneration, input.runtimeGeneration),
            eq(operations.targetGeneration, input.targetGeneration),
            inArray(operations.state, [...active]),
          ),
        )
        .limit(1);
      if (pending)
        return fail(
          "Another operation for this desktop target remains active or uncertain. Observe it first.",
        );
      assertAccount(w, target.snapshot);
      const command = cantripOsDesktopWorkerCommandSchema.parse({
        type: "cantrip-os.desktop.operation",
        mode: "execute",
        operationId: input.operationId,
        action: input.action,
        targetGeneration: input.targetGeneration,
        scope: desktopScope({ instance: i, workspace: w }, ownerId, serverId),
        transport: i.transport,
        desktopTarget: target.snapshot,
      });
      if (command.type !== "cantrip-os.desktop.operation")
        throw new Error("Desktop operation required.");
      const [row] = await tx
        .insert(operations)
        .values({
          operationId: input.operationId,
          ownerId,
          instanceId,
          workspaceId,
          workerId: i.workerId,
          attachmentGeneration: input.attachmentGeneration,
          runtimeGeneration: input.runtimeGeneration,
          targetGeneration: input.targetGeneration,
          action: input.action,
          request: input,
          command,
        })
        .returning();
      await tx
        .update(workspaces)
        .set({ desktopEpoch: sql`${workspaces.desktopEpoch}+1` })
        .where(eq(workspaces.id, workspaceId));
      return { row: row!, created: true };
    });
  }
  async beginObservation(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    operationId: string,
  ) {
    const [row] = await this.database
      .update(operations)
      .set({ revision: sql`${operations.revision}+1` })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.workspaceId, workspaceId),
          eq(operations.operationId, operationId),
        ),
      )
      .returning();
    return row ?? fail("Desktop operation not found.");
  }
  async record(ownerId: string, original: DesktopOperationRow, raw: unknown) {
    const result = cantripOsDesktopOperationResultSchema.parse(raw);
    const before = original.command.desktopTarget;
    const matching = (target: CantripOsGuestDesktopTarget) =>
      ["id", "user", "uid", "gid", "home", "display"].every(
        (key) => Reflect.get(target, key) === Reflect.get(before, key),
      );
    if (
      result.operationId !== original.operationId ||
      result.action !== original.action ||
      (result.observation && !matching(result.observation))
    )
      return fail("The desktop outcome belongs to another admission.");
    if (result.receipt) {
      const r = result.receipt,
        after = r.after;
      const same =
        before.generation === after.generation &&
        before.desktop_generation === after.desktop_generation;
      const requested =
        original.action === "stop"
          ? after.status === "stopped" && same
          : after.status === "running" &&
            after.desktop_generation !== null &&
            (original.action === "start" && before.status === "running"
              ? same
              : after.generation > before.generation &&
                after.desktop_generation !== before.desktop_generation);
      if (
        r.targetGeneration !== original.targetGeneration ||
        !isDeepStrictEqual(r.before, before) ||
        !matching(after) ||
        !requested
      )
        return fail("The desktop receipt does not prove its original request.");
    }
    await this.database
      .update(operations)
      .set({ state: result.state, result, updatedAt: new Date() })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, original.operationId),
          sql`${operations.state} NOT IN ('ready','failed')`,
          result.state === "ready"
            ? undefined
            : eq(operations.revision, original.revision),
        ),
      );
    return (await this.get(
      ownerId,
      original.instanceId,
      original.workspaceId,
      original.operationId,
    ))!;
  }
  async unknown(ownerId: string, row: DesktopOperationRow) {
    await this.database
      .update(operations)
      .set({ state: "unknown", updatedAt: new Date() })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, row.operationId),
          eq(operations.revision, row.revision),
          sql`${operations.state} NOT IN ('ready','failed')`,
        ),
      );
    return (await this.get(
      ownerId,
      row.instanceId,
      row.workspaceId,
      row.operationId,
    ))!;
  }
  async list(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    query: ReturnType<typeof cantripOsDesktopListQuerySchema.parse>,
  ) {
    const cursor = query.cursor
      ? await this.get(ownerId, instanceId, workspaceId, query.cursor)
      : null;
    if (query.cursor && !cursor)
      return fail("Desktop history cursor not found.");
    const rows = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.workspaceId, workspaceId),
          cursor
            ? sql`(${operations.createdAt},${operations.operationId}) < (SELECT created_at,operation_id FROM cantrip_os_desktop_operations WHERE operation_id=${cursor.operationId})`
            : undefined,
        ),
      )
      .orderBy(desc(operations.createdAt), desc(operations.operationId))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(desktopSummary),
      nextCursor: rows.length > query.limit ? items.at(-1)!.operationId : null,
    };
  }
}
