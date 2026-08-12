import { useEffect } from "react";

import { recordDirectAttachmentTelemetry } from "@/lib/api";
import {
  fallbackDirectDesktopProjectShare,
  listDirectDesktopProjectShares,
} from "@/lib/desktop-project-share";
import {
  desktopTunnelAvailable,
  listDesktopTunnels,
  refreshDesktopTunnelRelay,
} from "@/lib/desktop-tunnel";

const REPORT_INTERVAL_MS = 10_000;

export async function reportDesktopDirectTransportTelemetry(): Promise<void> {
  const forwards = await listDesktopTunnels();
  const forwardIds = new Set(forwards.map((forward) => forward.tunnelId));
  await Promise.all(
    forwards
      .filter((forward) => Boolean(forward.directCapabilityId))
      .map((forward) =>
        recordDirectAttachmentTelemetry(forward.directCapabilityId!, {
          bytesFromLocal: forward.bytesFromLocal ?? 0,
          bytesToLocal: forward.bytesToLocal ?? 0,
          connectionsClosed: forward.connectionsClosed ?? 0,
          connectionsOpened: forward.connectionsOpened ?? 0,
        }).catch(() => undefined),
      ),
  );
  await Promise.all(
    forwards
      .filter(
        (forward) =>
          forward.routeState === "degraded" && forward.relayFallbackAvailable,
      )
      .map((forward) => refreshDesktopTunnelRelay(forward).catch(() => false)),
  );
  const directProjectShares = await listDirectDesktopProjectShares();
  await Promise.all(
    directProjectShares
      .filter((tunnelId) => !forwardIds.has(tunnelId))
      .map((tunnelId) =>
        fallbackDirectDesktopProjectShare(tunnelId).catch(() => false),
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
