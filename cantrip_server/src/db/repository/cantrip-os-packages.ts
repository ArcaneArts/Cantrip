import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  cantripOsPackageCatalogResultSchema,
  cantripOsPackageOperationCommandSchema,
  cantripOsPackageOperationResultSchema,
  cantripOsPackageStatusSchema,
  cantripOsPackageSummarySchema,
  type CantripOsPackageCreate,
  type CantripOsPackageControl,
  type cantripOsPackageListQuerySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";

const instances = schema.cantripOsInstances;
const targets = schema.cantripOsPackageTargets;
const operations = schema.cantripOsPackageOperations;
type Tx = Parameters<Parameters<RepositoryDatabase["transaction"]>[0]>[0];
type Instance = typeof instances.$inferSelect;
export type PackageOperationRow = typeof operations.$inferSelect;
type Target = typeof targets.$inferSelect;
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};
export const packageScope = (instance: Instance, serverId: string) => ({
  ownerId: instance.ownerId,
  serverId,
  workerId: instance.workerId,
  instanceId: instance.id,
  guestInstanceId: instance.guestInstanceId,
  attachmentGeneration: instance.attachmentGeneration,
});
export function packageSummary(row: PackageOperationRow) {
  return cantripOsPackageSummarySchema.parse({
    operationId: row.operationId,
    instanceId: row.instanceId,
    workerId: row.workerId,
    attachmentGeneration: row.attachmentGeneration,
    targetGeneration: row.targetGeneration,
    action: row.request.action,
    configuration: row.request.configuration,
    packages: row.request.packages,
    state: row.state,
    phase: row.result?.phase ?? "admitted",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    protectedResult: row.result?.protectedResult ?? null,
    error:
      row.result?.error ??
      (row.state === "unknown"
        ? "Package delivery is unknown. Observe the original operation; no installation was repeated."
        : null),
  });
}
export function packageStatus(instance: Instance, target: Target) {
  const catalog = target.catalog!;
  return cantripOsPackageStatusSchema.parse({
    target: {
      generation: catalog.target.generation,
      instanceId: instance.id,
      workerId: instance.workerId,
      attachmentGeneration: target.attachmentGeneration,
      architecture: catalog.target.architecture,
      verifiedAt: target.verifiedAt!.toISOString(),
    },
    installed: catalog.installed,
    available: catalog.available,
    unavailable: catalog.unavailable,
    error: null,
  });
}

/** The existing observation epoch fences old runtime replies at admission and
 * completion. Actual dpkg/recovery locks, not a guessed helper-health gate,
 * govern installation and an explicit new repair after an uncertain outcome. */
export class CantripOsPackageRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  private async owned(tx: Tx, ownerId: string, instanceId: string) {
    const [row] = await tx
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
    return row?.instance ?? fail("Owned OS attachment not found.");
  }
  async context(ownerId: string, instanceId: string) {
    const [row] = await this.database
      .select({ instance: instances, target: targets })
      .from(instances)
      .leftJoin(targets, eq(targets.instanceId, instances.id))
      .where(and(eq(instances.id, instanceId), eq(instances.ownerId, ownerId)));
    return row ?? fail("OS attachment not found.");
  }
  async beginStatus(ownerId: string, instanceId: string) {
    return this.database.transaction(async (tx) => {
      const instance = await this.owned(tx, ownerId, instanceId);
      const [old] = await tx
        .select()
        .from(targets)
        .where(eq(targets.instanceId, instanceId));
      const same = old?.attachmentGeneration === instance.attachmentGeneration;
      const value = {
        instanceId,
        attachmentGeneration: instance.attachmentGeneration,
        observationEpoch: (old?.observationEpoch ?? 0) + 1,
        catalogPowerEpoch: same ? old.catalogPowerEpoch : null,
        catalog: same ? old.catalog : null,
        verifiedAt: same ? old.verifiedAt : null,
      };
      const [target] = await tx
        .insert(targets)
        .values(value)
        .onConflictDoUpdate({ target: targets.instanceId, set: value })
        .returning();
      return { instance, target: target! };
    });
  }
  async recordTarget(
    ownerId: string,
    original: Awaited<ReturnType<CantripOsPackageRepository["beginStatus"]>>,
    raw: unknown,
  ) {
    const catalog = cantripOsPackageCatalogResultSchema.parse(raw);
    const expected = catalog.target.expected;
    if (
      expected.ownerId !== ownerId ||
      expected.workerId !== original.instance.workerId ||
      expected.guestInstanceId !== original.instance.guestInstanceId
    )
      return fail("The package observation belongs to another OS attachment.");
    return this.database.transaction(async (tx) => {
      const instance = await this.owned(tx, ownerId, original.instance.id);
      const [target] = await tx
        .select()
        .from(targets)
        .where(eq(targets.instanceId, instance.id));
      if (
        instance.attachmentGeneration !==
          original.instance.attachmentGeneration ||
        instance.workerId !== original.instance.workerId ||
        instance.guestInstanceId !== original.instance.guestInstanceId ||
        instance.powerEpoch !== original.instance.powerEpoch ||
        !target ||
        target.attachmentGeneration !== instance.attachmentGeneration ||
        target.observationEpoch !== original.target.observationEpoch
      )
        return fail(
          "The package observation changed before its target was recorded.",
        );
      const { generation: _actualGeneration, ...actualIdentity } =
        catalog.target;
      const { generation: oldGeneration, ...oldIdentity } =
        target.catalog?.target ?? {};
      const generation =
        target.catalogPowerEpoch === instance.powerEpoch &&
        isDeepStrictEqual(actualIdentity, oldIdentity)
          ? oldGeneration!
          : randomUUID();
      catalog.target = { ...catalog.target, generation };
      const [saved] = await tx
        .update(targets)
        .set({
          catalog,
          catalogPowerEpoch: instance.powerEpoch,
          verifiedAt: new Date(),
        })
        .where(eq(targets.instanceId, instance.id))
        .returning();
      return saved!;
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
    input: CantripOsPackageCreate,
  ) {
    return this.database.transaction(async (tx) => {
      const instance = await this.owned(tx, ownerId, instanceId);
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
          return fail(
            "This package operation ID belongs to another admission.",
          );
        return { row: old, created: false };
      }
      const [target] = await tx
        .select()
        .from(targets)
        .where(eq(targets.instanceId, instanceId));
      const catalog = target?.catalog;
      if (
        !catalog ||
        instance.attachmentGeneration !== input.attachmentGeneration ||
        target.attachmentGeneration !== input.attachmentGeneration ||
        target.catalogPowerEpoch !== instance.powerEpoch ||
        catalog.target.generation !== input.targetGeneration
      )
        return fail(
          "The selected package target changed. Observe actual package status before admitting another operation.",
        );
      if (
        input.packages.some(
          (artifact) =>
            !catalog.available.some((candidate) =>
              isDeepStrictEqual(candidate, artifact),
            ),
        )
      )
        return fail(
          "A selected package artifact is not in this verified catalogue.",
        );
      const command = cantripOsPackageOperationCommandSchema.parse({
        type: "cantrip-os.packages.operation",
        mode: "execute",
        operationId: input.operationId,
        scope: packageScope(instance, serverId),
        transport: instance.transport,
        target: catalog.target,
        action: input.action,
        configuration: input.configuration,
        packages: input.packages,
      });
      const [row] = await tx
        .insert(operations)
        .values({
          operationId: input.operationId,
          ownerId,
          instanceId,
          workerId: instance.workerId,
          attachmentGeneration: input.attachmentGeneration,
          targetGeneration: input.targetGeneration,
          admissionEpoch: instance.powerEpoch + 1,
          request: input,
          command,
        })
        .returning();
      await tx
        .update(instances)
        .set({
          runtimeGeneration: null,
          status: "unknown",
          lastError: null,
          powerEpoch: sql`${instances.powerEpoch}+1`,
          updatedAt: new Date(),
        })
        .where(eq(instances.id, instanceId));
      return { row: row!, created: true };
    });
  }
  async beginObservation(
    ownerId: string,
    instanceId: string,
    operationId: string,
    control?: CantripOsPackageControl,
  ) {
    return this.database.transaction(async (tx) => {
      if (control) {
        const instance = await this.owned(tx, ownerId, instanceId);
        if (instance.attachmentGeneration !== control.attachmentGeneration)
          return fail(
            "The original package attachment changed; no continuation was dispatched.",
          );
      }
      const [row] = await tx
        .update(operations)
        .set({ revision: sql`${operations.revision}+1` })
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.instanceId, instanceId),
            eq(operations.operationId, operationId),
            control
              ? eq(
                  operations.attachmentGeneration,
                  control.attachmentGeneration,
                )
              : undefined,
            control
              ? eq(operations.targetGeneration, control.targetGeneration)
              : undefined,
          ),
        )
        .returning();
      return (
        row ?? fail("Package operation not found for the original target.")
      );
    });
  }
  async record(ownerId: string, original: PackageOperationRow, raw: unknown) {
    const result = cantripOsPackageOperationResultSchema.parse(raw);
    const terminal = result.state === "ready" || result.state === "failed";
    if (
      result.operationId !== original.operationId ||
      result.targetGeneration !== original.targetGeneration ||
      result.action !== original.request.action ||
      result.configuration !== original.request.configuration ||
      (terminal && !result.protectedResult)
    )
      throw new Error("Package outcome differs from its immutable admission.");
    return this.database.transaction(async (tx) => {
      // Lock the instance first, like admission, to avoid reversing lock order.
      await tx
        .select({ id: instances.id })
        .from(instances)
        .where(
          and(
            eq(instances.id, original.instanceId),
            eq(instances.ownerId, ownerId),
          ),
        )
        .for("update");
      const [saved] = await tx
        .update(operations)
        .set({ state: result.state, result, updatedAt: new Date() })
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, original.operationId),
            sql`${operations.state} NOT IN ('ready','failed')`,
            terminal ? undefined : eq(operations.revision, original.revision),
          ),
        )
        .returning();
      if (saved && terminal)
        await tx
          .update(instances)
          .set({
            runtimeGeneration: null,
            status: "unknown",
            lastError: null,
            powerEpoch: sql`${instances.powerEpoch}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(instances.id, original.instanceId),
              eq(instances.ownerId, ownerId),
              eq(instances.attachmentGeneration, original.attachmentGeneration),
              eq(instances.powerEpoch, original.admissionEpoch),
            ),
          );
      return (
        await tx
          .select()
          .from(operations)
          .where(eq(operations.operationId, original.operationId))
      )[0]!;
    });
  }
  async unknown(ownerId: string, original: PackageOperationRow) {
    await this.database
      .update(operations)
      .set({ state: "unknown", updatedAt: new Date() })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, original.operationId),
          eq(operations.revision, original.revision),
          sql`${operations.state} NOT IN ('ready','failed')`,
        ),
      );
    return (await this.get(
      ownerId,
      original.instanceId,
      original.operationId,
    ))!;
  }
  async list(
    ownerId: string,
    instanceId: string,
    query: ReturnType<typeof cantripOsPackageListQuerySchema.parse>,
  ) {
    await this.context(ownerId, instanceId);
    const cursor = query.cursor
      ? await this.get(ownerId, instanceId, query.cursor)
      : null;
    if (query.cursor && !cursor)
      return fail("Package history cursor not found.");
    const rows = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          cursor
            ? sql`(${operations.createdAt},${operations.operationId}) < (${cursor.createdAt.toISOString()}::timestamptz,${cursor.operationId})`
            : undefined,
        ),
      )
      .orderBy(desc(operations.createdAt), desc(operations.operationId))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(packageSummary),
      nextCursor: rows.length > query.limit ? items.at(-1)!.operationId : null,
    };
  }
}
