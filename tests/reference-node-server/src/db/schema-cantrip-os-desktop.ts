import type {
  CantripOsDesktopCreate,
  CantripOsDesktopOperationResult,
  CantripOsDesktopWorkerCommand,
  CantripOsGuestDesktopTarget,
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
import {
  cantripOsInstances,
  cantripOsWorkspaces,
} from "./schema-cantrip-os.js";

export const cantripOsDesktopTargets = pgTable("cantrip_os_desktop_targets", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cantripOsWorkspaces.id, { onDelete: "cascade" }),
  generation: text("generation").notNull(),
  attachmentGeneration: text("attachment_generation").notNull(),
  runtimeGeneration: text("runtime_generation").notNull(),
  snapshot: jsonb("snapshot").$type<CantripOsGuestDesktopTarget>().notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const cantripOsDesktopOperations = pgTable(
  "cantrip_os_desktop_operations",
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
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cantripOsWorkspaces.id, { onDelete: "cascade" }),
    runtimeGeneration: text("runtime_generation").notNull(),
    attachmentGeneration: text("attachment_generation").notNull(),
    targetGeneration: text("target_generation").notNull(),
    action: text("action").$type<CantripOsDesktopCreate["action"]>().notNull(),
    state: text("state")
      .$type<"admitted" | "running" | "ready" | "failed" | "unknown">()
      .notNull()
      .default("admitted"),
    request: jsonb("request").$type<CantripOsDesktopCreate>().notNull(),
    command: jsonb("command")
      .$type<
        Extract<
          CantripOsDesktopWorkerCommand,
          { type: "cantrip-os.desktop.operation" }
        >
      >()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    result: jsonb("result").$type<CantripOsDesktopOperationResult>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_desktop_owner_created_index").on(
      table.ownerId,
      table.workspaceId,
      table.createdAt,
      table.operationId,
    ),
    uniqueIndex("cantrip_os_desktop_active_target_unique")
      .on(
        table.workspaceId,
        table.attachmentGeneration,
        table.runtimeGeneration,
        table.targetGeneration,
      )
      .where(sql`${table.state} IN ('admitted','running','unknown')`),
    check(
      "cantrip_os_desktop_action_check",
      sql`${table.action} IN ('start','stop','restart')`,
    ),
    check(
      "cantrip_os_desktop_state_check",
      sql`${table.state} IN ('admitted','running','ready','failed','unknown')`,
    ),
  ],
);
