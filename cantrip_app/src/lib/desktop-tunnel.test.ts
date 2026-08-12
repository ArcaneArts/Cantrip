import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateDirectTunnelAttachment: vi.fn(),
  createDirectTunnelAttachment: vi.fn(),
  createTunnelAttachment: vi.fn(),
  deleteDirectAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
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
}));
vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: () => "https://cantrip.example",
}));

import {
  refreshDesktopTunnelRelay,
  startDesktopTunnel,
  startDirectDesktopTunnel,
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

    await expect(startDesktopTunnel("tunnel-1")).resolves.toMatchObject({
      routeState: "local-direct",
    });
    expect(mocks.activateDirectTunnelAttachment).toHaveBeenCalledWith(
      "attachment-1",
      { capabilityId, localPort: 41_234 },
    );
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
      directCapabilityId: null,
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
      request: expect.objectContaining({ relay: null }),
    });
    expect(direct.secret).toBe("");
  });
});

describe("refreshDesktopTunnelRelay", () => {
  it("rotates the short-lived relay credential without replacing the listener", async () => {
    mocks.invoke.mockResolvedValue(true);

    await expect(
      refreshDesktopTunnelRelay({
        attachmentId: "attachment-1",
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
