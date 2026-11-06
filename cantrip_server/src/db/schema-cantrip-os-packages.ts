import type {
  CantripOsPackageCreate,
  CantripOsPackageOperationCommand,
} from "@cantrip/protocol";
import type {
  cantripOsPackageCatalogResultSchema,
  cantripOsPackageOperationResultSchema,
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

export const cantripOsPackageTargets = pgTable("cantrip_os_package_targets", {
  instanceId: text("instance_id")
    .primaryKey()
    .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
  attachmentGeneration: text("attachment_generation").notNull(),
  observationEpoch: integer("observation_epoch").notNull().default(0),
  catalogPowerEpoch: integer("catalog_power_epoch"),
  catalog:
    jsonb("catalog").$type<
      ReturnType<typeof cantripOsPackageCatalogResultSchema.parse>
    >(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});
export const cantripOsPackageOperations = pgTable(
  "cantrip_os_package_operations",
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
    admissionEpoch: integer("admission_epoch").notNull(),
    state: text("state")
      .$type<"admitted" | "running" | "ready" | "failed" | "unknown">()
      .notNull()
      .default("admitted"),
    request: jsonb("request").$type<CantripOsPackageCreate>().notNull(),
    command: jsonb("command")
      .$type<CantripOsPackageOperationCommand>()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    result:
      jsonb("result").$type<
        ReturnType<typeof cantripOsPackageOperationResultSchema.parse>
      >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_package_owner_created_index").on(
      table.ownerId,
      table.instanceId,
      table.createdAt,
      table.operationId,
    ),
    check(
      "cantrip_os_package_state_check",
      sql`${table.state} IN ('admitted','running','ready','failed','unknown')`,
    ),
  ],
);
