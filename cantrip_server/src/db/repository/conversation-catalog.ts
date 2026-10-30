import {
  conversationCatalogWirePageSchema,
  conversationCursorSchema,
  type ConversationCatalogQuery,
  type ConversationUsage,
} from "@cantrip/protocol";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import {
  toArchivedChatWireSummary,
  toChatWireSummary,
} from "./chat-mappers.js";
import type { RepositoryDatabase } from "./database.js";

export class ConversationCursorError extends Error {}
export class ConversationUsageConflictError extends Error {}

export class ConversationCatalogRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async list(
    ownerId: string,
    projectId: string,
    input: ConversationCatalogQuery,
  ) {
    const [project] = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      );
    if (!project) return null;
    let cursor: ReturnType<typeof conversationCursorSchema.parse> | undefined;
    if (input.cursor) {
      try {
        cursor = conversationCursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw new ConversationCursorError("Invalid conversation cursor.");
      }
      if (cursor.projectId !== projectId || cursor.state !== input.state)
        throw new ConversationCursorError(
          "Conversation cursor does not match this list.",
        );
    }
    const c = schema.chats;
    const at = input.state === "active" ? c.lastUsedAt : c.archivedAt;
    const scope = and(
      eq(c.projectId, projectId),
      eq(c.ownerId, ownerId),
      eq(c.contextKind, "project"),
      eq(c.experience, "agent"),
      input.state === "active" ? isNull(c.archivedAt) : isNotNull(c.archivedAt),
    );
    const [rows, counts] = await Promise.all([
      this.database
        .select({
          chat: c,
          // Preserve sub-millisecond precision in keyset cursors. Date objects
          // would truncate created_at and skip rows at a page boundary.
          cursorAt: sql<string>`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          cursorCreatedAt: sql<string>`to_char(${c.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          messageCount:
            input.state === "active"
              ? sql<number>`0`
              : sql<number>`(select count(*)::int from ${schema.chatMessages} where ${schema.chatMessages.chatId} = ${c.id})`,
        })
        .from(c)
        .where(
          and(
            scope,
            cursor
              ? input.state === "active"
                ? sql`(${at}, ${c.createdAt}, ${c.id}) < (${cursor.at}::timestamptz, ${cursor.createdAt}::timestamptz, ${cursor.id})`
                : sql`(${at}, ${c.id}) < (${cursor.at}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(
          ...(input.state === "active"
            ? [desc(at), desc(c.createdAt), desc(c.id)]
            : [desc(at), desc(c.id)]),
        )
        .limit(input.limit + 1),
      this.database
        .select({ total: sql<number>`count(*)::int` })
        .from(c)
        .where(scope),
    ]);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              projectId,
              state: input.state,
              at: last.cursorAt,
              createdAt: last.cursorCreatedAt,
              id: last.chat.id,
            }),
          ).toString("base64url")
        : null;
    return conversationCatalogWirePageSchema.parse({
      state: input.state,
      total: counts[0]?.total ?? 0,
      nextCursor,
      items: page.map(({ chat, messageCount }) => ({
        ...(input.state === "active"
          ? toChatWireSummary(chat)
          : toArchivedChatWireSummary(chat, Number(messageCount))),
        lastUsedAt: chat.lastUsedAt.toISOString(),
      })),
    });
  }

  async recordUsage(ownerId: string, chatId: string, input: ConversationUsage) {
    return this.database.transaction(async (tx) => {
      const clients = schema.conversationUsageClients;
      const receipts = schema.conversationUsageReceipts;
      // Authorize before allocating client bookkeeping. Missing resources do
      // not advance the client's sequence or consume an operation identity.
      const [chat] = await tx
        .select()
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "project"),
            eq(schema.chats.experience, "agent"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update");
      if (!chat) return null;
      await tx
        .insert(clients)
        .values({ ownerId, clientId: input.clientId })
        .onConflictDoNothing();
      const clientScope = and(
        eq(clients.ownerId, ownerId),
        eq(clients.clientId, input.clientId),
      );
      const [client] = await tx
        .select()
        .from(clients)
        .where(clientScope)
        .for("update");
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.ownerId, ownerId),
            eq(receipts.clientId, input.clientId),
            eq(receipts.operationId, input.operationId),
          ),
        );
      if (receipt) {
        if (receipt.chatId !== chatId || receipt.sequence !== input.sequence)
          throw new ConversationUsageConflictError(
            "Usage operation was already used for different input.",
          );
        return {
          applied: receipt.applied,
          lastUsedAt: receipt.lastUsedAt.toISOString(),
        };
      }
      const applied = input.sequence > client!.sequence;
      const lastUsedAt = applied
        ? new Date(Math.max(Date.now(), chat.lastUsedAt.getTime() + 1))
        : chat.lastUsedAt;
      if (applied) {
        await tx
          .update(clients)
          .set({ sequence: input.sequence })
          .where(clientScope);
        await tx
          .update(schema.chats)
          .set({ lastUsedAt })
          .where(eq(schema.chats.id, chatId));
      }
      await tx
        .insert(receipts)
        .values({ ...input, ownerId, chatId, lastUsedAt, applied });
      return { applied, lastUsedAt: lastUsedAt.toISOString() };
    });
  }
}
