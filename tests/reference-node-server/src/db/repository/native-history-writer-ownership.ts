import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import type { ChatMessageOpaqueContent } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { protectedEventId } from "./native-history-output-alias.js";
import { NativeHistoryError } from "./native-history-bindings.js";
import { toEncryptedChatMessage } from "./message-mappers.js";

/** Caller holds the owning project/chat transaction lock, shared with canonical
 * ingestion. A reservation alone does not take over publication: only a committed
 * revision does. Return the current opaque message, never replay a stale body. */
export async function committedNativeHistoryMessage(
  tx: RepositoryDatabase,
  chatId: string,
  input: ChatMessageOpaqueContent,
) {
  const mapping = schema.nativeHistoryItems;
  const prefix = sql`case when ${mapping.component} = 'assistant' then 'agent-message' when ${mapping.component} = 'activity' then 'activity' end`;
  const matches = await tx
    .select({ message: schema.chatMessages, mapping })
    .from(mapping)
    .innerJoin(
      schema.chatMessages,
      and(
        eq(schema.chatMessages.id, mapping.messageId),
        eq(schema.chatMessages.chatId, mapping.chatId),
      ),
    )
    .where(
      and(
        eq(mapping.chatId, chatId),
        gt(mapping.revision, 0),
        or(
          eq(mapping.messageId, input.id),
          and(
            eq(mapping.identityKind, "canonical"),
            isNotNull(mapping.outputOperationId),
            or(
              sql`${input.idempotencyKey} = ${prefix} || ':root:' || ${mapping.turnId} || ':' || ${mapping.itemId}`,
              sql`${input.idempotencyKey} = ${prefix} || ':' || ${mapping.turnId} || ':' || ${mapping.threadId} || ':' || ${mapping.turnId} || ':' || ${mapping.itemId}`,
            ),
          ),
        ),
      ),
    );
  if (matches.length > 1)
    throw new NativeHistoryError("output-alias-ambiguous");
  const saved = matches[0];
  if (!saved) return null;
  const sameIdentity = input.id === saved.message.id;
  if (
    !saved.message.protectedContent ||
    saved.message.role !== input.classification.role ||
    saved.message.mode !== input.classification.mode ||
    (sameIdentity
      ? input.idempotencyKey !== saved.message.idempotencyKey
      : input.id !== protectedEventId(chatId, input.idempotencyKey))
  )
    throw new NativeHistoryError("item-canonical-message-conflict");
  return toEncryptedChatMessage(saved.message);
}
