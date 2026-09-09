import { and, eq, inArray } from "drizzle-orm";
import { chatAttachmentOpaqueSummarySchema } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";

/** Read only attachments referenced by these messages in the authorized chat.
 * Missing messages are valid for uncommitted identity reservations. */
export async function readNativeHistoryAttachmentReferences(
  tx: RepositoryTransaction,
  chatId: string,
  messageIds: string[],
) {
  const messages = messageIds.length
    ? await tx
        .select({
          id: schema.chatMessages.id,
          attachmentIds: schema.chatMessages.attachmentIds,
        })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            inArray(schema.chatMessages.id, messageIds),
          ),
        )
    : [];
  const messageAttachments = new Map(
    messages.map((message) => [message.id, message.attachmentIds]),
  );
  const attachmentIds = [
    ...new Set(messages.flatMap((message) => message.attachmentIds)),
  ];
  const attachments = attachmentIds.length
    ? await tx
        .select()
        .from(schema.chatAttachments)
        .where(
          and(
            eq(schema.chatAttachments.chatId, chatId),
            inArray(schema.chatAttachments.id, attachmentIds),
          ),
        )
    : [];
  const descriptors = new Map(
    attachments.map((attachment) => [
      attachment.id,
      chatAttachmentOpaqueSummarySchema.parse({
        id: attachment.id,
        chatId: attachment.chatId,
        sizeBytes: attachment.sizeBytes,
        status: attachment.status,
        protectedMetadata: attachment.protectedMetadata,
        createdAt: attachment.createdAt.toISOString(),
      }),
    ]),
  );
  return new Map(
    [...messageAttachments].map(([messageId, ids]) => [
      messageId,
      ids.map((id) => {
        const descriptor = descriptors.get(id);
        if (!descriptor)
          throw new NativeHistoryError("referenced-attachment-unavailable");
        return descriptor;
      }),
    ]),
  );
}
