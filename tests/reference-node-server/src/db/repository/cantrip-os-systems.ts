import { and, desc, eq, sql } from "drizzle-orm";
import {
  cantripOsSystemOperationResultSchema,
  cantripOsSystemPageSchema,
  type CantripOsSystemControl,
  type CantripOsSystemCreate,
  cantripOsSystemListQuerySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { admitSystemOperation } from "./cantrip-os-system-admission.js";
import {
  beginSystemStatus,
  recordSystemTarget,
  beginSystemRecovery,
  adoptSystemTarget,
} from "./cantrip-os-system-targets.js";
import {
  ownedSystemInstance,
  systemFail,
  systemSummary,
  type SystemOperationRow,
} from "./cantrip-os-system-common.js";
const operations = schema.cantripOsSystemOperations,
  instances = schema.cantripOsInstances;
export class CantripOsSystemRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  beginStatus = (owner: string, instance: string) =>
    beginSystemStatus(this.database, owner, instance);
  recordTarget = (
    owner: string,
    original: Awaited<ReturnType<typeof beginSystemStatus>>,
    raw: unknown,
  ) => recordSystemTarget(this.database, owner, original, raw);
  admit = (
    owner: string,
    instance: string,
    server: string,
    input: CantripOsSystemCreate,
  ) => admitSystemOperation(this.database, owner, instance, server, input);
  beginRecovery = (
    owner: string,
    instance: string,
    operation: string,
    input: CantripOsSystemControl,
  ) => beginSystemRecovery(this.database, owner, instance, operation, input);
  adopt = (
    owner: string,
    original: Awaited<ReturnType<typeof beginSystemRecovery>>,
    raw: unknown,
  ) => adoptSystemTarget(this.database, owner, original, raw);
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
  async beginObservation(
    ownerId: string,
    instanceId: string,
    operationId: string,
    control?: CantripOsSystemControl,
  ) {
    return this.database.transaction(async (tx) => {
      if (control) {
        const instance = await ownedSystemInstance(tx, ownerId, instanceId);
        const [original] = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.ownerId, ownerId),
              eq(operations.instanceId, instanceId),
              eq(operations.operationId, operationId),
            ),
          );
        if (
          !original ||
          original.retiredBy ||
          original.workerId !== instance.workerId ||
          original.fenceGeneration !== control.attachmentGeneration ||
          original.targetGeneration !== control.targetGeneration ||
          instance.attachmentGeneration !== control.attachmentGeneration
        )
          systemFail(
            "The original system attachment changed or was retired; no continuation was dispatched.",
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
          ),
        )
        .returning();
      return row ?? systemFail("System operation not found.");
    });
  }
  async record(ownerId: string, original: SystemOperationRow, raw: unknown) {
    const result = cantripOsSystemOperationResultSchema.parse(raw),
      terminal = result.state === "ready" || result.state === "failed";
    if (
      result.operationId !== original.operationId ||
      result.targetGeneration !== original.targetGeneration ||
      result.action !== original.command.action ||
      (terminal && !result.protectedResult) ||
      (result.state === "ready" &&
        result.action !== "capture" &&
        !result.root?.targetContainerId)
    )
      systemFail("System outcome differs from its immutable admission.");
    return this.database.transaction(async (tx) => {
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
            sql`${operations.state} NOT IN ('ready','failed','rejected')`,
            terminal ? undefined : eq(operations.revision, original.revision),
          ),
        )
        .returning();
      if (saved && terminal)
        await tx
          .update(instances)
          .set({
            runtimeGeneration: null,
            workerProcessGeneration: null,
            status: "unknown",
            lastError: null,
            powerEpoch: sql`${instances.powerEpoch}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(instances.id, original.instanceId),
              eq(instances.ownerId, ownerId),
              eq(instances.attachmentGeneration, original.fenceGeneration),
              eq(instances.powerEpoch, original.admissionEpoch),
            ),
          );
      const [row] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, original.operationId),
          ),
        );
      return row ?? systemFail("System operation not found.");
    });
  }
  async unknown(ownerId: string, original: SystemOperationRow) {
    await this.database
      .update(operations)
      .set({ state: "unknown", updatedAt: new Date() })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, original.operationId),
          eq(operations.revision, original.revision),
          sql`${operations.state} NOT IN ('ready','failed','rejected')`,
        ),
      );
    return (
      (await this.get(ownerId, original.instanceId, original.operationId)) ??
      systemFail("System operation not found.")
    );
  }
  async list(ownerId: string, instanceId: string, raw: unknown) {
    const input = cantripOsSystemListQuerySchema.parse(raw);
    const [instance] = await this.database
      .select({ id: instances.id })
      .from(instances)
      .where(and(eq(instances.ownerId, ownerId), eq(instances.id, instanceId)));
    if (!instance) systemFail("OS attachment not found.");
    if (input.cursor && !(await this.get(ownerId, instanceId, input.cursor)))
      systemFail("System history cursor not found.");
    const rows = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          input.cursor
            ? sql`(${operations.createdAt},${operations.operationId}) < (SELECT created_at,operation_id FROM cantrip_os_system_operations WHERE owner_id=${ownerId} AND instance_id=${instanceId} AND operation_id=${input.cursor})`
            : undefined,
        ),
      )
      .orderBy(desc(operations.createdAt), desc(operations.operationId))
      .limit(input.limit + 1);
    const more = rows.length > input.limit;
    rows.length = Math.min(rows.length, input.limit);
    return cantripOsSystemPageSchema.parse({
      items: rows.map(systemSummary),
      nextCursor: more ? rows.at(-1)!.operationId : null,
    });
  }
  async reject(ownerId: string, original: SystemOperationRow) {
    return this.database.transaction(async (tx) => {
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
        .set({ state: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, original.operationId),
            eq(operations.dispatchStage, "preparing"),
            sql`${operations.state} NOT IN ('ready','failed','rejected')`,
          ),
        )
        .returning();
      if (saved)
        await tx
          .update(instances)
          .set({
            runtimeGeneration: null,
            workerProcessGeneration: null,
            status: "unknown",
            powerEpoch: sql`${instances.powerEpoch}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(instances.id, original.instanceId),
              eq(instances.attachmentGeneration, original.fenceGeneration),
              eq(instances.powerEpoch, original.admissionEpoch),
            ),
          );
      const [row] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, original.operationId),
          ),
        );
      return row ?? systemFail("System operation not found.");
    });
  }
  async beginExecution(ownerId: string, original: SystemOperationRow) {
    return this.database.transaction(async (tx) => {
      const instance = await ownedSystemInstance(
        tx,
        ownerId,
        original.instanceId,
      );
      const [row] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, original.operationId),
          ),
        );
      if (
        !row ||
        row.retiredBy ||
        row.workerId !== instance.workerId ||
        instance.attachmentGeneration !== row.fenceGeneration
      )
        systemFail(
          "The prepared system attachment changed; no execution was dispatched.",
        );
      if (
        row.dispatchStage === "executing" ||
        row.state === "ready" ||
        row.state === "failed" ||
        row.state === "rejected"
      )
        return { row, created: false };
      if (row.result?.phase !== "prepared" || !row.result.protectedResult)
        systemFail(
          "The original Worker admission has not been durably prepared.",
        );
      const [saved] = await tx
        .update(operations)
        .set({
          dispatchStage: "executing",
          revision: sql`${operations.revision}+1`,
        })
        .where(eq(operations.operationId, row.operationId))
        .returning();
      return { row: saved!, created: true };
    });
  }
}
