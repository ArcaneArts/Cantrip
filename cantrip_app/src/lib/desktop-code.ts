import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CodeAttachment } from "@cantrip/protocol";

import { createDirectCodeAttachment, deleteDirectAttachment } from "@/lib/api";
import {
  desktopTunnelClientId,
  startDirectDesktopTunnel,
} from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  directHealthUrl: string | null;
  directTunnelId: string | null;
}

export async function preferDirectCodeAttachment(
  attachment: CodeAttachment,
): Promise<PreferredCodeAttachment> {
  if (!isTauri()) {
    return { attachment, directHealthUrl: null, directTunnelId: null };
  }
  const ticket = await createDirectCodeAttachment(
    attachment.attachmentId,
    desktopTunnelClientId(window.localStorage),
  );
  try {
    const forward = await startDirectDesktopTunnel(
      ticket,
      ticket.binding.leaseExpiresAt,
    );
    const url = new URL(
      `http://${forward.localHost}:${forward.localPort}/code/`,
    );
    return {
      attachment: { ...attachment, url: url.toString() },
      directHealthUrl: new URL("_cantrip/health", url).toString(),
      directTunnelId: forward.tunnelId,
    };
  } catch (error) {
    await deleteDirectAttachment(ticket.binding.capabilityId).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function stopDirectCodeAttachment(
  tunnelId: string | null,
): Promise<void> {
  if (!tunnelId || !isTauri()) return;
  await invoke("stop_tunnel_forward", { tunnelId }).catch(() => undefined);
}
