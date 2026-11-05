import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import type { WorkerCommand } from "@cantrip/protocol";
import { users, workers } from "./schema.js";

/** Pending cleanup metadata deliberately has no project/chat foreign key. */
export const inferenceResourceRevocations = pgTable(
  "inference_resource_revocations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    target: jsonb("target")
      .$type<Extract<WorkerCommand, { type: "inference.revoke" }>["target"]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "inference_resource_revocations_target_check",
      sql`jsonb_typeof(${table.target}) = 'object'`,
    ),
    index("inference_resource_revocations_worker_idx").on(
      table.ownerId,
      table.workerId,
      table.createdAt,
      table.id,
    ),
  ],
);
