import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateDirectTunnelAttachment: vi.fn(),
  createDirectTunnelAttachment: vi.fn(),
  createTunnelAttachment: vi.fn(),
  deleteDirectAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
  getTunnelDataProtection: vi.fn(),
  recordDirectAttachmentTelemetry: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));
vi.mock("@/lib/api", () => ({
  activateDirectTunnelAttachment: mocks.activateDirectTunnelAttachment,
  createDirectTunnelAttachment: mocks.createDirectTunnelAttachment,
  createTunnelAttachment: mocks.createTunnelAttachment,
  deleteDirectAttachment: mocks.deleteDirectAttachment,
  deleteTunnelAttachment: mocks.deleteTunnelAttachment,
  getTunnelDataProtection: mocks.getTunnelDataProtection,
  recordDirectAttachmentTelemetry: mocks.recordDirectAttachmentTelemetry,
}));
vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: () => "https://cantrip.example",
}));

import {
  forceDesktopTunnelRelay,
  refreshDesktopTunnelRelay,
  startDesktopTunnel,
  startDirectDesktopTunnel,
  stopDesktopTunnel,
} from "./desktop-tunnel";

const capabilityId = "1c4066d8-5798-4330-82e2-f5634c6176b7";
const expiresAt = "2099-01-01T00:00:00.000Z";

function directTicket() {
  return {
    broker: {
      available: true as const,
      protocol: "ws-v1" as const,
      loopbackHost: "127.0.0.1" as const,
      loopbackPort: 43_123,
      instanceId: "8d0a19a8-26f9-4f20-bff0-87242d1b280c",
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
    binding: {
      capabilityId,
      ownerId: "owner-1",
      authSessionId: "session-1",
      workerId: "worker-1",
      resourceKind: "tunnel" as const,
      resourceId: "tunnel-1",
      attachmentId: "attachment-1",
      channels: ["tunnel-data"],
      expiresAt,
      leaseExpiresAt: expiresAt,
    },
    route: {
      tunnelId: "tunnel-1",
      attachmentId: "attachment-1",
      sourceEndpointId: "desktop:client:attachment-1",
      destinationEndpointId: "worker:worker-1",
    },
    secret: "d".repeat(43),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.createTunnelAttachment.mockResolvedValue({
    attachmentId: "attachment-1",
    tunnelId: "tunnel-1",
    secret: "s".repeat(43),
    connectPath: "/api/tunnel-attachments/attachment-1/connect",
    secretExpiresAt: expiresAt,
    expiresAt,
  });
  mocks.activateDirectTunnelAttachment.mockResolvedValue(undefined);
  mocks.deleteDirectAttachment.mockResolvedValue(undefined);
  mocks.deleteTunnelAttachment.mockResolvedValue(undefined);
  mocks.getTunnelDataProtection.mockResolvedValue({
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    key: "k".repeat(43),
  });
  mocks.recordDirectAttachmentTelemetry.mockResolvedValue(undefined);
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

describe("startDesktopTunnel", () => {
  it("activates a verified local-direct attachment", async () => {
    mocks.createDirectTunnelAttachment.mockResolvedValue(directTicket());
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "local-direct",
      directCapabilityId: capabilityId,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    });

    await expect(
      startDesktopTunnel("tunnel-1", {
        diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toMatchObject({ routeState: "local-direct" });
    expect(mocks.createDirectTunnelAttachment).toHaveBeenCalledWith(
      "attachment-1",
      { diagnosticTraceId: "33333333-3333-4333-8333-333333333333" },
    );
    expect(mocks.activateDirectTunnelAttachment).toHaveBeenCalledWith(
      "attachment-1",
      { capabilityId },
    );
    expect(mocks.invoke).toHaveBeenCalledWith("start_tunnel_forward", {
      request: expect.objectContaining({
        diagnosticTraceId: expect.any(String),
      }),
    });
  });

  it("keeps the relay usable when a local capability cannot be prepared", async () => {
    mocks.createDirectTunnelAttachment.mockRejectedValue(
      new Error("worker is elsewhere"),
    );
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "relayed",
      directCapabilityId: capabilityId,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    });

    await expect(startDesktopTunnel("tunnel-1")).resolves.toMatchObject({
      routeState: "relayed",
    });
    expect(mocks.activateDirectTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
  });

  it("starts a capability-only local listener without relay credentials", async () => {
    const direct = directTicket();
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "local-direct",
      directCapabilityId: capabilityId,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    });

    await expect(
      startDirectDesktopTunnel(direct, expiresAt),
    ).resolves.toMatchObject({ routeState: "local-direct" });
    expect(mocks.invoke).toHaveBeenCalledWith("start_tunnel_forward", {
      request: expect.objectContaining({
        diagnosticTraceId: null,
        relay: null,
      }),
    });
    expect(direct.secret).toBe("");
  });
});

describe("stopDesktopTunnel", () => {
  it("stops locally before posting the exact terminal snapshot and deleting", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "stop_tunnel_forward") {
        return {
          attachmentId: "attachment-1",
          bytesFromLocal: 11,
          bytesToLocal: 12,
          connectionsClosed: 2,
          connectionsOpened: 2,
          directCapabilityId: capabilityId,
          tunnelId: "tunnel-1",
        };
      }
      return true;
    });

    await stopDesktopTunnel("tunnel-1", "attachment-1");

    expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledWith(
      capabilityId,
      {
        bytesFromLocal: 11,
        bytesToLocal: 12,
        connectionsClosed: 2,
        connectionsOpened: 2,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.invoke).toHaveBeenCalledWith("stop_tunnel_forward", {
      tunnelId: "tunnel-1",
    });
    expect(mocks.invoke.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.recordDirectAttachmentTelemetry.mock.invocationCallOrder[0]!,
    );
    expect(
      mocks.recordDirectAttachmentTelemetry.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mocks.deleteTunnelAttachment.mock.invocationCallOrder[0]!);
  });

  it("keeps repeated native stops idempotent without reporting stale counters", async () => {
    mocks.invoke.mockResolvedValue(null);

    await stopDesktopTunnel("tunnel-1", "attachment-1");

    expect(mocks.invoke).toHaveBeenCalledWith("stop_tunnel_forward", {
      tunnelId: "tunnel-1",
    });
    expect(mocks.recordDirectAttachmentTelemetry).not.toHaveBeenCalled();
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith("attachment-1");
  });
});

describe("forceDesktopTunnelRelay", () => {
  it("waits for bounded direct telemetry and revocation after native relay selection", async () => {
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "relayed",
      relayFallbackAvailable: true,
      directCapabilityId: capabilityId,
      directFallbackReason: "connected-route-unusable",
      tunnelId: "tunnel-1",
      bytesFromLocal: 11,
      bytesToLocal: 12,
      connectionsClosed: 1,
      connectionsOpened: 1,
      lastDestinationRejectionCode: "protected-record-unavailable",
    });

    await expect(
      forceDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      }),
    ).resolves.toMatchObject({ routeState: "relayed" });

    expect(mocks.invoke).toHaveBeenCalledWith("force_tunnel_forward_relay", {
      tunnelId: "tunnel-1",
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "confirm_tunnel_forward_direct_retired",
      { directCapabilityId: capabilityId, tunnelId: "tunnel-1" },
    );
    expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledWith(
      capabilityId,
      {
        bytesFromLocal: 11,
        bytesToLocal: 12,
        connectionsClosed: 1,
        connectionsOpened: 1,
        lastDestinationRejectionCode: "protected-record-unavailable",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.deleteDirectAttachment).toHaveBeenCalledWith(capabilityId, {
      signal: expect.any(AbortSignal),
    });
    expect(
      mocks.recordDirectAttachmentTelemetry.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mocks.deleteDirectAttachment.mock.invocationCallOrder[0]!);
  });

  it("gives revocation a fresh deadline after telemetry exhausts its deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.invoke.mockImplementation(async (command: string) =>
        command === "confirm_tunnel_forward_direct_retired"
          ? true
          : {
              attachmentId: "attachment-1",
              expiresAt,
              localHost: "127.0.0.1",
              localPort: 41_234,
              routeState: "relayed",
              relayFallbackAvailable: true,
              directCapabilityId: capabilityId,
              directFallbackReason: "connected-route-unusable",
              tunnelId: "tunnel-1",
            },
      );
      mocks.recordDirectAttachmentTelemetry.mockImplementation(
        (_capabilityId, _counts, options: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              {
                once: true,
              },
            );
          }),
      );
      const pending = forceDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      const telemetrySignal = mocks.recordDirectAttachmentTelemetry.mock
        .calls[0]?.[2].signal as AbortSignal;
      const deletionSignal = mocks.deleteDirectAttachment.mock.calls[0]?.[1]
        .signal as AbortSignal;
      expect(telemetrySignal.aborted).toBe(true);
      expect(deletionSignal).not.toBe(telemetrySignal);
      expect(deletionSignal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear native identity when direct revocation fails", async () => {
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      routeState: "relayed",
      relayFallbackAvailable: true,
      directCapabilityId: capabilityId,
      tunnelId: "tunnel-1",
    });
    mocks.deleteDirectAttachment.mockRejectedValue(
      new Error("revocation failed"),
    );

    await expect(
      forceDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      }),
    ).rejects.toThrow("revocation failed");
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "confirm_tunnel_forward_direct_retired",
      expect.anything(),
    );
  });

  it("treats an already retired native capability as an idempotent success", async () => {
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-1",
      routeState: "relayed",
      relayFallbackAvailable: true,
      directCapabilityId: null,
      tunnelId: "tunnel-1",
    });

    await expect(
      forceDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      }),
    ).resolves.toMatchObject({ directCapabilityId: null });
    expect(mocks.recordDirectAttachmentTelemetry).not.toHaveBeenCalled();
    expect(mocks.deleteDirectAttachment).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "confirm_tunnel_forward_direct_retired",
      expect.anything(),
    );
  });

  it("does not retire or hide a replacement native capability", async () => {
    mocks.invoke.mockResolvedValue({
      attachmentId: "attachment-2",
      routeState: "relayed",
      relayFallbackAvailable: true,
      directCapabilityId: "replacement-capability",
      tunnelId: "tunnel-1",
    });

    await expect(
      forceDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      }),
    ).resolves.toMatchObject({
      directCapabilityId: "replacement-capability",
    });
    expect(mocks.recordDirectAttachmentTelemetry).not.toHaveBeenCalled();
    expect(mocks.deleteDirectAttachment).not.toHaveBeenCalled();
  });

  it("coalesces concurrent retirement for the same native capability", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "confirm_tunnel_forward_direct_retired"
        ? true
        : {
            attachmentId: "attachment-1",
            routeState: "relayed",
            relayFallbackAvailable: true,
            directCapabilityId: capabilityId,
            tunnelId: "tunnel-1",
          },
    );
    let releaseTelemetry: (() => void) | undefined;
    mocks.recordDirectAttachmentTelemetry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTelemetry = resolve;
        }),
    );
    const forward = {
      attachmentId: "attachment-1",
      diagnosticTraceId: null,
      expiresAt,
      localHost: "127.0.0.1" as const,
      localPort: 41_234,
      routeState: "local-direct" as const,
      relayFallbackAvailable: true,
      directCapabilityId: capabilityId,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    };

    const first = forceDesktopTunnelRelay(forward);
    const second = forceDesktopTunnelRelay(forward);
    await vi.waitFor(() =>
      expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledOnce(),
    );
    releaseTelemetry?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mocks.recordDirectAttachmentTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.deleteDirectAttachment).toHaveBeenCalledTimes(1);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "confirm_tunnel_forward_direct_retired",
      ),
    ).toHaveLength(1);
  });
});

describe("refreshDesktopTunnelRelay", () => {
  it("rotates the short-lived relay credential without replacing the listener", async () => {
    mocks.invoke.mockResolvedValue(true);

    await expect(
      refreshDesktopTunnelRelay({
        attachmentId: "attachment-1",
        diagnosticTraceId: null,
        expiresAt,
        localHost: "127.0.0.1",
        localPort: 41_234,
        routeState: "degraded",
        relayFallbackAvailable: true,
        directCapabilityId: capabilityId,
        directFallbackReason: null,
        tunnelId: "tunnel-1",
      }),
    ).resolves.toBe(true);

    expect(mocks.createTunnelAttachment).toHaveBeenCalledWith("tunnel-1", {
      clientId: expect.any(String),
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "refresh_tunnel_forward_relay",
      expect.objectContaining({
        tunnelId: "tunnel-1",
        relay: expect.objectContaining({
          connectPath: "/api/tunnel-attachments/attachment-1/connect",
          serverUrl: "https://cantrip.example",
        }),
      }),
    );
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
  });

  it("revokes a rotated attachment when its native forward disappeared", async () => {
    mocks.invoke.mockResolvedValue(false);

    await refreshDesktopTunnelRelay({
      attachmentId: "attachment-1",
      diagnosticTraceId: null,
      expiresAt,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "degraded",
      relayFallbackAvailable: true,
      directCapabilityId: capabilityId,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    });

    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith("attachment-1");
  });
});
