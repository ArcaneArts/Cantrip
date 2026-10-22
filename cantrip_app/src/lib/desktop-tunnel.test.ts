import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachDesktopTunnelWorkerLinkForward: vi.fn(),
  createTunnelAttachment: vi.fn(),
  deleteDirectAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
  getTunnelDataProtection: vi.fn(),
  getTunnelTransportConfiguration: vi.fn(),
  recordDirectAttachmentTelemetry: vi.fn(),
  renewTunnelAttachmentLease: vi.fn(),
  refreshDesktopTunnelWorkerLinkForward: vi.fn(),
  startDesktopTunnelWorkerLinkForward: vi.fn(),
  stopDesktopTunnelWorkerLinkForward: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));
vi.mock("@/lib/api", () => ({
  createTunnelAttachment: mocks.createTunnelAttachment,
  deleteDirectAttachment: mocks.deleteDirectAttachment,
  deleteTunnelAttachment: mocks.deleteTunnelAttachment,
  getTunnelDataProtection: mocks.getTunnelDataProtection,
  getTunnelTransportConfiguration: mocks.getTunnelTransportConfiguration,
  recordDirectAttachmentTelemetry: mocks.recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease: mocks.renewTunnelAttachmentLease,
}));
vi.mock("@/lib/desktop-tunnel-worker-link", () => ({
  attachDesktopTunnelWorkerLinkForward:
    mocks.attachDesktopTunnelWorkerLinkForward,
  refreshDesktopTunnelWorkerLinkForward:
    mocks.refreshDesktopTunnelWorkerLinkForward,
  startDesktopTunnelWorkerLinkForward:
    mocks.startDesktopTunnelWorkerLinkForward,
  stopDesktopTunnelWorkerLinkForward: mocks.stopDesktopTunnelWorkerLinkForward,
}));
vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: () => "https://cantrip.example",
  onServerConnectionIdentityChanged: () => () => undefined,
}));

import {
  forceDesktopTunnelRelay,
  invalidateDesktopTunnelForward,
  refreshDesktopTunnelRelay,
  refreshDesktopTunnelWorkerLinkAttachment,
  startDesktopTunnel,
  stopDesktopTunnel,
} from "./desktop-tunnel";

const capabilityId = "1c4066d8-5798-4330-82e2-f5634c6176b7";
const expiresAt = "2099-01-01T00:00:00.000Z";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
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
  mocks.deleteDirectAttachment.mockResolvedValue(undefined);
  mocks.deleteTunnelAttachment.mockResolvedValue(undefined);
  mocks.getTunnelDataProtection.mockResolvedValue({
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    key: "k".repeat(43),
  });
  mocks.getTunnelTransportConfiguration.mockResolvedValue({
    dataProtection: {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      key: "k".repeat(43),
    },
    workerId: "worker-1",
  });
  mocks.startDesktopTunnelWorkerLinkForward.mockResolvedValue({
    attachmentId: "attachment-1",
    expiresAt,
    localHost: "127.0.0.1",
    localPort: 41_234,
    routeState: "relayed",
    directCapabilityId: null,
    directFallbackReason: null,
    tunnelId: "tunnel-1",
  });
  mocks.attachDesktopTunnelWorkerLinkForward.mockResolvedValue("relay");
  mocks.refreshDesktopTunnelWorkerLinkForward.mockResolvedValue(true);
  mocks.stopDesktopTunnelWorkerLinkForward.mockResolvedValue(undefined);
  mocks.recordDirectAttachmentTelemetry.mockResolvedValue(undefined);
  mocks.renewTunnelAttachmentLease.mockResolvedValue(undefined);
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

describe("startDesktopTunnel", () => {
  it("routes generic desktop tunnels through the WorkerLink bridge", async () => {
    await expect(startDesktopTunnel("tunnel-1")).resolves.toMatchObject({
      routeState: "relayed",
    });
    expect(mocks.startDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      dataProtection: expect.objectContaining({ keyRevision: 1 }),
      diagnosticTraceId: undefined,
      expiresAt,
      preferredLocalPort: undefined,
      serverUrl: "https://cantrip.example",
      tunnelId: "tunnel-1",
      workerId: "worker-1",
    });
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
  });

  it("revokes the exact attachment when WorkerLink bridge startup fails", async () => {
    mocks.startDesktopTunnelWorkerLinkForward.mockRejectedValue(
      new Error("bridge unavailable"),
    );

    await expect(startDesktopTunnel("tunnel-1")).rejects.toThrow(
      "bridge unavailable",
    );

    expect(mocks.stopDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith(
      "tunnel-1",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("stop_tunnel_forward", {
      expectedAttachmentId: "attachment-1",
      expectedDiagnosticTraceId: null,
      expectedDirectCapabilityId: null,
      tunnelId: "tunnel-1",
    });
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith("attachment-1");
  });
});

describe("WorkerLink tunnel attachment rotation", () => {
  it("rotates the server lifetime without rebinding the native listener", async () => {
    const forward = {
      attachmentId: "attachment-1",
      diagnosticTraceId: null,
      expiresAt: "2026-08-26T12:00:00.000Z",
      localHost: "127.0.0.1" as const,
      localPort: 41_234,
      routeState: "local-direct" as const,
      relayFallbackAvailable: false,
      directCapabilityId: null,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    };

    await expect(
      refreshDesktopTunnelWorkerLinkAttachment(forward),
    ).resolves.toBe(true);

    expect(mocks.createTunnelAttachment).toHaveBeenCalledWith(
      "tunnel-1",
      { clientId: expect.any(String) },
      {},
    );
    expect(mocks.refreshDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith(
      "tunnel-1",
      "attachment-1",
      expiresAt,
    );
  });

  it("passes the exact direct capability fence for an owned Code forward", async () => {
    mocks.invoke.mockResolvedValue(null);

    await stopDesktopTunnel("tunnel-1", "attachment-1", {
      attachmentId: "attachment-1",
      diagnosticTraceId: null,
      directCapabilityId: capabilityId,
    });

    expect(mocks.invoke).toHaveBeenCalledWith("stop_tunnel_forward", {
      expectedAttachmentId: "attachment-1",
      expectedDiagnosticTraceId: null,
      expectedDirectCapabilityId: capabilityId,
      tunnelId: "tunnel-1",
    });
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith("attachment-1");
  });

  it("emits a terminal signal only for an authoritatively invalidated forward", async () => {
    mocks.invoke.mockResolvedValue(null);

    await invalidateDesktopTunnelForward("tunnel-1", {
      attachmentId: "attachment-1",
      diagnosticTraceId: "trace-1",
      directCapabilityId: capabilityId,
    });

    expect(mocks.invoke).toHaveBeenCalledWith("stop_tunnel_forward", {
      expectedAttachmentId: "attachment-1",
      expectedDiagnosticTraceId: "trace-1",
      expectedDirectCapabilityId: capabilityId,
      terminalReasonCode: "attachment-invalidated",
      tunnelId: "tunnel-1",
    });
  });

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
      directCapabilityId: capabilityId,
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

    expect(mocks.createTunnelAttachment).toHaveBeenCalledWith(
      "tunnel-1",
      {
        clientId: expect.any(String),
      },
      { signal: undefined },
    );
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

  it("single-flights each tunnel rotation without blocking other tunnels", async () => {
    type Attachment = {
      attachmentId: string;
      tunnelId: string;
      secret: string;
      connectPath: string;
      secretExpiresAt: string;
      expiresAt: string;
    };
    let releaseFirst: ((attachment: Attachment) => void) | undefined;
    const firstAttachment = new Promise<Attachment>((resolve) => {
      releaseFirst = resolve;
    });
    let tunnelOneCreates = 0;
    mocks.createTunnelAttachment.mockImplementation((tunnelId: string) => {
      if (tunnelId === "tunnel-1") {
        tunnelOneCreates += 1;
        if (tunnelOneCreates === 1) return firstAttachment;
      }
      const attachmentId =
        tunnelId === "tunnel-1" ? "attachment-1" : "attachment-2";
      return Promise.resolve({
        attachmentId,
        tunnelId,
        secret: `${tunnelId}-${tunnelOneCreates}`.repeat(4),
        connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
        secretExpiresAt: expiresAt,
        expiresAt,
      });
    });
    const published: Array<{ secret: string; tunnelId: string }> = [];
    mocks.invoke.mockImplementation(
      (
        command: string,
        input: { relay: { secret: string }; tunnelId: string },
      ) => {
        if (command === "refresh_tunnel_forward_relay") {
          published.push({
            secret: input.relay.secret,
            tunnelId: input.tunnelId,
          });
        }
        return Promise.resolve(true);
      },
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
    const otherForward = {
      ...forward,
      attachmentId: "attachment-2",
      tunnelId: "tunnel-2",
    };

    const first = refreshDesktopTunnelRelay(forward);
    const duplicate = refreshDesktopTunnelRelay(forward);
    expect(duplicate).toBe(first);
    await expect(refreshDesktopTunnelRelay(otherForward)).resolves.toBe(true);
    expect(tunnelOneCreates).toBe(1);
    expect(published.map(({ tunnelId }) => tunnelId)).toEqual(["tunnel-2"]);

    releaseFirst?.({
      attachmentId: "attachment-1",
      tunnelId: "tunnel-1",
      secret: "older-server-credential".repeat(2),
      connectPath: "/api/tunnel-attachments/attachment-1/connect",
      secretExpiresAt: expiresAt,
      expiresAt,
    });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      true,
      true,
    ]);
    await expect(refreshDesktopTunnelRelay(forward)).resolves.toBe(true);

    expect(
      published
        .filter(({ tunnelId }) => tunnelId === "tunnel-1")
        .map(({ secret }) => secret),
    ).toEqual(["older-server-credential".repeat(2), "tunnel-1-2".repeat(4)]);
  });

  it("treats an older native credential generation as a successful no-op", async () => {
    mocks.invoke.mockResolvedValue({ outcome: "stale" });

    await expect(
      refreshDesktopTunnelRelay({
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
    ).resolves.toBe(true);

    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
  });

  it("does not revoke shared attachment state when its native forward disappeared", async () => {
    mocks.invoke.mockResolvedValue(false);

    const forward = {
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
    } as const;

    const first = refreshDesktopTunnelRelay(forward);
    const duplicate = refreshDesktopTunnelRelay(forward);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      false,
      false,
    ]);

    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
