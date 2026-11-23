import { persistNativeHistoryMessageAttribution } from "./native-history-message-attribution.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  nativeHistoryIngestSchema,
  type NativeHistoryBinding,
  type NativeHistoryCommitReceipt,
  type NativeHistoryIngest,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import {
  NativeHistoryError,
  type NativeHistoryBindingRepository,
} from "./native-history-bindings.js";
import type { RepositoryTransaction } from "./database.js";
import { nativeHistoryPayloadDigest } from "./native-history-digest.js";
import { persistNativeHistoryTurns } from "./native-history-turns.js";
import { persistNativeHistoryMessages } from "./native-history-messages.js";
import {
  NativeHistoryBatchRejectionError,
  readNativeHistoryRejection,
  retainNativeHistoryRejection,
} from "./native-history-rejections.js";

function receipt(
  row: typeof schema.nativeHistoryReceipts.$inferSelect,
): NativeHistoryCommitReceipt {
  return {
    committed: true,
    streamId: row.streamId,
    sequence: row.sequence,
    recordId: row.recordId,
    digest: row.digest,
    commitId: row.commitId,
  };
}

/**
 * The canonical writer must validate mappings/revisions and persist all messages,
 * attachments and item ordering using the supplied transaction. No endpoint
 * may substitute a no-op callback and call the result a committed transcript.
 */
export class NativeHistoryIngestionRepository {
  constructor(private readonly bindings: NativeHistoryBindingRepository) {}

  /** Production entry point: callers cannot replace the canonical item writer. */
  ingest(
    ownerId: string,
    raw: NativeHistoryIngest,
  ): Promise<NativeHistoryCommitReceipt> {
    return this.commit(ownerId, raw, (tx, binding, batch) =>
      persistNativeHistoryMessages(tx, ownerId, binding, batch.items),
    );
  }

  async commit(
    ownerId: string,
    raw: NativeHistoryIngest,
    apply: (
      tx: RepositoryTransaction,
      binding: NativeHistoryBinding,
      batch: NativeHistoryPreparedBatch,
    ) => Promise<void>,
  ): Promise<NativeHistoryCommitReceipt> {
    const input = nativeHistoryIngestSchema.parse(raw);
    const contentDigest = nativeHistoryPayloadDigest({
      batch: input.batch,
      previousDigest: input.previousDigest,
    });
    const result = await this.bindings.withBinding(
      ownerId,
      input.workerId,
      input.chatId,
      input.bindingId,
      async (tx, binding) => {
        if (
          input.batch.items.some(
            ({ identity }) => identity.threadId !== binding.threadId,
          ) ||
          input.batch.turns.some((turn) => turn.threadId !== binding.threadId)
        )
          throw new NativeHistoryError("batch-thread-mismatch");
        const rejected = await readNativeHistoryRejection(
          tx,
          input,
          contentDigest,
        );
        if (rejected) return rejected;
        const [existingStream] = await tx
          .select()
          .from(schema.nativeHistoryStreams)
          .where(eq(schema.nativeHistoryStreams.bindingId, binding.id))
          .for("update");
        if (existingStream && existingStream.id !== input.streamId)
          throw new NativeHistoryError("stream-recovery-required");
        const [existing] = await tx
          .select()
          .from(schema.nativeHistoryReceipts)
          .where(
            and(
              eq(schema.nativeHistoryReceipts.streamId, input.streamId),
              eq(schema.nativeHistoryReceipts.sequence, input.sequence),
            ),
          );
        if (existing) {
          if (
            !existingStream ||
            existing.recordId !== input.recordId ||
            existing.digest !== input.digest ||
            existing.payloadDigest !== contentDigest
          )
            throw new NativeHistoryError("batch-receipt-conflict");
          return receipt(existing);
        }
        const previousSequence = existingStream?.acknowledgedSequence ?? 0;
        const previousDigest = existingStream?.acknowledgedDigest ?? null;
        if (
          input.sequence !== previousSequence + 1 ||
          input.previousDigest !== previousDigest
        )
          throw new NativeHistoryError("batch-sequence-conflict");
        const [sameRecord] = await tx
          .select()
          .from(schema.nativeHistoryReceipts)
          .where(
            and(
              eq(schema.nativeHistoryReceipts.streamId, input.streamId),
              eq(schema.nativeHistoryReceipts.recordId, input.recordId),
            ),
          );
        if (sameRecord) throw new NativeHistoryError("batch-record-reused");
        try {
          await tx.transaction(async (attempt) => {
            if (!existingStream)
              await attempt.insert(schema.nativeHistoryStreams).values({
                id: input.streamId,
                bindingId: binding.id,
              });
            await apply(attempt, binding, input.batch);
            await persistNativeHistoryTurns(
              attempt,
              ownerId,
              binding,
              input.batch.turns,
            );
            await persistNativeHistoryMessageAttribution(
              attempt,
              ownerId,
              binding,
              [
                ...input.batch.turns.map((turn) => turn.turnId),
                ...input.batch.items.map((item) => item.identity.turnId),
              ],
            );
          });
        } catch (error) {
          if (
            error instanceof NativeHistoryError &&
            (error.code === "item-revision-conflict" ||
              error.code === "turn-revision-conflict")
          )
            return retainNativeHistoryRejection(
              tx,
              input,
              contentDigest,
              error.code,
            );
          throw error;
        }
        const commitId = randomUUID();
        const saved = {
          commitId,
          streamId: input.streamId,
          sequence: input.sequence,
          recordId: input.recordId,
          digest: input.digest,
          payloadDigest: contentDigest,
          previousDigest: input.previousDigest,
          protectedBatch: input.batch,
        };
        await tx.insert(schema.nativeHistoryReceipts).values(saved);
        await tx
          .update(schema.nativeHistoryStreams)
          .set({
            acknowledgedSequence: input.sequence,
            acknowledgedDigest: input.digest,
          })
          .where(eq(schema.nativeHistoryStreams.id, input.streamId));
        // Publication is independent of the commit response. A failed publish
        // cannot invalidate this ACK or require repeating the canonical mutation.
        await tx
          .insert(schema.nativeHistoryPublications)
          .values({ commitId, bindingId: binding.id });
        return {
          committed: true as const,
          streamId: saved.streamId,
          sequence: saved.sequence,
          recordId: saved.recordId,
          digest: saved.digest,
          commitId,
        };
      },
    );
    // Throw only after the rejection transaction commits, so a lost response
    // cannot turn a later retry into a canonical write.
    if ("rejected" in result)
      throw new NativeHistoryBatchRejectionError(result);
    return result;
  }
}
