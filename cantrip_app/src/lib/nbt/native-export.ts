import { invoke } from "@tauri-apps/api/core";
import type { OpenNbtExportSink } from "./export-copy";

/** Native code owns the picker and destination. The renderer receives only a
 * random, window-bound stream token, never permission to submit an OS path. */
export const openNativeNbtExport: OpenNbtExportSink = async (name, signal) => {
  const id = await invoke<string | null>("begin_nbt_export", {
    suggestedName: name,
  });
  if (!id) return null;
  let size = 0,
    closed = false;
  const cancel = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", aborted);
    await invoke("cancel_nbt_export", { id });
  };
  const aborted = () => {
    void cancel().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    await cancel();
    signal.throwIfAborted();
  }
  return {
    completion: "Exported copy. The original draft is retained.",
    async write(bytes) {
      if (closed) throw new Error("The native NBT export is closed.");
      const next = await invoke<number>("write_nbt_export", bytes, {
        headers: {
          "x-cantrip-export": id,
          "x-cantrip-offset": String(size),
        },
      });
      if (next !== size + bytes.length)
        throw new Error("The native NBT export offset changed.");
      size = next;
    },
    async close(receipt) {
      if (closed) throw new Error("The native NBT export is closed.");
      await invoke("finish_nbt_export", { id, ...receipt });
      closed = true;
      signal.removeEventListener("abort", aborted);
    },
    abort: cancel,
  };
};
