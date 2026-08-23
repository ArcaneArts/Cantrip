import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DirectTunnelTicket,
  TunnelAttachmentCreateResult,
} from "@cantrip/protocol";

import {
  activateDirectTunnelAttachment,
  createDirectTunnelAttachment,
  createTunnelAttachment,
  deleteDirectAttachment,
  deleteTunnelAttachment,
  getTunnelDataProtection,
  recordDirectAttachmentTelemetry,
} from "@/lib/api";
import { getActiveServerUrl } from "@/lib/server-connections";

const clientIdStorageKey = "cantrip.desktop-tunnel-client.v1";
const FINAL_TELEMETRY_TIMEOUT_MS = 2_000;

export interface DesktopTunnelForwardSummary {
  attachmentId: string;
  diagnosticTraceId: string | null;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  routeState: "local-direct" | "relayed" | "degraded";
  relayFallbackAvailable?: boolean;
  directCapabilityId: string | null;
  directFallbackReason: string | null;
  tunnelId: string;
  bytesFromLocal?: number;
  bytesToLocal?: number;
  connectionsClosed?: number;
  connectionsOpened?: number;
}

interface DesktopTunnelTerminalSnapshot {
  attachmentId: string;
  tunnelId: string;
  directCapabilityId: string | null;
  bytesFromLocal: number;
  bytesToLocal: number;
  connectionsClosed: number;
  connectionsOpened: number;
}

export interface StartDesktopTunnelOptions {
  diagnosticTraceId?: string;
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
  dataProtection: Awaited<ReturnType<typeof getTunnelDataProtection>>,
  diagnosticTraceId?: string,
  preferredLocalPort?: number,
) {
  return {
    attachmentId: attachment.attachmentId,
    clientId,
    diagnosticTraceId: diagnosticTraceId ?? null,
    dataProtection,
    direct,
    expiresAt: attachment.expiresAt,
    preferredLocalPort: preferredLocalPort ?? null,
    relay: {
      connectPath: attachment.connectPath,
      secret: attachment.secret,
      secretExpiresAtEpochMs: new Date(attachment.secretExpiresAt).getTime(),
      serverUrl: getActiveServerUrl(),
    },
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
  const dataProtection = await getTunnelDataProtection(tunnelId);
  const attachment = await createTunnelAttachment(tunnelId, { clientId });
  const direct = await createDirectTunnelAttachment(attachment.attachmentId, {
    diagnosticTraceId: options.diagnosticTraceId,
  }).catch(() => null);
  const request = nativeStartRequest(
    attachment,
    clientId,
    direct,
    dataProtection,
    options.diagnosticTraceId,
    options.preferredLocalPort,
  );
  try {
    const started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    request.relay.secret = "";
    if (request.direct) request.direct.secret = "";
    request.dataProtection.key = "";
    attachment.secret = "";
    if (started.routeState === "local-direct") {
      if (!started.directCapabilityId) {
        throw new Error(
          "The local direct tunnel omitted its capability identity.",
        );
      }
      await activateDirectTunnelAttachment(attachment.attachmentId, {
        capabilityId: started.directCapabilityId,
      });
    } else if (direct) {
      await deleteDirectAttachment(direct.binding.capabilityId).catch(() => {
        // The relayed tunnel remains usable if best-effort capability cleanup fails.
      });
    }
    return started;
  } catch (error) {
    request.relay.secret = "";
    if (request.direct) request.direct.secret = "";
    request.dataProtection.key = "";
    attachment.secret = "";
    await stopDesktopTunnelForward(tunnelId).catch(() => {
      // Server revocation below remains authoritative.
    });
    await deleteTunnelAttachment(attachment.attachmentId).catch(() => {
      // Preserve the native bind/connection error if best-effort cleanup fails.
    });
    throw error;
  }
}

export async function startDirectDesktopTunnel(
  ticket: DirectTunnelTicket,
  expiresAt: string,
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri()) {
    throw new Error(
      "Local direct tunnel attachments are only available in the desktop app.",
    );
  }
  const request = {
    attachmentId: ticket.route.attachmentId,
    clientId: desktopTunnelClientId(window.localStorage),
    diagnosticTraceId: null,
    direct: ticket,
    expiresAt,
    preferredLocalPort: null,
    relay: null,
    tunnelId: ticket.route.tunnelId,
  };
  try {
    const started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    if (started.routeState !== "local-direct") {
      throw new Error("The worker is not available on this device.");
    }
    return started;
  } finally {
    request.direct.secret = "";
    ticket.secret = "";
  }
}

export async function stopDesktopTunnel(
  tunnelId: string,
  attachmentId: string,
): Promise<void> {
  await stopDesktopTunnelForward(tunnelId);
  await deleteTunnelAttachment(attachmentId);
}

export async function stopDesktopTunnelForward(
  tunnelId: string,
): Promise<void> {
  if (!isTauri()) return;
  const snapshot = await invoke<DesktopTunnelTerminalSnapshot | null>(
    "stop_tunnel_forward",
    { tunnelId },
  ).catch(() => {
    // Server revocation remains authoritative if the local listener is gone.
    return null;
  });
  await reportFinalDesktopTunnelTelemetry(snapshot).catch(() => undefined);
}

async function reportFinalDesktopTunnelTelemetry(
  snapshot: DesktopTunnelTerminalSnapshot | null,
): Promise<void> {
  if (!snapshot?.directCapabilityId) return;
  await recordDirectAttachmentTelemetry(
    snapshot.directCapabilityId,
    {
      bytesFromLocal: snapshot.bytesFromLocal,
      bytesToLocal: snapshot.bytesToLocal,
      connectionsClosed: snapshot.connectionsClosed,
      connectionsOpened: snapshot.connectionsOpened,
    },
    {
      signal: AbortSignal.timeout(FINAL_TELEMETRY_TIMEOUT_MS),
    },
  );
}

export async function listDesktopTunnels(): Promise<
  DesktopTunnelForwardSummary[]
> {
  return isTauri()
    ? invoke<DesktopTunnelForwardSummary[]>("list_tunnel_forwards")
    : [];
}

export async function refreshDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
): Promise<boolean> {
  if (!isTauri() || !forward.relayFallbackAvailable) return false;
  const attachment = await createTunnelAttachment(forward.tunnelId, {
    clientId: desktopTunnelClientId(window.localStorage),
  });
  if (attachment.attachmentId !== forward.attachmentId) {
    attachment.secret = "";
    throw new Error("The refreshed tunnel attachment identity did not match.");
  }
  const relay = {
    connectPath: attachment.connectPath,
    secret: attachment.secret,
    secretExpiresAtEpochMs: new Date(attachment.secretExpiresAt).getTime(),
    serverUrl: getActiveServerUrl(),
  };
  try {
    const accepted = await invoke<boolean>("refresh_tunnel_forward_relay", {
      expiresAt: attachment.expiresAt,
      relay,
      tunnelId: forward.tunnelId,
    });
    if (!accepted) {
      await deleteTunnelAttachment(attachment.attachmentId).catch(() => {
        // The forward disappeared while its relay credential was rotating.
      });
    }
    return accepted;
  } finally {
    relay.secret = "";
    attachment.secret = "";
  }
}
