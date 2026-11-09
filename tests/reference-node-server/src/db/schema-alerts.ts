import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import type { ProjectAlert } from "@cantrip/protocol";
import type { ProjectGoalObservation } from "@cantrip/protocol";
import { users, projects, chats } from "./schema.js";
import { workers } from "./schema.js";

export const chatGoalObservations = pgTable(
  "chat_goal_observations",
  {
    chatId: text("chat_id")
      .primaryKey()
      .references(() => chats.id, { onDelete: "cascade" }),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id").notNull(),
    sourceGeneration: text("source_generation").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    rowRevision: integer("row_revision").notNull().default(1),
    attentionEpoch: integer("attention_epoch").notNull().default(0),
    snapshot: jsonb("snapshot")
      .$type<ProjectGoalObservation["snapshot"]>()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_goal_observations_worker_idx").on(t.workerId)],
);

export const projectAlerts = pgTable(
  "project_alerts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    source: text("source").$type<ProjectAlert["source"]>().notNull(),
    sourceId: text("source_id").notNull(),
    episodeId: text("episode_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    kind: text("kind").$type<ProjectAlert["kind"]>().notNull(),
    priority: integer("priority").notNull(),
    target: jsonb("target").$type<ProjectAlert["target"]>().notNull(),
    protectedDetail:
      jsonb("protected_detail").$type<ProjectAlert["protectedDetail"]>(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    unique("project_alerts_episode_unique").on(
      t.ownerId,
      t.projectId,
      t.source,
      t.sourceId,
      t.episodeId,
    ),
    index("project_alerts_active_page_idx")
      .on(t.ownerId, t.projectId, t.priority, t.createdAt.desc(), t.id)
      .where(sql`${t.resolvedAt} IS NULL`),
    index("project_alerts_chat_idx")
      .on(t.chatId)
      .where(sql`${t.resolvedAt} IS NULL`),
    check("project_alerts_revision_check", sql`${t.sourceRevision}>0`),
  ],
);
