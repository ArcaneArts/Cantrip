import type {
  CantripOsBackupAdmission,
  CantripOsBackupWorkerCommand,
  CantripOsBackupOperationResult,
  CantripOsDispatchScope,
} from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users, workers } from "./schema.js";
import {
  cantripOsInstances,
  cantripOsWorkspaces,
} from "./schema-cantrip-os.js";

/** Private immutable admissions and opaque receipts. Capture rows form the
 * catalogue; completion does not assert current archive/Worker availability. */
export const cantripOsBackupOperations = pgTable(
  "cantrip_os_backup_operations",
  {
    operationId: text("operation_id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => cantripOsInstances.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cantripOsWorkspaces.id, { onDelete: "restrict" }),
    action: text("action")
      .$type<"capture" | "restore" | "rollback">()
      .notNull(),
    backupId: text("backup_id"),
    restoreOperationId: text("restore_operation_id"),
    request: jsonb("request").$type<CantripOsBackupAdmission>().notNull(),
    command: jsonb("command")
      .$type<
        Exclude<
          CantripOsBackupWorkerCommand,
          { type: "cantrip-os.backup.observe" }
        >
      >()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    continuationScope:
      jsonb("continuation_scope").$type<CantripOsDispatchScope>(),
    result: jsonb("result").$type<CantripOsBackupOperationResult>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_backup_operations_owner_created_index").on(
      table.ownerId,
      table.createdAt,
      table.operationId,
    ),
    foreignKey({
      columns: [table.backupId],
      foreignColumns: [table.operationId],
      name: "cantrip_os_backup_reference",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.restoreOperationId],
      foreignColumns: [table.operationId],
      name: "cantrip_os_backup_restore_reference",
    }).onDelete("restrict"),
    check(
      "cantrip_os_backup_action_check",
      sql`(${table.action} = 'capture' AND ${table.backupId} IS NULL AND ${table.restoreOperationId} IS NULL) OR (${table.action} = 'restore' AND ${table.backupId} IS NOT NULL AND ${table.restoreOperationId} IS NULL) OR (${table.action} = 'rollback' AND ${table.backupId} IS NULL AND ${table.restoreOperationId} IS NOT NULL)`,
    ),
    check("cantrip_os_backup_revision_check", sql`${table.revision} >= 0`),
  ],
);
