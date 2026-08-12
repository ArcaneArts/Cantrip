import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TunnelAttachmentCreateResult } from "@cantrip/protocol";

import {
  activateDirectTunnelAttachment,
  createDirectTunnelAttachment,
  createTunnelAttachment,
  deleteDirectAttachment,
  deleteTunnelAttachment,
} from "@/lib/api";
import { getActiveServerUrl } from "@/lib/server-connections";

const clientIdStorageKey = "cantrip.desktop-tunnel-client.v1";

export interface DesktopTunnelForwardSummary {
  attachmentId: string;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  routeState: "local-direct" | "relayed";
  directCapabilityId: string | null;
  directFallbackReason: string | null;
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
  direct: Awaited<ReturnType<typeof createDirectTunnelAttachment>> | null,
  preferredLocalPort?: number,
) {
  return {
    attachmentId: attachment.attachmentId,
    clientId,
    connectPath: attachment.connectPath,
    direct,
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
  const direct = await createDirectTunnelAttachment(
    attachment.attachmentId,
  ).catch(() => null);
  const request = nativeStartRequest(
    attachment,
    clientId,
    direct,
    options.preferredLocalPort,
  );
  try {
    const started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    request.secret = "";
    if (request.direct) request.direct.secret = "";
    attachment.secret = "";
    if (started.routeState === "local-direct") {
      if (!started.directCapabilityId) {
        throw new Error(
          "The local direct tunnel omitted its capability identity.",
        );
      }
      await activateDirectTunnelAttachment(attachment.attachmentId, {
        capabilityId: started.directCapabilityId,
        localPort: started.localPort,
      });
    } else if (direct) {
      await deleteDirectAttachment(direct.binding.capabilityId).catch(() => {
        // The relayed tunnel remains usable if best-effort capability cleanup fails.
      });
    }
    return started;
  } catch (error) {
    request.secret = "";
    if (request.direct) request.direct.secret = "";
    attachment.secret = "";
    await invoke("stop_tunnel_forward", { tunnelId }).catch(() => {
      // Server revocation below remains authoritative.
    });
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
