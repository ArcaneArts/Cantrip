import { useEffect } from "react";

import {
  recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease,
} from "@/lib/api";
import {
  desktopTunnelAvailable,
  forceDesktopTunnelRelay,
  listDesktopTunnels,
  refreshDesktopTunnelRelay,
} from "@/lib/desktop-tunnel";

const REPORT_INTERVAL_MS = 10_000;
const RELAY_CREDENTIAL_RENEWAL_MARGIN_MS = 30_000;
const RELAY_CREDENTIAL_RENEWAL_JITTER_MS = 10_000;

export function relayCredentialRenewalMarginMs(tunnelId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < tunnelId.length; index += 1) {
    hash ^= tunnelId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (
    RELAY_CREDENTIAL_RENEWAL_MARGIN_MS +
    ((hash >>> 0) % (RELAY_CREDENTIAL_RENEWAL_JITTER_MS + 1))
  );
}

function relayCredentialRefreshDue(
  forward: Awaited<ReturnType<typeof listDesktopTunnels>>[number],
): boolean {
  if (!forward.relayFallbackAvailable) return false;
  if (forward.routeState === "degraded") return true;
  if (forward.routeState !== "local-direct") return false;
  const expiresAt = forward.relayCredentialExpiresAtEpochMs;
  return (
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now() + relayCredentialRenewalMarginMs(forward.tunnelId)
  );
}

export async function reportDesktopDirectTransportTelemetry(): Promise<void> {
  const forwards = await listDesktopTunnels();
  const directTelemetryForwards = forwards.filter(
    (forward) =>
      Boolean(forward.directCapabilityId) &&
      (forward.routeState === "local-direct" ||
        !forward.relayFallbackAvailable),
  );
  const directTelemetryAttachments = new Set(
    directTelemetryForwards.map((forward) => forward.attachmentId),
  );
  await Promise.all(
    directTelemetryForwards.map((forward) =>
      recordDirectAttachmentTelemetry(forward.directCapabilityId!, {
        bytesFromLocal: forward.bytesFromLocal ?? 0,
        bytesToLocal: forward.bytesToLocal ?? 0,
        connectionsClosed: forward.connectionsClosed ?? 0,
        connectionsOpened: forward.connectionsOpened ?? 0,
        ...(forward.lastDestinationRejectionCode
          ? {
              lastDestinationRejectionCode:
                forward.lastDestinationRejectionCode,
            }
          : {}),
      }).catch(() => undefined),
    ),
  );
  await Promise.all(
    forwards
      .filter(
        (forward) => !directTelemetryAttachments.has(forward.attachmentId),
      )
      .map((forward) =>
        renewTunnelAttachmentLease(forward.attachmentId).catch(() => undefined),
      ),
  );
  await Promise.all(
    forwards
      .filter(relayCredentialRefreshDue)
      .map((forward) => refreshDesktopTunnelRelay(forward).catch(() => false)),
  );
  await Promise.all(
    forwards
      .filter(
        (forward) =>
          Boolean(forward.directCapabilityId) &&
          forward.routeState !== "local-direct" &&
          forward.relayFallbackAvailable,
      )
      .map((forward) =>
        forceDesktopTunnelRelay(forward).catch(() => undefined),
      ),
  );
}

export function useDesktopDirectTransportTelemetry(): void {
  useEffect(() => {
    if (!desktopTunnelAvailable()) return;
    let reporting = false;
    const report = async () => {
      if (reporting) return;
      reporting = true;
      await reportDesktopDirectTransportTelemetry().catch(() => undefined);
      reporting = false;
    };
    void report();
    const timer = window.setInterval(() => void report(), REPORT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
