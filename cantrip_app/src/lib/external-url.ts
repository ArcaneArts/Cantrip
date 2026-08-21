import { Capacitor } from "@capacitor/core";

function safeExternalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS links can be opened externally.");
  }
  return url.toString();
}

export async function openExternalUrl(value: string): Promise<void> {
  const url = safeExternalUrl(value);
  if (Capacitor.isNativePlatform()) {
    const { AppLauncher } = await import("@capacitor/app-launcher");
    const { completed } = await AppLauncher.openUrl({ url });
    if (!completed) throw new Error("The device did not open this link.");
    return;
  }
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("The browser blocked the new tab.");
}
