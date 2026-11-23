import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "@cantrip/nbt/recovery";
import type { NbtByteSource } from "@cantrip/nbt";
import type { NbtRecoveryVault } from "./recovery";

/** Reinterpret a recovered local File without a desktop picker or worker file
 * path. The parser pins these encoded bytes in its encrypted paged cache, so a
 * successful replacement may retire the previous journal safely. */
export async function openRecoveredNbtSource(
  vault: NbtRecoveryVault,
  signal?: AbortSignal,
) {
  let context: NbtRecoveryVault | undefined = vault,
    journal: NbtRecoveryJournal | undefined,
    source: NbtByteSource | undefined,
    unsubscribe = () => {},
    closed = false,
    closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const check = () => {
    signal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (closed || !context) throw new Error("The local NBT source is closed.");
    context.assertCurrent();
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error("The local NBT source is closed."));
    unsubscribe();
    signal?.removeEventListener("abort", abort);
    source = undefined;
    context = undefined;
    const previous = journal;
    journal = undefined;
    return (closing = (async () => {
      await previous?.close();
    })());
  };
  const abort = () => {
    void close().catch(() => {});
  };
  try {
    check();
    journal = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(vault.id),
      vault.id,
      vault.key,
    );
    check();
    const descriptor = journal.descriptor();
    if (!descriptor)
      throw new Error(
        "The selected local NBT source is no longer in recovery. Select the file again.",
      );
    source = journal.source();
    unsubscribe = vault.onInvalidate(() => {
      try {
        check();
      } catch {
        abort();
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    check();
    return {
      size: descriptor.size,
      version: descriptor.version,
      retainOriginal: true as const,
      async read(offset: number, length: number, requestSignal?: AbortSignal) {
        check();
        requestSignal?.throwIfAborted();
        const bytes = await source!.read(
          offset,
          length,
          requestSignal
            ? AbortSignal.any([lifetime.signal, requestSignal])
            : lifetime.signal,
        );
        try {
          check();
          requestSignal?.throwIfAborted();
          return bytes;
        } catch (error) {
          bytes.fill(0);
          throw error;
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
