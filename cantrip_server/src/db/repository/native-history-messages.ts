import { isDeepStrictEqual } from "node:util";
import { and, eq, or } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  type NativeHistoryBinding,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";
import { nativeHistoryItemKey } from "./native-history-items.js";
import { nativeHistoryPayloadDigest } from "./native-history-digest.js";
import { persistNativeHistoryAttachments } from "./native-history-attachments.js";

/** Full opaque item writes, revisions and order share the stream receipt's
 * transaction. This path never acquires or settles a current execution lane. */
export async function persistNativeHistoryMessages(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  items: NativeHistoryPreparedBatch["items"],
): Promise<void> {
  for (const item of items) {
    if (
      item.evidence &&
      (item.evidence.bindingId !== binding.id ||
        item.evidence.workerId !== binding.workerId)
    )
      throw new NativeHistoryError("item-evidence-binding-mismatch");
    if (
      item.attachments.some(
        (attachment) => attachment.chatId !== binding.chatId,
      )
    )
      throw new NativeHistoryError("item-attachment-mismatch");
    const key = nativeHistoryItemKey(binding.chatId, item.identity);
    const [mapping] = await tx
      .select()
      .from(schema.nativeHistoryItems)
      .where(eq(schema.nativeHistoryItems.key, key))
      .for("update");
    if (
      !mapping ||
      mapping.chatId !== binding.chatId ||
      mapping.threadId !== binding.threadId
    )
      throw new NativeHistoryError("item-not-resolved");
    const message = item.message;
    if (
      message.id !== mapping.messageId ||
      message.idempotencyKey !== mapping.idempotencyKey
    )
      throw new NativeHistoryError("item-message-identity-conflict");
    if (
      mapping.preservedInput &&
      !isDeepStrictEqual(message, mapping.preservedInput)
    )
      throw new NativeHistoryError("input-alias-content-conflict");
    if (
      item.expectedRevision !== undefined &&
      (item.expectedRevision !== mapping.revision ||
        item.revision <= mapping.revision)
    )
      throw new NativeHistoryError("item-revision-conflict");
    const payloadDigest = nativeHistoryPayloadDigest(item);
    if (item.revision < mapping.revision) continue;
    if (item.revision === mapping.revision) {
      if (mapping.payloadDigest !== payloadDigest)
        throw new NativeHistoryError("item-revision-conflict");
      continue;
    }
    if (mapping.state === "completed" && item.state !== "completed") {
      if (item.expectedRevision !== undefined)
        throw new NativeHistoryError("item-revision-conflict");
      continue;
    }
    const matches = await tx
      .select()
      .from(schema.chatMessages)
      .where(
        or(
          eq(schema.chatMessages.id, message.id),
          and(
            eq(schema.chatMessages.chatId, binding.chatId),
            eq(schema.chatMessages.idempotencyKey, message.idempotencyKey),
          ),
        ),
      )
      .for("update");
    const existing = matches[0];
    if (
      matches.length > 1 ||
      (existing &&
        (existing.chatId !== binding.chatId ||
          existing.id !== message.id ||
          existing.idempotencyKey !== message.idempotencyKey ||
          existing.role !== message.classification.role ||
          existing.mode !== message.classification.mode ||
          !existing.protectedContent))
    )
      throw new NativeHistoryError("item-canonical-message-conflict");
    await persistNativeHistoryAttachments(tx, binding, item);
    const values = {
      role: message.classification.role,
      mode: message.classification.mode,
      content: null,
      protectedContent: message.protectedContent,
      attachmentIds: message.classification.attachmentIds,
      reasoningEffort: message.reasoningEffort,
      idempotencyKey: message.idempotencyKey,
    };
    if (existing) {
      // GUI inputs were stored before execution. Keep that canonical row and
      // its original timestamp, attribution, content and attachment references.
      if (!mapping.preservedInput)
        await tx
          .update(schema.chatMessages)
          .set(values)
          .where(eq(schema.chatMessages.id, message.id));
    } else {
      const [command] = await tx
        .select({ command: schema.nativeCommands })
        .from(schema.nativeCommandTurns)
        .innerJoin(
          schema.nativeCommands,
          eq(
            schema.nativeCommands.operationId,
            schema.nativeCommandTurns.operationId,
          ),
        )
        .where(
          and(
            eq(schema.nativeCommandTurns.chatId, binding.chatId),
            eq(schema.nativeCommandTurns.threadId, binding.threadId),
            eq(schema.nativeCommandTurns.turnId, item.identity.turnId),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, binding.workerId),
          ),
        );
      const session = command
        ? nativeCommandSessionSchema.parse(command.command.identity)
        : null;
      await tx.insert(schema.chatMessages).values({
        id: message.id,
        chatId: binding.chatId,
        ...values,
        worktreeId: session?.placementId ?? binding.worktreeId,
        executionLaneId: command?.command.executionLaneId ?? null,
      });
    }
    await tx
      .update(schema.nativeHistoryItems)
      .set({
        revision: item.revision,
        state: item.state,
        payloadDigest,
        // Old source producers may omit archival evidence. Retain its explicit
        // original revision instead of clearing it or relabeling it as current.
        ...(item.evidence ? { protectedEvidence: item.evidence } : {}),
        turnOrdinal: item.order.turn,
        itemOrdinal: item.order.item,
        componentOrdinal: item.order.component,
      })
      .where(eq(schema.nativeHistoryItems.key, key));
  }
}
