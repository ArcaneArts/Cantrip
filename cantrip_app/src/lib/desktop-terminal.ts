import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  createDirectTerminalAttachment,
  deleteDirectAttachment,
} from "@/lib/api";
import {
  desktopTunnelClientId,
  startDirectDesktopTunnel,
} from "@/lib/desktop-tunnel";

export interface DesktopTerminalConnection {
  capabilityId: string;
  tunnelId: string;
  url: string;
}

export async function startDirectDesktopTerminal(
  terminalId: string,
): Promise<DesktopTerminalConnection | null> {
  if (!isTauri()) return null;
  const ticket = await createDirectTerminalAttachment(
    terminalId,
    desktopTunnelClientId(window.localStorage),
  );
  const capabilityId = ticket.binding.capabilityId;
  const tunnelId = ticket.route.tunnelId;
  try {
    const forward = await startDirectDesktopTunnel(
      ticket,
      ticket.binding.leaseExpiresAt,
    );
    return {
      capabilityId,
      tunnelId,
      url: `ws://${forward.localHost}:${forward.localPort}/terminal`,
    };
  } catch (error) {
    await deleteDirectAttachment(capabilityId).catch(() => undefined);
    throw error;
  }
}

export async function stopDirectDesktopTerminal(
  connection: DesktopTerminalConnection,
): Promise<void> {
  if (isTauri()) {
    await invoke("stop_tunnel_forward", {
      tunnelId: connection.tunnelId,
    }).catch(() => undefined);
  }
  await deleteDirectAttachment(connection.capabilityId).catch(() => undefined);
}
