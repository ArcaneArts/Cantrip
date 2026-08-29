import type {
  ArchivedStandaloneChatWireSummary,
  ChatWireSummary,
  StandaloneChatWireSummary,
} from "@cantrip/protocol";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
} from "../tab-layouts.js";
import {
  chatIsExecuting,
  requiredProjectChatProjectId,
} from "./chat-execution-lanes.js";
import {
  ARCHIVED_CHAT_RETENTION_MS,
  toArchivedStandaloneChatWireSummary,
  toChatWireSummary,
  toStandaloneChatWireSummary,
} from "./chat-mappers.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export interface ChatArchiveLifecycleRepositoryCollaborators {
  nextProjectTabPosition(projectId: string): Promise<number>;
}

export class ChatArchiveLifecycleRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatArchiveLifecycleRepositoryCollaborators,
  ) {}

  async deleteChat(
    ownerId: string,
    chatId: string,
  ): Promise<false | "archived" | "deleted" | "running"> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const chat = rows[0]?.chat;
    if (!chat || chat.archivedAt) return false;
    const projectId = requiredProjectChatProjectId(chat.projectId);
    if (chatIsExecuting(chat.status as ChatWireSummary["status"]))
      return "running";
    return this.database.transaction(async (transaction) => {
      const messages = await transaction
        .select({ id: schema.chatMessages.id })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, chatId))
        .limit(1);
      await detachProjectTab(
        transaction,
        projectId,
        projectTabKey("chat", chatId),
      );
      if (messages[0]) {
        await transaction
          .update(schema.chats)
          .set({
            archivedAt: new Date(),
            automationPaused: true,
            status: "idle",
            updatedAt: new Date(),
          })
          .where(eq(schema.chats.id, chatId));
        return "archived";
      }
      await transaction.delete(schema.chats).where(eq(schema.chats.id, chatId));
      return "deleted";
    });
  }

  async archiveStandaloneChat(
    ownerId: string,
    chatId: string,
  ): Promise<
    | false
    | "running"
    | {
        archivedAt: string;
        archiveExpiresAt: string;
        chat: ArchivedStandaloneChatWireSummary;
        rootId: string;
        workerId: string;
      }
  > {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats, root: schema.standaloneChatRoots })
        .from(schema.chats)
        .innerJoin(
          schema.standaloneChatRoots,
          and(
            eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
            eq(schema.standaloneChatRoots.chatId, schema.chats.id),
          ),
        )
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      if (chatIsExecuting(row.chat.status as ChatWireSummary["status"])) {
        return "running";
      }
      const archivedAt = new Date();
      const archiveExpiresAt = new Date(
        archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
      );
      const chat = firstOrThrow(
        await transaction
          .update(schema.chats)
          .set({ archivedAt, status: "idle", updatedAt: archivedAt })
          .where(eq(schema.chats.id, chatId))
          .returning(),
        "archiving a standalone Chat",
      );
      await transaction
        .update(schema.standaloneChatRoots)
        .set({ archivedAt, archiveExpiresAt, updatedAt: archivedAt })
        .where(eq(schema.standaloneChatRoots.id, row.root.id));
      const messageCount = Number(
        (
          await transaction
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.chatId, chatId))
        )[0]?.count ?? 0,
      );
      return {
        archivedAt: toISOString(archivedAt),
        archiveExpiresAt: toISOString(archiveExpiresAt),
        chat: toArchivedStandaloneChatWireSummary(chat, messageCount),
        rootId: row.root.id,
        workerId: row.root.workerId,
      };
    });
  }

  async restoreStandaloneChat(
    ownerId: string,
    chatId: string,
  ): Promise<null | {
    chat: StandaloneChatWireSummary;
    rootId: string;
    workerId: string;
  }> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats, root: schema.standaloneChatRoots })
        .from(schema.chats)
        .innerJoin(
          schema.standaloneChatRoots,
          eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
        )
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNotNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const restored = firstOrThrow(
        await transaction
          .update(schema.chats)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(schema.chats.id, chatId))
          .returning(),
        "restoring a standalone Chat",
      );
      await transaction
        .update(schema.standaloneChatRoots)
        .set({
          archivedAt: null,
          archiveExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.standaloneChatRoots.id, row.root.id));
      return {
        chat: toStandaloneChatWireSummary(restored),
        rootId: row.root.id,
        workerId: row.root.workerId,
      };
    });
  }

  async getStandaloneChatRootForDeletion(
    ownerId: string,
    chatId: string,
  ): Promise<{
    chatId: string;
    ownerId: string;
    rootId: string;
    workerId: string;
  } | null> {
    const rows = await this.database
      .select({
        chatId: schema.standaloneChatRoots.chatId,
        ownerId: schema.standaloneChatRoots.ownerId,
        rootId: schema.standaloneChatRoots.id,
        workerId: schema.standaloneChatRoots.workerId,
      })
      .from(schema.standaloneChatRoots)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.standaloneChatRoots.chatId),
      )
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async restoreArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<ChatWireSummary | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(eq(schema.chats.id, chatId), isNotNull(schema.chats.archivedAt)),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    if (!chat) return null;
    const projectId = requiredProjectChatProjectId(chat.projectId);
    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const restored = await transaction
        .update(schema.chats)
        .set({ archivedAt: null, position, updatedAt: new Date() })
        .where(eq(schema.chats.id, chatId))
        .returning();
      if (chat.experience !== "task") {
        await attachProjectTab(transaction, {
          projectId,
          tabId: chatId,
          tabKind: "chat",
        });
      }
      return toChatWireSummary(firstOrThrow(restored, "restoring a chat"));
    });
  }

  async permanentlyDeleteArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<boolean> {
    const deleted = await this.database
      .delete(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          isNotNull(schema.chats.archivedAt),
          inArray(
            schema.chats.projectId,
            this.database
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: schema.chats.id });
    return deleted.length > 0;
  }

  async purgeExpiredArchivedChats(
    ownerId: string,
    cutoff: Date,
  ): Promise<number> {
    const deleted = await this.database
      .delete(schema.chats)
      .where(
        and(
          isNotNull(schema.chats.archivedAt),
          lte(schema.chats.archivedAt, cutoff),
          inArray(
            schema.chats.projectId,
            this.database
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: schema.chats.id });
    return deleted.length;
  }
}
