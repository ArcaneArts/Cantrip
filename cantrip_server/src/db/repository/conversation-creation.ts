import type { EncryptedChatCreate } from "@cantrip/protocol";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { toChatWireSummary } from "./chat-mappers.js";

export class ConversationCreationConflictError extends Error {}

export async function replayConversationCreation(
  database: RepositoryDatabase,
  ownerId: string,
  projectId: string,
  input: EncryptedChatCreate,
) {
  const [row] = await database
    .select({
      chat: schema.chats,
      matches: sql<boolean>`${schema.conversationCreationRequests.request} = ${JSON.stringify(input)}::jsonb`,
    })
    .from(schema.conversationCreationRequests)
    .innerJoin(
      schema.chats,
      eq(schema.chats.id, schema.conversationCreationRequests.chatId),
    )
    .where(
      and(
        eq(schema.chats.id, input.id),
        eq(schema.chats.ownerId, ownerId),
        eq(schema.chats.projectId, projectId),
      ),
    );
  if (!row) return null;
  if (!row.matches || row.chat.archivedAt)
    throw new ConversationCreationConflictError(
      "Conversation creation identity is already in use.",
    );
  return toChatWireSummary(row.chat);
}
