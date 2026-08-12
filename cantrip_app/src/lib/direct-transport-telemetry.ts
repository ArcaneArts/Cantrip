import { useEffect } from "react";

import { recordDirectAttachmentTelemetry } from "@/lib/api";
import {
  desktopTunnelAvailable,
  listDesktopTunnels,
} from "@/lib/desktop-tunnel";

const REPORT_INTERVAL_MS = 10_000;

export async function reportDesktopDirectTransportTelemetry(): Promise<void> {
  const forwards = await listDesktopTunnels();
  await Promise.all(
    forwards
      .filter(
        (forward) =>
          forward.routeState === "local-direct" &&
          Boolean(forward.directCapabilityId),
      )
      .map((forward) =>
        recordDirectAttachmentTelemetry(forward.directCapabilityId!, {
          bytesFromLocal: forward.bytesFromLocal ?? 0,
          bytesToLocal: forward.bytesToLocal ?? 0,
          connectionsClosed: forward.connectionsClosed ?? 0,
          connectionsOpened: forward.connectionsOpened ?? 0,
        }).catch(() => undefined),
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
