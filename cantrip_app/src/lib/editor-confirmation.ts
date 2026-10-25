import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";

/** Use the supported message command, not the legacy window.confirm shim. */
export async function confirmEditorAction(message: string): Promise<boolean> {
  if (isTauri()) return confirm(message, { title: "Unsaved changes" });
  return await window.confirm(message);
}
