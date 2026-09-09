import {
  nativeHistoryArchivePageSchema,
  type NativeHistoryArchivePage,
  nativeHistoryTurnArchivePageSchema,
  type NativeHistoryTurnArchivePage,
} from "@cantrip/protocol";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import { openNativeHistoryItemEvidence } from "./native-history-item-content.js";
import { openNativeHistoryTurn } from "./native-history-turn-content.js";

/** Decrypt only an authenticated archive page. Older/missing evidence stays
 * explicitly distinguishable from the current canonical item revision. This
 * does not replace a local checkpoint or grant native execution authority. */
export async function openNativeHistoryArchivePage(input: {
  service: NativeHistoryEncryptionService;
  page: NativeHistoryArchivePage;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const page = nativeHistoryArchivePageSchema.parse(input.page);
  const items = [];
  for (const item of page.items) {
    input.signal?.throwIfAborted();
    const evidence = item.evidence;
    if (item.identity.threadId !== page.binding.threadId)
      throw new Error("Archived item belongs to another native thread.");
    items.push({
      ...item,
      sourceRevision: evidence?.revision ?? null,
      sourceCurrent: evidence?.revision === item.revision,
      source: evidence
        ? await openNativeHistoryItemEvidence({
            service: input.service,
            binding: {
              id: evidence.bindingId,
              workerId: evidence.workerId,
              chatId: page.binding.chatId,
              threadId: page.binding.threadId,
            },
            identity: item.identity,
            evidence,
          })
        : null,
    });
  }
  input.signal?.throwIfAborted();
  return { ...page, items };
}

/** Preserve all bound turn candidates. Binding-local revisions cannot establish
 * which of two workers observed a newer native state. Reconciliation owns that. */
export async function openNativeHistoryTurnArchivePage(input: {
  service: NativeHistoryEncryptionService;
  page: NativeHistoryTurnArchivePage;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const page = nativeHistoryTurnArchivePageSchema.parse(input.page);
  const turns = [];
  for (const entry of page.turns) {
    input.signal?.throwIfAborted();
    if (entry.turn.threadId !== page.binding.threadId)
      throw new Error("Archived turn belongs to another native thread.");
    turns.push({
      ...entry,
      source: await openNativeHistoryTurn({
        service: input.service,
        binding: {
          id: entry.bindingId,
          workerId: entry.workerId,
          chatId: page.binding.chatId,
          threadId: page.binding.threadId,
        },
        turn: entry.turn,
      }),
    });
  }
  input.signal?.throwIfAborted();
  return { ...page, turns };
}
