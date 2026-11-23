import type {
  CantripOsPowerCreate,
  CantripOsPowerOperationResult,
  CantripOsPowerWorkerCommand,
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users, workers } from "./schema.js";
import { cantripOsInstances } from "./schema-cantrip-os.js";

export const cantripOsPowerTargets = pgTable("cantrip_os_power_targets", {
  instanceId: text("instance_id")
    .primaryKey()
    .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
  generation: text("generation").notNull(),
  attachmentGeneration: text("attachment_generation").notNull(),
  runtimeGeneration: text("runtime_generation").notNull(),
  containerId: text("container_id").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const cantripOsPowerOperations = pgTable(
  "cantrip_os_power_operations",
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
    action: text("action").$type<CantripOsPowerCreate["action"]>().notNull(),
    state: text("state")
      .$type<"admitted" | "running" | "ready" | "failed" | "unknown">()
      .notNull()
      .default("admitted"),
    request: jsonb("request").$type<CantripOsPowerCreate>().notNull(),
    command: jsonb("command")
      .$type<
        Extract<
          CantripOsPowerWorkerCommand,
          { type: "cantrip-os.power.operation" }
        >
      >()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    result: jsonb("result").$type<CantripOsPowerOperationResult>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_power_owner_created_index").on(
      table.ownerId,
      table.instanceId,
      table.createdAt,
      table.operationId,
    ),
    uniqueIndex("cantrip_os_power_active_target_unique")
      .on(table.instanceId, table.attachmentGeneration, table.targetGeneration)
      .where(sql`${table.state} IN ('admitted','running','unknown')`),
    check(
      "cantrip_os_power_action_check",
      sql`${table.action} IN ('start','stop','restart')`,
    ),
    check(
      "cantrip_os_power_state_check",
      sql`${table.state} IN ('admitted','running','ready','failed','unknown')`,
    ),
  ],
);
