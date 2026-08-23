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
const DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS = 2_000;
const directCapabilityRetirements = new Map<string, Promise<void>>();

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
  lastDestinationRejectionCode?: DesktopTunnelDestinationRejectionCode | null;
  tunnelId: string;
  bytesFromLocal?: number;
  bytesToLocal?: number;
  connectionsClosed?: number;
  connectionsOpened?: number;
  destinationRejectedCount?: number;
}

interface DesktopTunnelTerminalSnapshot {
  attachmentId: string;
  tunnelId: string;
  directCapabilityId: string | null;
  lastDestinationRejectionCode?: DesktopTunnelDestinationRejectionCode | null;
  bytesFromLocal: number;
  bytesToLocal: number;
  connectionsClosed: number;
  connectionsOpened: number;
}

export type DesktopTunnelDestinationRejectionCode =
  | "congested"
  | "limit-exceeded"
  | "protected-endpoint-unavailable"
  | "protected-record-unavailable"
  | "protected-target-invalid"
  | "protocol-error"
  | "target-rejected"
  | "target-unavailable"
  | "unauthorized";

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

export async function forceDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
  options: { signal?: AbortSignal } = {},
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri() || !forward.relayFallbackAvailable) {
    throw new Error("The desktop tunnel has no relay fallback.");
  }
  options.signal?.throwIfAborted();
  const relayed = await raceWithAbort(
    invoke<DesktopTunnelForwardSummary | null>("force_tunnel_forward_relay", {
      tunnelId: forward.tunnelId,
    }),
    options.signal,
  );
  options.signal?.throwIfAborted();
  if (!relayed || relayed.routeState !== "relayed") {
    throw new Error("The desktop tunnel could not switch to its relay.");
  }
  if (
    forward.directCapabilityId &&
    relayed.directCapabilityId === forward.directCapabilityId
  ) {
    await retireDirectCapabilityAndConfirm(forward, relayed);
    return { ...relayed, directCapabilityId: null };
  }
  return relayed;
}

async function retireDirectCapabilityAndConfirm(
  forward: DesktopTunnelForwardSummary,
  snapshot: DesktopTunnelForwardSummary,
): Promise<void> {
  const capabilityId = forward.directCapabilityId;
  if (!capabilityId) return;
  const existing = directCapabilityRetirements.get(capabilityId);
  if (existing) return existing;
  const retirement = (async () => {
    await retireDirectCapability(capabilityId, snapshot);
    const confirmed = await invoke<boolean>(
      "confirm_tunnel_forward_direct_retired",
      {
        directCapabilityId: capabilityId,
        tunnelId: forward.tunnelId,
      },
    );
    if (!confirmed) {
      throw new Error("The desktop tunnel stopped during direct retirement.");
    }
  })();
  directCapabilityRetirements.set(capabilityId, retirement);
  try {
    await retirement;
  } finally {
    if (directCapabilityRetirements.get(capabilityId) === retirement) {
      directCapabilityRetirements.delete(capabilityId);
    }
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function retireDirectCapability(
  capabilityId: string,
  snapshot: DesktopTunnelForwardSummary,
): Promise<void> {
  const retirementSignal = AbortSignal.timeout(
    DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS,
  );
  await recordDirectAttachmentTelemetry(
    capabilityId,
    {
      bytesFromLocal: snapshot.bytesFromLocal ?? 0,
      bytesToLocal: snapshot.bytesToLocal ?? 0,
      connectionsClosed: snapshot.connectionsClosed ?? 0,
      connectionsOpened: snapshot.connectionsOpened ?? 0,
      ...(snapshot.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: snapshot.lastDestinationRejectionCode,
          }
        : {}),
    },
    { signal: retirementSignal },
  ).catch(() => undefined);
  await deleteDirectAttachment(capabilityId, {
    signal: AbortSignal.timeout(DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS),
  });
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
      ...(snapshot.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: snapshot.lastDestinationRejectionCode,
          }
        : {}),
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
