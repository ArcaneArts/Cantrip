import type {
  cantripOsOperationResultSchema,
  cantripOsWorkspaceCreateSchema,
  workerCantripOsCommandSchemas,
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

export const cantripOsWorkspaceOperations = pgTable(
  "cantrip_os_workspace_operations",
  {
    operationId: text("operation_id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    guestWorkspaceId: text("guest_workspace_id").notNull(),
    attachmentGeneration: text("attachment_generation").notNull(),
    runtimeGeneration: text("runtime_generation").notNull(),
    state: text("state")
      .$type<"admitted" | "running" | "ready" | "failed" | "unknown">()
      .notNull()
      .default("admitted"),
    request: jsonb("request")
      .$type<ReturnType<typeof cantripOsWorkspaceCreateSchema.parse>>()
      .notNull(),
    command: jsonb("command")
      .$type<
        Extract<
          ReturnType<(typeof workerCantripOsCommandSchemas)[number]["parse"]>,
          { type: "cantrip-os.workspaces.create" }
        >
      >()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    result:
      jsonb("result").$type<
        ReturnType<typeof cantripOsOperationResultSchema.parse>
      >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cantrip_os_workspace_operation_history").on(
      table.ownerId,
      table.instanceId,
      table.createdAt,
      table.operationId,
    ),
    check(
      "cantrip_os_workspace_operation_state",
      sql`${table.state} IN ('admitted','running','ready','failed','unknown')`,
    ),
  ],
);
