import type { NbtDocumentClient } from "@cantrip/nbt/document";

export interface NbtExportReceipt {
  size: number;
  sha256: string;
}
export interface NbtExportSink {
  write(bytes: Uint8Array): Promise<void>;
  close(receipt: NbtExportReceipt): Promise<void>;
  abort(reason: unknown): Promise<void>;
  /** A browser download can acknowledge consumption, not OS disk durability. */
  completion: string;
}
export type OpenNbtExportSink = (
  name: string,
  signal: AbortSignal,
) => Promise<NbtExportSink | null>;

/** Export never acknowledges a document save: its recovery and dirty state stay
 * intact. Exactly one bounded write is outstanding, including during cancel. */
export async function exportNbtCopy(
  client: NbtDocumentClient,
  name: string,
  open: OpenNbtExportSink,
  signal: AbortSignal,
  progress?: (bytes: number) => void,
) {
  signal.throwIfAborted();
  const release = client.freezeEdits();
  let sink: NbtExportSink | null = null,
    iterator: ReturnType<NbtDocumentClient["serialize"]> | undefined,
    completed = false;
  try {
    // Called before the first await so native/browser pickers retain the click's
    // user activation. A cancelled picker does not start serialization.
    sink = await open(name, signal);
    signal.throwIfAborted();
    if (!sink) return null;
    iterator = client.serialize(true, signal);
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await iterator.next();
      if (part.done) {
        if (part.value.size !== size)
          throw new Error("The NBT export size changed during serialization.");
        await sink.close(part.value);
        signal.throwIfAborted();
        completed = true;
        return { ...part.value, message: sink.completion };
      }
      try {
        for (let at = 0; at < part.value.length; at += 256 * 1024) {
          signal.throwIfAborted();
          const bytes = part.value.subarray(at, at + 256 * 1024);
          await sink.write(bytes);
          size += bytes.length;
          progress?.(size);
        }
      } finally {
        part.value.fill(0);
      }
    }
  } finally {
    try {
      if (!completed) {
        await Promise.resolve()
          .then(() =>
            sink?.abort(signal.reason ?? new Error("NBT export stopped.")),
          )
          .catch(() => {});
        await iterator?.return({ size: 0, sha256: "" }).catch(() => {});
      }
    } finally {
      release();
    }
  }
}
