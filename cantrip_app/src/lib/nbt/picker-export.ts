import type { NbtExportSink } from "./export-copy";

export interface NbtSavePicker {
  (options: { suggestedName: string }): Promise<{
    createWritable(): Promise<FileSystemWritableFileStream>;
  }>;
}

/** The picker must be invoked directly from the user action. Opening, writing,
 * committing and cancelling use the actual API results, never quota estimates. */
export async function openPickerNbtExport(
  picker: NbtSavePicker,
  name: string,
  signal: AbortSignal,
): Promise<NbtExportSink | null> {
  let handle: Awaited<ReturnType<NbtSavePicker>>;
  try {
    handle = await picker({ suggestedName: name });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return null;
    throw error;
  }
  signal.throwIfAborted();
  const writer = await handle.createWritable();
  let closed = false;
  const abort = async (reason: unknown) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", aborted);
    await writer.abort(reason);
  };
  const aborted = () => {
    void abort(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    await abort(signal.reason);
    signal.throwIfAborted();
  }
  return {
    completion: "Exported copy. The original draft is retained.",
    async write(bytes) {
      if (closed) throw new Error("The local NBT export is closed.");
      const copy = bytes.slice();
      try {
        await writer.write(copy.buffer);
      } finally {
        copy.fill(0);
      }
    },
    async close() {
      if (closed) throw new Error("The local NBT export is closed.");
      await writer.close();
      closed = true;
      signal.removeEventListener("abort", aborted);
    },
    abort,
  };
}
