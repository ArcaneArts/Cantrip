import { isTauri } from "@tauri-apps/api/core";

const CODEX_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,500}$/u;

export function codexThreadUrl(threadId: string): string {
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("Codex returned an invalid thread identifier.");
  }
  return `codex://threads/${threadId}`;
}

export async function openCodexThread(threadId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("Opening Codex requires the Cantrip desktop app.");
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(codexThreadUrl(threadId));
}
