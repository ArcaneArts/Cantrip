import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDesktopTunnels: vi.fn(),
  recordDirectAttachmentTelemetry: vi.fn(),
  refreshDesktopTunnelRelay: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  recordDirectAttachmentTelemetry: mocks.recordDirectAttachmentTelemetry,
}));
vi.mock("@/lib/desktop-tunnel", () => ({
  desktopTunnelAvailable: () => true,
  listDesktopTunnels: mocks.listDesktopTunnels,
  refreshDesktopTunnelRelay: mocks.refreshDesktopTunnelRelay,
}));

import { reportDesktopDirectTransportTelemetry } from "./direct-transport-telemetry";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordDirectAttachmentTelemetry.mockResolvedValue(undefined);
  mocks.refreshDesktopTunnelRelay.mockResolvedValue(true);
});

describe("reportDesktopDirectTransportTelemetry", () => {
  it("renews a relay credential after a local direct route degrades", async () => {
    const forward = {
      attachmentId: "attachment-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "degraded",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      directFallbackReason: null,
      tunnelId: "tunnel-1",
      bytesFromLocal: 10,
      bytesToLocal: 20,
      connectionsClosed: 1,
      connectionsOpened: 1,
    } as const;
    mocks.listDesktopTunnels.mockResolvedValue([forward]);

    await reportDesktopDirectTransportTelemetry();

    expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledWith(
      "capability-1",
      expect.objectContaining({ bytesFromLocal: 10, bytesToLocal: 20 }),
    );
    expect(mocks.refreshDesktopTunnelRelay).toHaveBeenCalledWith(forward);
  });
});
