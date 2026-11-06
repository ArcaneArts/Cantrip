import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  cantripOsBackupOperationResultSchema,
  cantripOsBackupWorkerCommandSchema,
  type CantripOsBackupAdmission,
  type CantripOsBackupListQuery,
  type CantripOsBackupOperationResult,
  type cantripOsBackupRecoverySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";
import { backupCommand } from "./cantrip-os-backup-command.js";

const table = schema.cantripOsBackupOperations;
export type BackupOperationRow = typeof table.$inferSelect;
export class CantripOsBackupRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async get(ownerId: string, operationId: string) {
    const [row] = await this.database
      .select()
      .from(table)
      .where(
        and(eq(table.ownerId, ownerId), eq(table.operationId, operationId)),
      );
    return row ?? null;
  }
  async list(
    ownerId: string,
    query: CantripOsBackupListQuery,
    capturesOnly: boolean,
  ) {
    const cursor = query.cursor ? await this.get(ownerId, query.cursor) : null;
    if (
      query.cursor &&
      (!cursor || (capturesOnly && cursor.action !== "capture"))
    )
      throw new CantripOsPlacementError("Backup cursor not found.");
    const rows = await this.database
      .select()
      .from(table)
      .where(
        and(
          eq(table.ownerId, ownerId),
          capturesOnly ? eq(table.action, "capture") : undefined,
          cursor
            ? // Keep PostgreSQL's full timestamp precision. The Date projection
              // used by summaries truncates microseconds and cannot be a cursor.
              sql`(${table.createdAt}, ${table.operationId}) < (SELECT created_at, operation_id FROM cantrip_os_backup_operations WHERE owner_id = ${ownerId} AND operation_id = ${cursor.operationId})`
            : undefined,
        ),
      )
      .orderBy(desc(table.createdAt), desc(table.operationId))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? items.at(-1)!.operationId : null,
    };
  }
  async admit(
    ownerId: string,
    instanceId: string,
    serverId: string,
    input: CantripOsBackupAdmission,
  ) {
    return this.database.transaction(async (tx) => {
      // Serialize the durable identity against the real instance. Root's actual
      // maintenance lock remains responsible for concurrent guest operations.
      const [owned] = await tx
        .select({ id: schema.cantripOsInstances.id })
        .from(schema.cantripOsInstances)
        .where(
          and(
            eq(schema.cantripOsInstances.id, instanceId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
          ),
        )
        .for("update");
      if (!owned) throw new CantripOsPlacementError("OS attachment not found.");
      const [old] = await tx
        .select()
        .from(table)
        .where(eq(table.operationId, input.operationId));
      if (old) {
        if (
          old.ownerId !== ownerId ||
          old.instanceId !== instanceId ||
          !isDeepStrictEqual(old.request, input)
        )
          throw new CantripOsPlacementError(
            "The operation ID belongs to a different backup admission.",
          );
        return { row: old, created: false };
      }
      const command = cantripOsBackupWorkerCommandSchema.parse(
        await backupCommand(tx, ownerId, instanceId, serverId, input),
      );
      if (command.type === "cantrip-os.backup.observe")
        throw new Error("Observation cannot admit a backup job.");
      const [row] = await tx
        .insert(table)
        .values({
          operationId: input.operationId,
          ownerId,
          workerId: command.scope.workerId,
          instanceId,
          workspaceId: input.workspaceId,
          action: input.action,
          request: input,
          command,
          backupId: input.action === "restore" ? input.backupId : null,
          restoreOperationId:
            input.action === "rollback" ? input.restoreOperationId : null,
        })
        .returning();
      return { row: row!, created: true };
    });
  }
  async beginObservation(
    ownerId: string,
    operationId: string,
    continuation?: Extract<
      ReturnType<typeof cantripOsBackupRecoverySchema.parse>,
      { mode: "continue" }
    > & { serverId: string },
  ) {
    if (continuation)
      return this.database.transaction(async (tx) => {
        // Match admission's instance-before-operation lock order, including
        // inserts whose backup reference takes a key-share lock on this row.
        await tx
          .select({ id: schema.cantripOsInstances.id })
          .from(schema.cantripOsInstances)
          .innerJoin(table, eq(table.instanceId, schema.cantripOsInstances.id))
          .where(
            and(eq(table.ownerId, ownerId), eq(table.operationId, operationId)),
          )
          .for("update", { of: schema.cantripOsInstances });
        const [current] = await tx
          .select({
            operation: table,
            instance: schema.cantripOsInstances,
            workspace: schema.cantripOsWorkspaces,
          })
          .from(table)
          .innerJoin(
            schema.cantripOsInstances,
            eq(schema.cantripOsInstances.id, table.instanceId),
          )
          .innerJoin(
            schema.cantripOsWorkspaces,
            eq(schema.cantripOsWorkspaces.id, table.workspaceId),
          )
          .where(
            and(eq(table.ownerId, ownerId), eq(table.operationId, operationId)),
          )
          .for("update");
        if (!current)
          throw new CantripOsPlacementError("Backup operation not found.");
        const { operation: o, instance: i, workspace: w } = current,
          original = o.command.scope;
        if (
          i.ownerId !== ownerId ||
          i.attachmentGeneration !== continuation.attachmentGeneration ||
          i.attachmentGeneration !== original.attachmentGeneration ||
          i.runtimeGeneration !== continuation.runtimeGeneration ||
          i.guestInstanceId !== original.guestInstanceId ||
          i.workerId !== original.workerId ||
          original.serverId !== continuation.serverId ||
          !isDeepStrictEqual(o.command.workspace, {
            id: w.id,
            guestWorkspaceId: w.guestWorkspaceId,
            uid: w.uid,
            gid: w.gid,
            homeGuestPath: w.homeGuestPath,
          })
        )
          throw new CantripOsPlacementError(
            "The continuation target changed. Check recovery and select its current runtime before continuing.",
          );
        const [row] = await tx
          .update(table)
          .set({
            revision: sql`${table.revision} + 1`,
            continuationScope: {
              ...original,
              runtimeGeneration: continuation.runtimeGeneration,
            },
          })
          .where(eq(table.operationId, operationId))
          .returning();
        return row!;
      });
    const [row] = await this.database
      .update(table)
      .set({ revision: sql`${table.revision} + 1` })
      .where(
        and(eq(table.ownerId, ownerId), eq(table.operationId, operationId)),
      )
      .returning();
    if (!row) throw new CantripOsPlacementError("Backup operation not found.");
    return row;
  }
  async record(
    ownerId: string,
    original: BackupOperationRow,
    raw: CantripOsBackupOperationResult,
  ) {
    const result = cantripOsBackupOperationResultSchema.parse(raw);
    if (
      result.operationId !== original.operationId ||
      result.action !== original.action
    )
      throw new Error("The backup response belongs to another admission.");
    await this.database
      .update(table)
      .set({ result, updatedAt: new Date() })
      .where(
        and(
          eq(table.ownerId, ownerId),
          eq(table.operationId, original.operationId),
          sql`${table.result}->>'state' IS DISTINCT FROM 'ready'`,
          result.state === "ready"
            ? undefined
            : eq(table.revision, original.revision),
        ),
      );
    return (await this.get(ownerId, original.operationId))!;
  }
}
