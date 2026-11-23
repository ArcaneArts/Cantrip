import type {
  ChatExperience,
  ChatMessage,
  ChatMessageOpaqueSummary,
  ChatMessagePageInfo,
  ChatMessagePageQuery,
  TaskMessageOpaqueSummary,
} from "@cantrip/protocol";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";

import {
  CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  selectChatMessagePageWindow,
} from "../chat-message-pagination.js";
import * as schema from "../schema.js";
import {
  toChatMessage,
  toEncryptedChatMessage,
  toTaskMessage,
} from "./message-mappers.js";
import { toISOString, type RepositoryDatabase } from "./database.js";

export class MessageQueryRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listMessages(ownerId: string, chatId: string): Promise<ChatMessage[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toChatMessage(message));
  }

  async listEncryptedMessages(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toEncryptedChatMessage(message));
  }

  async getLatestEncryptedUserMessage(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.role, "user"),
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(1);
    return rows[0] ? toEncryptedChatMessage(rows[0].message) : null;
  }

  async trimLatestEncryptedTurn(
    ownerId: string,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const chats = await transaction
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.experience, "agent"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!chats[0]) return false;
      const messages = await transaction
        .select({
          id: schema.chatMessages.id,
          sequence: schema.chatMessages.sequence,
        })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.role, "user"),
            isNotNull(schema.chatMessages.protectedContent),
          ),
        )
        .orderBy(desc(schema.chatMessages.sequence))
        .limit(1);
      const latest = messages[0];
      if (!latest || latest.id !== messageId) return false;
      await transaction
        .delete(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            gte(schema.chatMessages.sequence, latest.sequence),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({
          protectedPlan: null,
          hasPendingPlanQuestion: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId));
      return true;
    });
  }

  private async listOpaqueMessagePageRows(
    ownerId: string,
    chatId: string,
    experience: ChatExperience,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: (typeof schema.chatMessages.$inferSelect)[];
    page: ChatMessagePageInfo;
  }> {
    const protectedColumn =
      experience === "task"
        ? schema.chatMessages.taskProtectedContent
        : schema.chatMessages.protectedContent;
    const cursorCondition = query.beforeSequence
      ? lt(schema.chatMessages.sequence, query.beforeSequence)
      : undefined;
    const headers = await this.database
      .select({
        role: schema.chatMessages.role,
        sequence: schema.chatMessages.sequence,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          cursorCondition,
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(CHAT_MESSAGE_PAGE_BOUNDARY_MAX + 1);

    if (headers.length === 0) {
      return {
        messages: [],
        page: {
          hasMore: false,
          nextBeforeSequence: null,
          oldestSequence: null,
          newestSequence: null,
          startsAtUserTurn: true,
        },
      };
    }

    const window = selectChatMessagePageWindow(headers, query.limit);
    const selectedHeaders = window.selected;
    const selectedSequences = selectedHeaders.map(({ sequence }) => sequence);
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          inArray(schema.chatMessages.sequence, selectedSequences),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    const oldestSequence = selectedHeaders.at(-1)?.sequence ?? null;
    return {
      messages: rows.map(({ message }) => message),
      page: {
        hasMore: window.hasMore,
        nextBeforeSequence: window.hasMore ? oldestSequence : null,
        oldestSequence,
        newestSequence: selectedHeaders[0]?.sequence ?? null,
        startsAtUserTurn: window.startsAtUserTurn,
      },
    };
  }

  async listEncryptedMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: ChatMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "agent",
      query,
    );
    return {
      messages: result.messages.map(toEncryptedChatMessage),
      page: result.page,
    };
  }

  async listAgentMessageWire(ownerId: string, chatId: string) {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) =>
      message.protectedContent
        ? toEncryptedChatMessage(message)
        : toChatMessage(message),
    );
  }

  async listTaskMessages(
    ownerId: string,
    chatId: string,
  ): Promise<TaskMessageOpaqueSummary[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "task"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toTaskMessage(message));
  }

  async listTaskMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: TaskMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "task",
      query,
    );
    return {
      messages: result.messages.map(toTaskMessage),
      page: result.page,
    };
  }

  async listMessageHeaders(ownerId: string, chatId: string) {
    const rows = await this.database
      .select({
        id: schema.chatMessages.id,
        executionLaneId: schema.chatMessages.executionLaneId,
        role: schema.chatMessages.role,
        createdAt: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map((row) => ({
      ...row,
      role: row.role as "assistant" | "system" | "user",
      createdAt: toISOString(row.createdAt),
    }));
  }
}
