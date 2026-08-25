import { invoke, isTauri } from "@tauri-apps/api/core";

import type { DesktopWorkerStatus } from "@/lib/desktop-worker";
import { getActiveServerUrl } from "@/lib/server-connections";

function normalizedServerUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

export function chatFilesAreLocalToDesktop(
  workerId: string,
  serverUrl: string,
  desktopWorkers: readonly DesktopWorkerStatus[],
): boolean {
  const expectedServer = normalizedServerUrl(serverUrl);
  return desktopWorkers.some(
    (worker) =>
      worker.workerId === workerId &&
      normalizedServerUrl(worker.serverUrl) === expectedServer,
  );
}

export function desktopChatRevealLabel(
  desktopRuntime: boolean,
  userAgent: string,
): "Show in File Explorer" | "Show in Finder" | null {
  if (!desktopRuntime) return null;
  if (/Macintosh|Mac OS X/u.test(userAgent)) return "Show in Finder";
  if (/Windows/u.test(userAgent)) return "Show in File Explorer";
  return null;
}

export async function revealLocalChatScratch(input: {
  chatId: string;
  path: string;
  workerId: string;
}): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("reveal_local_chat_scratch", {
    request: {
      chatId: input.chatId,
      relativePath: input.path,
      serverUrl: getActiveServerUrl(),
      workerId: input.workerId,
    },
  });
}
