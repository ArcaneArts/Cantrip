import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  nativeHistoryBatchArchiveReadSchema,
  nativeHistoryBatchArchivePageSchema,
  type NativeHistoryBatchArchiveRead,
  nativeHistoryArchiveReadSchema,
  nativeHistoryArchivePageSchema,
  nativeHistoryTurnArchiveReadSchema,
  nativeHistoryTurnArchivePageSchema,
  chatAttachmentOpaqueSummarySchema,
  type NativeHistoryBinding,
  type NativeHistoryTurnArchiveRead,
  type NativeHistoryArchiveRead,
  type NativeHistoryArchivePage,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import {
  NativeHistoryError,
  type NativeHistoryBindingRepository,
} from "./native-history-bindings.js";
import { nativeHistoryPayloadDigest } from "./native-history-digest.js";

async function archiveSnapshot(
  tx: RepositoryTransaction,
  binding: NativeHistoryBinding,
  ownerId: string,
) {
  // Native item identities survive worker migration. Include all committed
  // streams for this chat/thread, not only the requesting worker's stream.
  const streams = await tx
    .select({
      id: schema.nativeHistoryStreams.id,
      sequence: schema.nativeHistoryStreams.acknowledgedSequence,
      digest: schema.nativeHistoryStreams.acknowledgedDigest,
    })
    .from(schema.nativeHistoryStreams)
    .innerJoin(
      schema.nativeHistoryBindings,
      eq(
        schema.nativeHistoryBindings.id,
        schema.nativeHistoryStreams.bindingId,
      ),
    )
    .where(
      and(
        eq(schema.nativeHistoryBindings.chatId, binding.chatId),
        eq(schema.nativeHistoryBindings.threadId, binding.threadId),
        eq(schema.nativeHistoryBindings.ownerId, ownerId),
      ),
    )
    .orderBy(asc(schema.nativeHistoryStreams.id));
  return nativeHistoryPayloadDigest([binding.id, streams]);
}
function assertSnapshot(
  snapshotId: string,
  input: { snapshotId?: string; cursor?: { snapshotId: string } | null },
) {
  if (
    (input.snapshotId && input.snapshotId !== snapshotId) ||
    (input.cursor && input.cursor.snapshotId !== snapshotId)
  )
    throw new NativeHistoryError("archive-snapshot-changed");
}

/** Read committed opaque archives under the same ownership/transaction boundary
 * as ingestion. Pagination never acquires execution authority or consumes history. */
export class NativeHistoryArchiveRepository {
  constructor(private readonly bindings: NativeHistoryBindingRepository) {}

  read(
    ownerId: string,
    raw: NativeHistoryArchiveRead,
  ): Promise<NativeHistoryArchivePage> {
    const input = nativeHistoryArchiveReadSchema.parse(raw);
    return this.bindings.withBinding(
      ownerId,
      input.workerId,
      input.chatId,
      input.bindingId,
      async (tx, binding) => {
        const snapshotId = await archiveSnapshot(tx, binding, ownerId);
        assertSnapshot(snapshotId, input);
        const rows = await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(
            and(
              eq(schema.nativeHistoryItems.chatId, binding.chatId),
              eq(schema.nativeHistoryItems.threadId, binding.threadId),
              gt(schema.nativeHistoryItems.revision, 0),
              input.cursor
                ? gt(schema.nativeHistoryItems.key, input.cursor.key)
                : undefined,
            ),
          )
          .orderBy(asc(schema.nativeHistoryItems.key))
          .limit(input.limit + 1);
        const page = rows.slice(0, input.limit);
        const messages = page.length
          ? await tx
              .select({
                id: schema.chatMessages.id,
                attachmentIds: schema.chatMessages.attachmentIds,
              })
              .from(schema.chatMessages)
              .where(
                and(
                  eq(schema.chatMessages.chatId, binding.chatId),
                  inArray(
                    schema.chatMessages.id,
                    page.map((row) => row.messageId),
                  ),
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
                  eq(schema.chatAttachments.chatId, binding.chatId),
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
        const references = (messageId: string) => {
          const ids = messageAttachments.get(messageId);
          if (!ids)
            throw new NativeHistoryError("archived-message-unavailable");
          return ids.map((id) => {
            const descriptor = descriptors.get(id);
            if (!descriptor)
              throw new NativeHistoryError("referenced-attachment-unavailable");
            return descriptor;
          });
        };
        return nativeHistoryArchivePageSchema.parse({
          binding,
          snapshotId,
          items: page.map((row) => ({
            key: row.key,
            identity: {
              threadId: row.threadId,
              turnId: row.turnId,
              itemId: row.itemId,
              component: row.component,
              identityKind: row.identityKind,
            },
            messageId: row.messageId,
            attachments: references(row.messageId),
            revision: row.revision,
            state: row.state,
            order: {
              turn: row.turnOrdinal,
              item: row.itemOrdinal,
              component: row.componentOrdinal,
            },
            evidence: row.protectedEvidence,
          })),
          nextCursor:
            rows.length > input.limit
              ? { snapshotId, key: page.at(-1)!.key }
              : null,
        });
      },
    );
  }
  readTurns(ownerId: string, raw: NativeHistoryTurnArchiveRead) {
    const input = nativeHistoryTurnArchiveReadSchema.parse(raw);
    return this.bindings.withBinding(
      ownerId,
      input.workerId,
      input.chatId,
      input.bindingId,
      async (tx, binding) => {
        const snapshotId = await archiveSnapshot(tx, binding, ownerId);
        assertSnapshot(snapshotId, input);
        const cursor = input.cursor;
        // Cursor order must not depend on the database installation's locale.
        const sourceBinding = sql<string>`${schema.nativeHistoryTurns.bindingId} COLLATE "C"`;
        const sourceTurn = sql<string>`${schema.nativeHistoryTurns.turnId} COLLATE "C"`;
        const rows = await tx
          .select({
            workerId: schema.nativeHistoryBindings.workerId,
            source: schema.nativeHistoryTurns,
          })
          .from(schema.nativeHistoryTurns)
          .innerJoin(
            schema.nativeHistoryBindings,
            eq(
              schema.nativeHistoryBindings.id,
              schema.nativeHistoryTurns.bindingId,
            ),
          )
          .where(
            and(
              eq(schema.nativeHistoryBindings.ownerId, ownerId),
              eq(schema.nativeHistoryBindings.chatId, binding.chatId),
              eq(schema.nativeHistoryBindings.threadId, binding.threadId),
              cursor
                ? or(
                    gt(sourceBinding, cursor.bindingId),
                    and(
                      eq(sourceBinding, cursor.bindingId),
                      gt(sourceTurn, cursor.turnId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(sourceBinding), asc(sourceTurn))
          .limit(input.limit + 1);
        const page = rows.slice(0, input.limit);
        const last = page.at(-1)?.source;
        return nativeHistoryTurnArchivePageSchema.parse({
          binding,
          snapshotId,
          turns: page.map(({ source, workerId }) => ({
            bindingId: source.bindingId,
            workerId,
            turn: {
              threadId: binding.threadId,
              turnId: source.turnId,
              revision: source.revision,
              ordinal: source.ordinal,
              status: source.status,
              startedAtMs: source.startedAtMs,
              completedAtMs: source.completedAtMs,
              metadata: source.metadata,
            },
          })),
          nextCursor:
            rows.length > input.limit && last
              ? { snapshotId, bindingId: last.bindingId, turnId: last.turnId }
              : null,
        });
      },
    );
  }
  readBatches(ownerId: string, raw: NativeHistoryBatchArchiveRead) {
    const input = nativeHistoryBatchArchiveReadSchema.parse(raw);
    return this.bindings.withBinding(
      ownerId,
      input.workerId,
      input.chatId,
      input.bindingId,
      async (tx, binding) => {
        const snapshotId = await archiveSnapshot(tx, binding, ownerId);
        assertSnapshot(snapshotId, input);
        const cursor = input.cursor;
        const stream = sql<string>`${schema.nativeHistoryReceipts.streamId} COLLATE "C"`;
        const rows = await tx
          .select({
            bindingId: schema.nativeHistoryBindings.id,
            workerId: schema.nativeHistoryBindings.workerId,
            source: schema.nativeHistoryReceipts,
          })
          .from(schema.nativeHistoryReceipts)
          .innerJoin(
            schema.nativeHistoryStreams,
            eq(
              schema.nativeHistoryStreams.id,
              schema.nativeHistoryReceipts.streamId,
            ),
          )
          .innerJoin(
            schema.nativeHistoryBindings,
            eq(
              schema.nativeHistoryBindings.id,
              schema.nativeHistoryStreams.bindingId,
            ),
          )
          .where(
            and(
              eq(schema.nativeHistoryBindings.ownerId, ownerId),
              eq(schema.nativeHistoryBindings.chatId, binding.chatId),
              eq(schema.nativeHistoryBindings.threadId, binding.threadId),
              cursor
                ? or(
                    gt(stream, cursor.streamId),
                    and(
                      eq(stream, cursor.streamId),
                      gt(
                        schema.nativeHistoryReceipts.sequence,
                        cursor.sequence,
                      ),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(stream), asc(schema.nativeHistoryReceipts.sequence))
          .limit(input.limit + 1);
        const page = rows.slice(0, input.limit);
        const last = page.at(-1)?.source;
        return nativeHistoryBatchArchivePageSchema.parse({
          binding,
          snapshotId,
          batches: page.map(({ bindingId, workerId, source }) => ({
            bindingId,
            workerId,
            receipt: {
              committed: true,
              commitId: source.commitId,
              streamId: source.streamId,
              sequence: source.sequence,
              recordId: source.recordId,
              digest: source.digest,
            },
            payloadDigest: source.payloadDigest,
            previousDigest: source.previousDigest,
            batch: source.protectedBatch,
          })),
          nextCursor:
            rows.length > input.limit && last
              ? { snapshotId, streamId: last.streamId, sequence: last.sequence }
              : null,
        });
      },
    );
  }
}
