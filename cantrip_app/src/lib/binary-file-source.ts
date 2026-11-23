import type { NbtByteSource } from "@cantrip/nbt";
import {
  BINARY_FILE_PAGE_BYTES,
  explorerBinaryPageSchema,
  type ExplorerBinaryPage,
} from "@cantrip/protocol/surface-stream";

export interface BinaryFileSource extends NbtByteSource {
  readonly size: number;
  readonly version: string;
  close(): void;
}
type ReadRange = (
  offset: number,
  limit: number,
  version: string | undefined,
  signal?: AbortSignal,
) => Promise<ExplorerBinaryPage>;
function bytes(page: ExplorerBinaryPage) {
  return Uint8Array.from(atob(page.data), (c) => c.charCodeAt(0));
}
/** The worker owns no persistent handle; close aborts in-flight protected reads. */
export async function openProtectedBinarySource(
  path: string,
  readRange: ReadRange,
  signal?: AbortSignal,
  assertCurrent: () => void = () => {},
): Promise<BinaryFileSource> {
  signal?.throwIfAborted();
  assertCurrent();
  const first = explorerBinaryPageSchema.parse(
    await readRange(0, 1, undefined, signal),
  );
  signal?.throwIfAborted();
  assertCurrent();
  if (first.path !== path || first.offset !== 0 || first.nextOffset > 1)
    throw new Error("Binary opening returned a different range.");
  const initial = bytes(first),
    active = new Set<AbortController>();
  first.data = "";
  let closed = false;
  const abort = () => close(signal?.reason);
  function close(reason: unknown = new Error("Binary file source is closed.")) {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    for (const controller of active) controller.abort(reason);
    initial.fill(0);
  }
  signal?.addEventListener("abort", abort, { once: true });
  return {
    size: first.size,
    version: first.version,
    close,
    async read(offset, length, requestSignal) {
      if (closed) throw new Error("Binary file source is closed.");
      assertCurrent();
      requestSignal?.throwIfAborted();
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > BINARY_FILE_PAGE_BYTES ||
        !Number.isSafeInteger(offset + length)
      )
        throw new Error("Invalid binary byte range.");
      if (offset >= first.size || length === 0) return new Uint8Array(0);
      if (offset === 0 && length <= initial.length)
        return initial.slice(0, length);
      const controller = new AbortController(),
        cancel = () => controller.abort(requestSignal?.reason);
      requestSignal?.addEventListener("abort", cancel, { once: true });
      active.add(controller);
      try {
        const page = explorerBinaryPageSchema.parse(
          await readRange(
            offset,
            Math.min(length, first.size - offset),
            first.version,
            controller.signal,
          ),
        );
        controller.signal.throwIfAborted();
        assertCurrent();
        if (closed) throw new Error("Binary file source is closed.");
        if (
          page.path !== path ||
          page.offset !== offset ||
          page.version !== first.version ||
          page.size !== first.size ||
          page.nextOffset - offset > length
        )
          throw new Error("Binary range returned a different snapshot.");
        return bytes(page);
      } finally {
        active.delete(controller);
        requestSignal?.removeEventListener("abort", cancel);
      }
    },
  };
}
