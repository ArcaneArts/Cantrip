import type {
  CantripOsSystemCreate,
  CantripOsSystemOperationCommand,
  cantripOsSystemStatusResultSchema,
  cantripOsSystemOperationResultSchema,
} from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users, workers } from "./schema.js";
import { cantripOsInstances } from "./schema-cantrip-os.js";

export const cantripOsSystemTargets = pgTable("cantrip_os_system_targets", {
  instanceId: text("instance_id")
    .primaryKey()
    .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
  attachmentGeneration: text("attachment_generation").notNull(),
  observationEpoch: integer("observation_epoch").notNull().default(0),
  catalogPowerEpoch: integer("catalog_power_epoch"),
  catalog:
    jsonb("catalog").$type<
      ReturnType<typeof cantripOsSystemStatusResultSchema.parse>
    >(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});
export const cantripOsSystemOperations = pgTable(
  "cantrip_os_system_operations",
  {
    operationId: text("operation_id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
    attachmentGeneration: text("attachment_generation").notNull(),
    targetGeneration: text("target_generation").notNull(),
    fenceGeneration: text("fence_generation").notNull(),
    admissionEpoch: integer("admission_epoch").notNull(),
    dispatchStage: text("dispatch_stage")
      .$type<"preparing" | "executing">()
      .notNull()
      .default("preparing"),
    state: text("state")
      .$type<
        "admitted" | "running" | "ready" | "failed" | "unknown" | "rejected"
      >()
      .notNull()
      .default("admitted"),
    request: jsonb("request").$type<CantripOsSystemCreate>().notNull(),
    command: jsonb("command")
      .$type<CantripOsSystemOperationCommand>()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    retiredBy: text("retired_by"),
    recoveryGeneration: text("recovery_generation"),
    result:
      jsonb("result").$type<
        ReturnType<typeof cantripOsSystemOperationResultSchema.parse>
      >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_system_owner_created_index").on(
      table.ownerId,
      table.instanceId,
      table.createdAt,
      table.operationId,
    ),
    check(
      "cantrip_os_system_state_check",
      sql`${table.state} IN ('admitted','running','ready','failed','unknown','rejected')`,
    ),
  ],
);
