import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forceDesktopTunnelRelay: vi.fn(),
  listDesktopTunnels: vi.fn(),
  recordDirectAttachmentTelemetry: vi.fn(),
  refreshDesktopTunnelRelay: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  recordDirectAttachmentTelemetry: mocks.recordDirectAttachmentTelemetry,
}));
vi.mock("@/lib/desktop-tunnel", () => ({
  desktopTunnelAvailable: () => true,
  forceDesktopTunnelRelay: mocks.forceDesktopTunnelRelay,
  listDesktopTunnels: mocks.listDesktopTunnels,
  refreshDesktopTunnelRelay: mocks.refreshDesktopTunnelRelay,
}));

import { reportDesktopDirectTransportTelemetry } from "./direct-transport-telemetry";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forceDesktopTunnelRelay.mockResolvedValue(undefined);
  mocks.recordDirectAttachmentTelemetry.mockResolvedValue(undefined);
  mocks.refreshDesktopTunnelRelay.mockResolvedValue(true);
});

describe("reportDesktopDirectTransportTelemetry", () => {
  it("renews relay credentials and retires direct state after autonomous degradation", async () => {
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

    expect(mocks.recordDirectAttachmentTelemetry).not.toHaveBeenCalled();
    expect(mocks.refreshDesktopTunnelRelay).toHaveBeenCalledWith(forward);
    expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledWith(forward);
    expect(
      mocks.refreshDesktopTunnelRelay.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mocks.forceDesktopTunnelRelay.mock.invocationCallOrder[0]!);
  });

  it("reports direct counters without forcing a healthy direct route", async () => {
    const forward = {
      attachmentId: "attachment-1",
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
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
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
  });
});
