import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TunnelAttachmentCreateResult } from "@cantrip/protocol";

import { createTunnelAttachment, deleteTunnelAttachment } from "@/lib/api";
import { getActiveServerUrl } from "@/lib/server-connections";

const clientIdStorageKey = "cantrip.desktop-tunnel-client.v1";

export interface DesktopTunnelForwardSummary {
  attachmentId: string;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  tunnelId: string;
}

export interface StartDesktopTunnelOptions {
  preferredLocalPort?: number;
}

export function desktopTunnelAvailable(): boolean {
  return isTauri();
}

export function desktopTunnelClientId(storage: Storage): string {
  const existing = storage.getItem(clientIdStorageKey);
  if (existing && existing.length <= 200) return existing;
  const clientId = crypto.randomUUID();
  storage.setItem(clientIdStorageKey, clientId);
  return clientId;
}

function nativeStartRequest(
  attachment: TunnelAttachmentCreateResult,
  clientId: string,
  preferredLocalPort?: number,
) {
  return {
    attachmentId: attachment.attachmentId,
    clientId,
    connectPath: attachment.connectPath,
    expiresAt: attachment.expiresAt,
    preferredLocalPort: preferredLocalPort ?? null,
    secret: attachment.secret,
    secretExpiresAtEpochMs: new Date(attachment.secretExpiresAt).getTime(),
    serverUrl: getActiveServerUrl(),
    tunnelId: attachment.tunnelId,
  };
}

export async function startDesktopTunnel(
  tunnelId: string,
  options: StartDesktopTunnelOptions = {},
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri()) {
    throw new Error(
      "Local tunnel attachments are only available in the desktop app.",
    );
  }
  const clientId = desktopTunnelClientId(window.localStorage);
  const attachment = await createTunnelAttachment(tunnelId, { clientId });
  const request = nativeStartRequest(
    attachment,
    clientId,
    options.preferredLocalPort,
  );
  try {
    const started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    request.secret = "";
    attachment.secret = "";
    return started;
  } catch (error) {
    request.secret = "";
    attachment.secret = "";
    await deleteTunnelAttachment(attachment.attachmentId).catch(() => {
      // Preserve the native bind/connection error if best-effort cleanup fails.
    });
    throw error;
  }
}

export async function stopDesktopTunnel(
  tunnelId: string,
  attachmentId: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("stop_tunnel_forward", { tunnelId }).catch(() => {
      // Server revocation remains authoritative if the local listener is gone.
    });
  }
  await deleteTunnelAttachment(attachmentId);
}

export async function listDesktopTunnels(): Promise<
  DesktopTunnelForwardSummary[]
> {
  return isTauri()
    ? invoke<DesktopTunnelForwardSummary[]>("list_tunnel_forwards")
    : [];
}
