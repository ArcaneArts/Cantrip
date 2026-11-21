import { createHash } from "node:crypto";
import {
  nativeHistoryBatchArchivePageSchema,
  type NativeHistoryBatchArchivePage,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import { openNativeHistoryItemEvidence } from "./native-history-item-content.js";
import { openNativeHistoryTurn } from "./native-history-turn-content.js";

// Matches the server's content digest across JSONB key reordering. This is an
// integrity check of an authenticated response, not a signature or input ACK.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function nativeHistoryBatchPayloadDigest(
  batch: NativeHistoryPreparedBatch,
  previousDigest: string | null,
) {
  return createHash("sha256")
    .update(stableJson({ batch, previousDigest }))
    .digest("hex");
}

export function validateNativeHistoryBatchArchivePage(
  raw: NativeHistoryBatchArchivePage,
) {
  const page = nativeHistoryBatchArchivePageSchema.parse(raw);
  for (const entry of page.batches) {
    const batch = entry.batch;
    if (!batch) continue;
    const actual = nativeHistoryBatchPayloadDigest(batch, entry.previousDigest);
    if (
      actual !== entry.payloadDigest ||
      batch.items.some(
        (item) =>
          item.identity.threadId !== page.binding.threadId ||
          item.attachments.some(
            (attachment) => attachment.chatId !== page.binding.chatId,
          ) ||
          (item.evidence &&
            (item.evidence.bindingId !== entry.bindingId ||
              item.evidence.workerId !== entry.workerId)),
      ) ||
      batch.turns.some((turn) => turn.threadId !== page.binding.threadId)
    )
      throw new Error(
        "Native history returned an unrelated or inconsistent batch archive page.",
      );
  }
  return page;
}

/** Accepted batches preserve candidates that were not selected for presentation.
 * Missing historical source remains null. This does not select a revision winner
 * or replace the local projector checkpoint. Call only with authenticated pages. */
export async function openNativeHistoryBatchArchivePage(input: {
  service: NativeHistoryEncryptionService;
  page: NativeHistoryBatchArchivePage;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const page = validateNativeHistoryBatchArchivePage(input.page);
  const batches = [];
  for (const entry of page.batches) {
    input.signal?.throwIfAborted();
    const binding = {
      id: entry.bindingId,
      workerId: entry.workerId,
      chatId: page.binding.chatId,
      threadId: page.binding.threadId,
    };
    const batch = entry.batch;
    const items = [];
    const turns = [];
    if (batch) {
      for (const item of batch.items) {
        input.signal?.throwIfAborted();
        items.push({
          ...item,
          source: item.evidence
            ? await openNativeHistoryItemEvidence({
                service: input.service,
                binding,
                identity: item.identity,
                evidence: item.evidence,
              })
            : null,
        });
      }
      for (const turn of batch.turns) {
        input.signal?.throwIfAborted();
        turns.push({
          ...turn,
          source: await openNativeHistoryTurn({
            service: input.service,
            binding,
            turn,
          }),
        });
      }
    }
    batches.push({ ...entry, source: batch ? { items, turns } : null });
  }
  input.signal?.throwIfAborted();
  return { ...page, batches };
}
