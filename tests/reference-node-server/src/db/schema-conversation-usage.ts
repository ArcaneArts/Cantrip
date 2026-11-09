import {
  bigint,
  boolean,
  foreignKey,
  jsonb,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EncryptedChatCreate } from "@cantrip/protocol";
import { chats, users } from "./schema.js";

export const conversationUsageClients = pgTable(
  "conversation_usage_clients",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.clientId] }),
    check("conversation_usage_clients_sequence_check", sql`${t.sequence} >= 0`),
  ],
);

export const conversationUsageReceipts = pgTable(
  "conversation_usage_receipts",
  {
    ownerId: text("owner_id").notNull(),
    clientId: text("client_id").notNull(),
    operationId: text("operation_id").notNull(),
    chatId: text("chat_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    applied: boolean("applied").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.clientId, t.operationId] }),
    check("conversation_usage_receipts_sequence_check", sql`${t.sequence} > 0`),
    foreignKey({
      columns: [t.chatId, t.ownerId],
      foreignColumns: [chats.id, chats.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.ownerId, t.clientId],
      foreignColumns: [
        conversationUsageClients.ownerId,
        conversationUsageClients.clientId,
      ],
    }).onDelete("cascade"),
  ],
);

/** Original encrypted request permits safe retries even after a title changes. */
export const conversationCreationRequests = pgTable(
  "conversation_creation_requests",
  {
    chatId: text("chat_id")
      .primaryKey()
      .references(() => chats.id, { onDelete: "cascade" }),
    request: jsonb("request").$type<EncryptedChatCreate>().notNull(),
  },
);
