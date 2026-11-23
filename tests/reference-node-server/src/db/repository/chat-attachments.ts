import {
  chatAttachmentOpaqueSummarySchema,
  type AttachmentProtectedMetadata,
  type ChatAttachmentOpaqueSummary,
} from "@cantrip/protocol/attachment-content";
import { and, eq, inArray, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export interface ChatAttachmentRecord extends ChatAttachmentOpaqueSummary {
  workerId: string;
}

export function toChatAttachmentOpaqueSummary(
  attachment: ChatAttachmentRecord,
): ChatAttachmentOpaqueSummary {
  return chatAttachmentOpaqueSummarySchema.parse({
    id: attachment.id,
    chatId: attachment.chatId,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    protectedMetadata: attachment.protectedMetadata,
    createdAt: attachment.createdAt,
  });
}

function toChatAttachment(
  attachment: typeof schema.chatAttachments.$inferSelect,
): ChatAttachmentRecord {
  return {
    ...chatAttachmentOpaqueSummarySchema.parse({
      id: attachment.id,
      chatId: attachment.chatId,
      sizeBytes: attachment.sizeBytes,
      status: attachment.status,
      protectedMetadata: attachment.protectedMetadata,
      createdAt: toISOString(attachment.createdAt),
    }),
    workerId: attachment.workerId,
  };
}

interface ChatAttachmentRepositoryCollaborators {
  getChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null>;
}

export class ChatAttachmentRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatAttachmentRepositoryCollaborators,
  ) {}

  async createChatAttachment(
    ownerId: string,
    chatId: string,
    input: {
      id: string;
      protectedMetadata: AttachmentProtectedMetadata;
      sizeBytes: number;
      workerId: string;
    },
  ): Promise<ChatAttachmentRecord | null> {
    const owned = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(schema.chatAttachments)
        .values({
          ...input,
          chatId,
          status: "ready",
        })
        .returning();
      const attachment = firstOrThrow(rows, "creating an attachment");
      await transaction.insert(schema.chatAttachmentReplicas).values({
        attachmentId: attachment.id,
        workerId: input.workerId,
        status: "ready",
      });
      return toChatAttachment(attachment);
    });
  }

  async getChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .where(
        and(
          eq(schema.chatAttachments.id, attachmentId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toChatAttachment(rows[0].attachment) : null;
  }

  async getChatAttachments(
    ownerId: string,
    chatId: string,
    attachmentIds: string[],
  ): Promise<ChatAttachmentRecord[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatAttachments.chatId),
          eq(schema.chats.id, chatId),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          inArray(schema.chatAttachments.id, attachmentIds),
        ),
      );
    const byId = new Map(
      rows.map(({ attachment }) => [
        attachment.id,
        toChatAttachment(attachment),
      ]),
    );
    return attachmentIds.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }

  async getChatAttachmentReplicaWorkerIds(
    ownerId: string,
    attachmentId: string,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ workerId: schema.chatAttachmentReplicas.workerId })
      .from(schema.chatAttachmentReplicas)
      .innerJoin(
        schema.chatAttachments,
        eq(
          schema.chatAttachments.id,
          schema.chatAttachmentReplicas.attachmentId,
        ),
      )
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatAttachmentReplicas.attachmentId, attachmentId),
          eq(schema.chatAttachmentReplicas.status, "ready"),
        ),
      );
    return [...new Set(rows.map(({ workerId }) => workerId))];
  }

  async deleteChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const attachment = await this.collaborators.getChatAttachment(
      ownerId,
      attachmentId,
    );
    if (!attachment) return null;
    await this.database
      .delete(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, attachmentId));
    return attachment;
  }
}
