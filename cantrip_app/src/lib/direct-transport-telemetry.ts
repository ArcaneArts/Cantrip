import { useEffect } from "react";

import {
  recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease,
} from "@/lib/api";
import {
  desktopTunnelAvailable,
  forceDesktopTunnelRelay,
  listDesktopTunnelsWithOptions,
  refreshDesktopTunnelRelay,
} from "@/lib/desktop-tunnel";

const REPORT_INTERVAL_MS = 10_000;
const REPORT_REQUEST_TIMEOUT_MS = 7_500;
const RELAY_CREDENTIAL_RENEWAL_MARGIN_MS = 30_000;
const RELAY_CREDENTIAL_RENEWAL_JITTER_MS = 10_000;
const transportMaintenance = new Map<string, Promise<void>>();

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
  forward: Awaited<ReturnType<typeof listDesktopTunnelsWithOptions>>[number],
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
  const forwards = await listDesktopTunnelsWithOptions({
    signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
  });
  const directTelemetryForwards = forwards.filter(
    (forward) =>
      Boolean(forward.directCapabilityId) &&
      (forward.routeState === "local-direct" ||
        !forward.relayFallbackAvailable),
  );
  const directTelemetryAttachments = new Set(
    directTelemetryForwards.map((forward) => forward.attachmentId),
  );
  await Promise.all([
    ...directTelemetryForwards.map((forward) =>
      recordDirectAttachmentTelemetry(
        forward.directCapabilityId!,
        {
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
        },
        {
          signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
        },
      ).catch(() => undefined),
    ),
    ...forwards
      .filter(
        (forward) => !directTelemetryAttachments.has(forward.attachmentId),
      )
      .map((forward) =>
        renewTunnelAttachmentLease(forward.attachmentId, {
          signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
        }).catch(() => undefined),
      ),
  ]);
  for (const forward of forwards) scheduleTransportMaintenance(forward);
}

async function maintainTransport(
  forward: Awaited<ReturnType<typeof listDesktopTunnelsWithOptions>>[number],
): Promise<void> {
  if (relayCredentialRefreshDue(forward)) {
    await refreshDesktopTunnelRelay(forward, {
      signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
    }).catch(() => false);
  }
  if (
    forward.directCapabilityId &&
    forward.routeState !== "local-direct" &&
    forward.relayFallbackAvailable
  ) {
    await forceDesktopTunnelRelay(forward, {
      signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}

function scheduleTransportMaintenance(
  forward: Awaited<ReturnType<typeof listDesktopTunnelsWithOptions>>[number],
): void {
  if (transportMaintenance.has(forward.tunnelId)) return;
  let maintenance!: Promise<void>;
  maintenance = maintainTransport(forward)
    .catch(() => undefined)
    .finally(() => {
      if (transportMaintenance.get(forward.tunnelId) === maintenance) {
        transportMaintenance.delete(forward.tunnelId);
      }
    });
  transportMaintenance.set(forward.tunnelId, maintenance);
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
