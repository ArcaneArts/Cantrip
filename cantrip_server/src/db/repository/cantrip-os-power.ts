import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cantripOsPowerWorkerCommandSchema,
  cantripOsPowerOperationResultSchema,
  cantripOsPowerSummarySchema,
  cantripOsPowerTargetSummarySchema,
  type CantripOsPowerCreate,
  type CantripOsPowerObservation,
  type cantripOsPowerListQuerySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";

const targets = schema.cantripOsPowerTargets,
  operations = schema.cantripOsPowerOperations;
export type PowerOperationRow = typeof operations.$inferSelect;
const active = ["admitted", "running", "unknown"] as const;
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};

export function powerSummary(row: PowerOperationRow) {
  const result = row.result;
  const { containerId: _id, ...powerState } = result?.observation ?? {};
  return cantripOsPowerSummarySchema.parse({
    operationId: row.operationId,
    instanceId: row.instanceId,
    workerId: row.workerId,
    attachmentGeneration: row.attachmentGeneration,
    targetGeneration: row.targetGeneration,
    action: row.action,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    error:
      result?.error ??
      (row.state === "unknown"
        ? "Power delivery is unknown. Observe this original operation before continuing."
        : null),
    completionEvidence: result?.receipt?.completionEvidence ?? null,
    powerState: result?.observation ? powerState : null,
  });
}

export class CantripOsPowerRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async context(ownerId: string, instanceId: string) {
    const [row] = await this.database
      .select({ instance: schema.cantripOsInstances, target: targets })
      .from(schema.cantripOsInstances)
      .leftJoin(targets, eq(targets.instanceId, schema.cantripOsInstances.id))
      .where(
        and(
          eq(schema.cantripOsInstances.id, instanceId),
          eq(schema.cantripOsInstances.ownerId, ownerId),
        ),
      );
    if (!row) return fail("OS attachment not found.");
    const target =
      row.instance.transport.kind === "docker" &&
      row.target?.attachmentGeneration === row.instance.attachmentGeneration
        ? row.target
        : null;
    return { ...row, target };
  }
  targetSummary(
    context: Awaited<ReturnType<CantripOsPowerRepository["context"]>>,
  ) {
    return context.target
      ? cantripOsPowerTargetSummarySchema.parse({
          kind: "docker",
          generation: context.target.generation,
          instanceId: context.instance.id,
          workerId: context.instance.workerId,
          attachmentGeneration: context.target.attachmentGeneration,
          verifiedAt: context.target.verifiedAt.toISOString(),
        })
      : null;
  }
  async recordTarget(
    ownerId: string,
    instanceId: string,
    attachmentGeneration: string,
    runtimeGeneration: string,
    containerId: string,
    expectedPowerEpoch: number,
  ) {
    return this.database.transaction(async (tx) => {
      const [instance] = await tx
        .select()
        .from(schema.cantripOsInstances)
        .where(
          and(
            eq(schema.cantripOsInstances.id, instanceId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
            eq(
              schema.cantripOsInstances.attachmentGeneration,
              attachmentGeneration,
            ),
            eq(schema.cantripOsInstances.runtimeGeneration, runtimeGeneration),
            eq(schema.cantripOsInstances.powerEpoch, expectedPowerEpoch),
          ),
        )
        .for("update");
      if (!instance || instance.transport.kind !== "docker")
        return fail(
          "The verified Docker attachment changed before its power target was recorded.",
        );
      const [old] = await tx
        .select()
        .from(targets)
        .where(eq(targets.instanceId, instanceId));
      const generation =
        old?.attachmentGeneration === attachmentGeneration &&
        old.containerId === containerId
          ? old.generation
          : randomUUID();
      const value = {
        instanceId,
        generation,
        attachmentGeneration,
        runtimeGeneration,
        containerId,
        verifiedAt: new Date(),
      };
      await tx
        .insert(targets)
        .values(value)
        .onConflictDoUpdate({ target: targets.instanceId, set: value });
      const [pending] = await tx
        .select({ id: operations.operationId })
        .from(operations)
        .where(
          and(
            eq(operations.instanceId, instanceId),
            eq(operations.attachmentGeneration, attachmentGeneration),
            eq(operations.targetGeneration, generation),
            inArray(operations.state, [...active]),
          ),
        )
        .limit(1);
      // This method is called only with a successful, owned guest observation.
      // Concurrent power admission keeps execution fenced until it settles.
      await tx
        .update(schema.cantripOsInstances)
        .set({ status: pending ? "unknown" : "connected", lastError: null })
        .where(eq(schema.cantripOsInstances.id, instanceId));
      return value;
    });
  }
  async get(ownerId: string, instanceId: string, operationId: string) {
    const [row] = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.operationId, operationId),
        ),
      );
    return row ?? null;
  }
  async admit(
    ownerId: string,
    instanceId: string,
    serverId: string,
    input: CantripOsPowerCreate,
  ) {
    return this.database.transaction(async (tx) => {
      const [owned] = await tx
        .select({ instance: schema.cantripOsInstances })
        .from(schema.cantripOsInstances)
        .innerJoin(
          schema.workers,
          eq(schema.workers.id, schema.cantripOsInstances.workerId),
        )
        .where(
          and(
            eq(schema.cantripOsInstances.id, instanceId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update", { of: schema.cantripOsInstances });
      if (!owned) return fail("Owned OS attachment not found.");
      const [old] = await tx
        .select()
        .from(operations)
        .where(eq(operations.operationId, input.operationId));
      if (old) {
        if (
          old.ownerId !== ownerId ||
          old.instanceId !== instanceId ||
          !isDeepStrictEqual(old.request, input)
        )
          return fail("This power operation ID belongs to another admission.");
        return { row: old, created: false };
      }
      const instance = owned.instance;
      const [target] = await tx
        .select()
        .from(targets)
        .where(eq(targets.instanceId, instanceId));
      if (
        instance.transport.kind !== "docker" ||
        !target ||
        instance.attachmentGeneration !== input.attachmentGeneration ||
        target.attachmentGeneration !== input.attachmentGeneration ||
        target.generation !== input.targetGeneration
      )
        return fail(
          "The selected retained power target changed. Observe this instance before creating another operation.",
        );
      const [pending] = await tx
        .select({ id: operations.operationId })
        .from(operations)
        .where(
          and(
            eq(operations.instanceId, instanceId),
            eq(operations.attachmentGeneration, input.attachmentGeneration),
            eq(operations.targetGeneration, input.targetGeneration),
            inArray(operations.state, [...active]),
          ),
        )
        .limit(1);
      if (pending)
        return fail(
          "Another power operation remains active or uncertain. Observe its outcome first.",
        );
      const command = cantripOsPowerWorkerCommandSchema.parse({
        type: "cantrip-os.power.operation",
        mode: "execute",
        operationId: input.operationId,
        action: input.action,
        scope: {
          ownerId,
          serverId,
          workerId: instance.workerId,
          instanceId,
          guestInstanceId: instance.guestInstanceId,
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: target.runtimeGeneration,
        },
        transport: instance.transport,
        powerTarget: {
          kind: "docker",
          generation: target.generation,
          containerId: target.containerId,
        },
      });
      if (command.type !== "cantrip-os.power.operation")
        throw new Error("Power admission has no operation.");
      const [row] = await tx
        .insert(operations)
        .values({
          operationId: input.operationId,
          ownerId,
          instanceId,
          workerId: instance.workerId,
          attachmentGeneration: input.attachmentGeneration,
          targetGeneration: input.targetGeneration,
          action: input.action,
          request: input,
          command,
        })
        .returning();
      await tx
        .update(schema.cantripOsInstances)
        .set({
          status: "unknown",
          powerEpoch: sql`${schema.cantripOsInstances.powerEpoch}+1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.cantripOsInstances.id, instanceId));
      return { row: row!, created: true };
    });
  }
  async beginObservation(
    ownerId: string,
    instanceId: string,
    operationId: string,
  ) {
    const [row] = await this.database
      .update(operations)
      .set({ revision: sql`${operations.revision}+1` })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.operationId, operationId),
        ),
      )
      .returning();
    return row ?? fail("Power operation not found.");
  }
  async record(ownerId: string, original: PowerOperationRow, raw: unknown) {
    const result = cantripOsPowerOperationResultSchema.parse(raw);
    const expected = original.command.powerTarget;
    const matching = (value: CantripOsPowerObservation | null) =>
      !value || value.containerId === expected.containerId;
    if (
      result.operationId !== original.operationId ||
      result.action !== original.action ||
      !matching(result.observation) ||
      (result.receipt &&
        (result.receipt.targetGeneration !== expected.generation ||
          result.receipt.containerId !== expected.containerId ||
          !matching(result.receipt.before) ||
          !matching(result.receipt.after) ||
          (original.action === "stop"
            ? result.receipt.after.running
            : !result.receipt.after.running) ||
          (original.action === "restart" &&
            result.receipt.before.startedAt ===
              result.receipt.after.startedAt)))
    )
      throw new Error(
        "Power response differs from its immutable target or action.",
      );
    return this.database.transaction(async (tx) => {
      const [saved] = await tx
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
        )
        .returning();
      if (saved) {
        await tx
          .update(schema.cantripOsInstances)
          .set({
            status:
              result.observation?.running === false
                ? "disconnected"
                : "unknown",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.cantripOsInstances.id, original.instanceId),
              eq(
                schema.cantripOsInstances.attachmentGeneration,
                original.attachmentGeneration,
              ),
              sql`EXISTS (SELECT 1 FROM cantrip_os_power_targets t WHERE t.instance_id=${original.instanceId} AND t.generation=${original.targetGeneration})`,
            ),
          );
      }
      const [current] = await tx
        .select()
        .from(operations)
        .where(eq(operations.operationId, original.operationId));
      return current!;
    });
  }
  async unknown(ownerId: string, row: PowerOperationRow) {
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
    return (await this.get(ownerId, row.instanceId, row.operationId))!;
  }
  async list(
    ownerId: string,
    instanceId: string,
    query: ReturnType<typeof cantripOsPowerListQuerySchema.parse>,
  ) {
    const cursor = query.cursor
      ? await this.get(ownerId, instanceId, query.cursor)
      : null;
    if (query.cursor && !cursor) return fail("Power history cursor not found.");
    const rows = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          cursor
            ? sql`(${operations.createdAt},${operations.operationId}) < (SELECT created_at,operation_id FROM cantrip_os_power_operations WHERE owner_id=${ownerId} AND instance_id=${instanceId} AND operation_id=${cursor.operationId})`
            : undefined,
        ),
      )
      .orderBy(desc(operations.createdAt), desc(operations.operationId))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(powerSummary),
      nextCursor: rows.length > query.limit ? items.at(-1)!.operationId : null,
    };
  }
}
