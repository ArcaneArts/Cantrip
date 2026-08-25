import { invoke, isTauri } from "@tauri-apps/api/core";
import type { StandaloneChatSummary } from "@cantrip/protocol";

import {
  createStandaloneChatNetworkShare,
  deleteProjectNetworkShare,
} from "@/lib/api";
import {
  coordinateDesktopProjectRevealPreference,
  directProjectShareUrl,
} from "@/lib/desktop-project-share";
import { startDesktopTunnel, stopDesktopTunnel } from "@/lib/desktop-tunnel";
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

export function chatScratchRevealUsesLocalFolder(
  local: boolean,
  networkShareAvailable: boolean,
  shiftKey: boolean,
): boolean {
  return local && (!networkShareAvailable || shiftKey);
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

export async function revealChatScratchInNativeFileManager(
  chat: StandaloneChatSummary,
  preferLocalFolder: boolean,
  relativePath: string,
): Promise<void> {
  if (!isTauri()) throw new Error("Native Chat file reveal is unavailable.");
  return coordinateDesktopProjectRevealPreference(preferLocalFolder, {
    revealLocalFolder: () =>
      chat.activeWorkerId
        ? revealLocalChatScratch({
            chatId: chat.id,
            path: relativePath,
            workerId: chat.activeWorkerId,
          })
        : Promise.resolve(false),
    revealNetworkShare: async () => {
      const attachment = await createStandaloneChatNetworkShare(chat);
      try {
        const forward = await startDesktopTunnel(attachment.attachmentId);
        try {
          await invoke("reveal_chat_share", {
            request: {
              attachmentId: attachment.attachmentId,
              chatId: chat.id,
              chatName: chat.title,
              mountLeaseMs: attachment.mountLeaseMs,
              password: attachment.password,
              relativePath,
              url: directProjectShareUrl(attachment, forward.localPort),
              username: attachment.username,
            },
          });
        } catch (error) {
          await stopDesktopTunnel(forward.tunnelId, forward.attachmentId).catch(
            () => undefined,
          );
          throw error;
        }
      } catch (error) {
        await deleteProjectNetworkShare(attachment.attachmentId).catch(
          () => undefined,
        );
        throw error;
      }
    },
  });
}
