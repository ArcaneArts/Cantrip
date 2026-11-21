import { setTimeout as delay } from "node:timers/promises";
import {
  nativeHistoryBindingSchema,
  type NativeHistoryBinding,
} from "@cantrip/protocol";
import { CantripServerRequestError } from "./cli-client.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import {
  openNativeHistoryArchivePage,
  openNativeHistoryTurnArchivePage,
} from "./native-history-archive.js";
import { openNativeHistoryBatchArchivePage } from "./native-history-batch-archive.js";

interface Options {
  binding: NativeHistoryBinding;
  client: Pick<
    NativeHistoryClient,
    "archive" | "archiveTurns" | "archiveBatches"
  >;
  service: NativeHistoryEncryptionService;
  signal?: AbortSignal;
  pageSize?: number;
  batchPageSize?: number;
  /** Notification of an actual committed-head change, not a readiness probe. */
  onRetry?(attempt: number): void;
}

type ArchivePage = {
  binding: NativeHistoryBinding;
  snapshotId: string;
  nextCursor: object | null;
};

/** Read one coherent, authenticated recovery snapshot without dispatching native
 * input or advancing any local checkpoint. All pages are pinned to the same
 * committed heads. A head change discards the partial read and retries; other
 * failures propagate to the owning recovery pump. Missing source remains explicit.
 * Item revisions are canonical; turn and batch revisions remain binding-local
 * observations and cannot be compared to choose a different worker's winner. */
export async function readNativeHistoryRecovery(options: Options) {
  const binding = nativeHistoryBindingSchema.parse(options.binding);
  const scope = { chatId: binding.chatId, bindingId: binding.id };
  let attempts = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      let snapshotId: string | undefined;
      async function collect<P extends ArchivePage>(
        read: (
          cursor: P["nextCursor"] | null,
          snapshotId?: string,
        ) => Promise<P>,
      ): Promise<P[]> {
        const pages: P[] = [];
        let cursor: P["nextCursor"] | null = null;
        do {
          options.signal?.throwIfAborted();
          const page = await read(cursor, snapshotId);
          options.signal?.throwIfAborted();
          if (
            page.binding.id !== binding.id ||
            page.binding.chatId !== binding.chatId ||
            page.binding.threadId !== binding.threadId ||
            page.binding.workerId !== binding.workerId ||
            (snapshotId && page.snapshotId !== snapshotId)
          )
            throw new Error(
              "Native history recovery returned an unrelated or inconsistent snapshot.",
            );
          snapshotId = page.snapshotId;
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor);
        return pages;
      }
      const itemPages = await collect<
        Awaited<ReturnType<NativeHistoryClient["archive"]>>
      >((cursor, snapshotId) =>
        options.client.archive(
          { ...scope, cursor, snapshotId, limit: options.pageSize },
          options.signal,
        ),
      );
      const turnPages = await collect<
        Awaited<ReturnType<NativeHistoryClient["archiveTurns"]>>
      >((cursor, snapshotId) =>
        options.client.archiveTurns(
          { ...scope, cursor, snapshotId, limit: options.pageSize },
          options.signal,
        ),
      );
      const batchPages = await collect<
        Awaited<ReturnType<NativeHistoryClient["archiveBatches"]>>
      >((cursor, snapshotId) =>
        options.client.archiveBatches(
          { ...scope, cursor, snapshotId, limit: options.batchPageSize },
          options.signal,
        ),
      );
      // Delay decryption until all resources have a coherent snapshot. Repeated
      // writes cannot cause partial plaintext recovery to escape to the caller.
      const items = [];
      const turns = [];
      const batches = [];
      for (const page of itemPages) {
        options.signal?.throwIfAborted();
        items.push(
          ...(
            await openNativeHistoryArchivePage({
              service: options.service,
              signal: options.signal,
              page,
            })
          ).items,
        );
      }
      for (const page of turnPages) {
        options.signal?.throwIfAborted();
        turns.push(
          ...(
            await openNativeHistoryTurnArchivePage({
              service: options.service,
              signal: options.signal,
              page,
            })
          ).turns,
        );
      }
      for (const page of batchPages) {
        options.signal?.throwIfAborted();
        batches.push(
          ...(
            await openNativeHistoryBatchArchivePage({
              service: options.service,
              signal: options.signal,
              page,
            })
          ).batches,
        );
      }
      options.signal?.throwIfAborted();
      return { binding, snapshotId: snapshotId!, items, turns, batches };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        !(error instanceof CantripServerRequestError) ||
        error.status !== 409 ||
        error.code !== "archive-snapshot-changed"
      )
        throw error;
      try {
        options.onRetry?.(++attempts);
      } catch {
        /* Reporting cannot stop recovery. */
      }
      options.signal?.throwIfAborted();
      // Yield between actual conflicting reads without imposing an execution or
      // recovery time limit. Stop can always cancel this delay and every fetch.
      await delay(100, undefined, { signal: options.signal });
    }
  }
}

export type NativeHistoryRecoverySnapshot = Awaited<
  ReturnType<typeof readNativeHistoryRecovery>
>;
