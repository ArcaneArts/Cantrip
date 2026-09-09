import { z } from "zod";
import {
  nativeHistoryCommitReceiptSchema,
  nativeHistoryPreparedBatchSchema,
} from "@cantrip/protocol";
import type { NativeHistoryRecoverySnapshot } from "./native-history-recovery.js";
import { nativeHistoryBatchPayloadDigest } from "./native-history-batch-archive.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeHistoryOutboxBaselineSchema = z.array(
  z
    .object({
      receipt: nativeHistoryCommitReceiptSchema,
      previousDigest: digest.nullable(),
      payloadDigest: digest,
    })
    .strict(),
);
export type NativeHistoryOutboxBaseline = z.infer<
  typeof nativeHistoryOutboxBaselineSchema
>;
export type NativeHistoryOutboxRecovery = Pick<
  NativeHistoryRecoverySnapshot,
  "binding" | "batches"
>;

export function validateNativeHistoryOutboxBaseline(
  raw: unknown,
  streamId: string,
): NativeHistoryOutboxBaseline {
  const entries = nativeHistoryOutboxBaselineSchema.parse(raw);
  const records = new Set<string>();
  const commits = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.receipt.streamId !== streamId ||
      entry.receipt.sequence !== index + 1 ||
      entry.previousDigest !== (entries[index - 1]?.receipt.digest ?? null) ||
      records.has(entry.receipt.recordId) ||
      commits.has(entry.receipt.commitId)
    )
      throw new Error(
        "Recovered native history receipts have a gap or conflicting identity.",
      );
    records.add(entry.receipt.recordId);
    commits.add(entry.receipt.commitId);
  }
  return entries;
}

/** Only call with an authenticated complete archive read. A baseline contains
 * server receipts and content digests, never reconstructed batch ciphertext. */
export function prepareNativeHistoryOutboxBaseline(
  recovery: NativeHistoryOutboxRecovery,
  scope: {
    chatId: string;
    bindingId: string;
    workerId: string;
  },
) {
  if (
    recovery.binding.id !== scope.bindingId ||
    recovery.binding.chatId !== scope.chatId ||
    recovery.binding.workerId !== scope.workerId
  )
    throw new Error(
      "Native history outbox recovery belongs to a different binding.",
    );
  const selected = recovery.batches.filter(
    (entry) => entry.bindingId === scope.bindingId,
  );
  const entries = selected.map((entry, index) => {
    const previousDigest = selected[index - 1]?.receipt.digest ?? null;
    if (
      entry.workerId !== scope.workerId ||
      (entry.batch &&
        (entry.previousDigest !== previousDigest ||
          nativeHistoryBatchPayloadDigest(
            nativeHistoryPreparedBatchSchema.parse(entry.batch),
            previousDigest,
          ) !== entry.payloadDigest))
    )
      throw new Error(
        "Recovered native history batch content does not match its receipt.",
      );
    // Old receipts may lack the retained batch/predecessor column. The preceding
    // committed receipt still establishes the stream chain, and the server's
    // stored payload digest can verify a surviving local projection stage.
    return {
      receipt: entry.receipt,
      previousDigest,
      payloadDigest: entry.payloadDigest,
    };
  });
  const streamId = entries[0]?.receipt.streamId;
  return streamId
    ? {
        streamId,
        entries: validateNativeHistoryOutboxBaseline(entries, streamId),
      }
    : null;
}

export function verifyNativeHistoryRecoveredBody(
  entry: NativeHistoryOutboxBaseline[number],
  body: string,
) {
  const batch = nativeHistoryPreparedBatchSchema.parse(JSON.parse(body));
  if (
    nativeHistoryBatchPayloadDigest(batch, entry.previousDigest) !==
    entry.payloadDigest
  )
    throw new Error(
      "Recovered native history receipt belongs to different batch content.",
    );
}
