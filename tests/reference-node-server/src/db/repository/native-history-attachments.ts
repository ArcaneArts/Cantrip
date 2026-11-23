import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type {
  NativeHistoryBinding,
  NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";

/** Metadata comes from the worker that actually retained the protected bytes.
 * References to existing attachments do not claim a new local file replica. */
export async function persistNativeHistoryAttachments(
  tx: RepositoryTransaction,
  binding: NativeHistoryBinding,
  item: NativeHistoryPreparedBatch["items"][number],
): Promise<void> {
  const referenced = new Set(item.message.classification.attachmentIds);
  const supplied = new Set<string>();
  for (const attachment of item.attachments) {
    if (
      attachment.chatId !== binding.chatId ||
      !referenced.has(attachment.id) ||
      supplied.has(attachment.id)
    )
      throw new NativeHistoryError("item-attachment-mismatch");
    supplied.add(attachment.id);
    const [existing] = await tx
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, attachment.id))
      .for("update");
    if (existing && existing.chatId !== binding.chatId)
      throw new NativeHistoryError("attachment-chat-mismatch");
    const values = {
      protectedMetadata: attachment.protectedMetadata,
      sizeBytes: attachment.sizeBytes,
      status: attachment.status,
    };
    if (!existing) {
      await tx.insert(schema.chatAttachments).values({
        id: attachment.id,
        chatId: binding.chatId,
        workerId: binding.workerId,
        ...values,
        createdAt: new Date(attachment.createdAt),
      });
    } else if (existing.status !== "ready" && attachment.status === "ready") {
      // Actual file recovery can improve a failed placeholder. Stale failed
      // observations below cannot downgrade a ready attachment or its replica.
      await tx
        .update(schema.chatAttachments)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.chatAttachments.id, attachment.id));
    } else if (
      attachment.status === "ready" &&
      (existing.sizeBytes !== values.sizeBytes ||
        !isDeepStrictEqual(
          existing.protectedMetadata,
          values.protectedMetadata,
        ))
    ) {
      throw new NativeHistoryError("attachment-content-conflict");
    }
    if (attachment.status === "ready") {
      await tx
        .insert(schema.chatAttachmentReplicas)
        .values({
          attachmentId: attachment.id,
          workerId: binding.workerId,
          status: "ready",
        })
        .onConflictDoUpdate({
          target: [
            schema.chatAttachmentReplicas.attachmentId,
            schema.chatAttachmentReplicas.workerId,
          ],
          set: {
            status: "ready",
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }
  }
  for (const id of referenced) {
    if (supplied.has(id)) continue;
    const [existing] = await tx
      .select({ id: schema.chatAttachments.id })
      .from(schema.chatAttachments)
      .where(
        and(
          eq(schema.chatAttachments.id, id),
          eq(schema.chatAttachments.chatId, binding.chatId),
        ),
      );
    if (!existing)
      throw new NativeHistoryError("referenced-attachment-unavailable");
  }
}
