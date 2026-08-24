import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forceDesktopTunnelRelay: vi.fn(),
  listDesktopTunnels: vi.fn(),
  recordDirectAttachmentTelemetry: vi.fn(),
  refreshDesktopTunnelRelay: vi.fn(),
  renewTunnelAttachmentLease: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  recordDirectAttachmentTelemetry: mocks.recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease: mocks.renewTunnelAttachmentLease,
}));
vi.mock("@/lib/desktop-tunnel", () => ({
  desktopTunnelAvailable: () => true,
  forceDesktopTunnelRelay: mocks.forceDesktopTunnelRelay,
  listDesktopTunnels: mocks.listDesktopTunnels,
  refreshDesktopTunnelRelay: mocks.refreshDesktopTunnelRelay,
}));

import {
  relayCredentialRenewalMarginMs,
  reportDesktopDirectTransportTelemetry,
} from "./direct-transport-telemetry";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  mocks.forceDesktopTunnelRelay.mockResolvedValue(undefined);
  mocks.recordDirectAttachmentTelemetry.mockResolvedValue(undefined);
  mocks.refreshDesktopTunnelRelay.mockResolvedValue(true);
  mocks.renewTunnelAttachmentLease.mockResolvedValue(undefined);
});

describe("reportDesktopDirectTransportTelemetry", () => {
  it("keeps each tunnel renewal margin stable and bounded", () => {
    const first = relayCredentialRenewalMarginMs("tunnel-1");

    expect(first).toBeGreaterThanOrEqual(30_000);
    expect(first).toBeLessThanOrEqual(40_000);
    expect(relayCredentialRenewalMarginMs("tunnel-1")).toBe(first);
    expect(relayCredentialRenewalMarginMs("tunnel-2")).not.toBe(first);
  });

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
    expect(mocks.renewTunnelAttachmentLease).toHaveBeenCalledWith(
      "attachment-1",
      { signal: expect.any(AbortSignal) },
    );
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
      relayCredentialExpiresAtEpochMs: Date.now() + 40_001,
      directCapabilityId: "capability-1",
      tunnelId: "tunnel-1",
      bytesFromLocal: 10,
      bytesToLocal: 20,
      connectionsClosed: 1,
      connectionsOpened: 1,
      lastDestinationRejectionCode: "protected-endpoint-unavailable",
    } as const;
    mocks.listDesktopTunnels.mockResolvedValue([forward]);

    await reportDesktopDirectTransportTelemetry();

    expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledWith(
      "capability-1",
      expect.objectContaining({
        bytesFromLocal: 10,
        bytesToLocal: 20,
        lastDestinationRejectionCode: "protected-endpoint-unavailable",
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.refreshDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.renewTunnelAttachmentLease).not.toHaveBeenCalled();
  });

  it("renews a healthy direct relay credential shortly before expiry", async () => {
    const forward = {
      attachmentId: "attachment-1",
      routeState: "local-direct",
      relayFallbackAvailable: true,
      relayCredentialExpiresAtEpochMs: Date.now() + 29_999,
      directCapabilityId: "capability-1",
      tunnelId: "tunnel-1",
    } as const;
    mocks.listDesktopTunnels.mockResolvedValue([forward]);

    await reportDesktopDirectTransportTelemetry();

    expect(mocks.refreshDesktopTunnelRelay).toHaveBeenCalledWith(forward);
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.renewTunnelAttachmentLease).not.toHaveBeenCalled();
  });

  it("does not rotate a healthy relayed credential", async () => {
    const forward = {
      attachmentId: "attachment-1",
      routeState: "relayed",
      relayFallbackAvailable: true,
      relayCredentialExpiresAtEpochMs: Date.now() + 5_000,
      directCapabilityId: null,
      tunnelId: "tunnel-1",
    } as const;
    mocks.listDesktopTunnels.mockResolvedValue([forward]);

    await reportDesktopDirectTransportTelemetry();

    expect(mocks.refreshDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.renewTunnelAttachmentLease).toHaveBeenCalledWith(
      "attachment-1",
      { signal: expect.any(AbortSignal) },
    );
  });
});
