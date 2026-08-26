import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateDirectTunnelAttachment: vi.fn(),
  attachDesktopTunnelWorkerLinkForward: vi.fn(),
  createDirectTunnelAttachment: vi.fn(),
  createTunnelAttachment: vi.fn(),
  deleteDirectAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  explorerCodeSessionBindingCurrent: vi.fn(),
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
  activateDirectTunnelAttachment: mocks.activateDirectTunnelAttachment,
  createDirectTunnelAttachment: mocks.createDirectTunnelAttachment,
  createTunnelAttachment: mocks.createTunnelAttachment,
  deleteDirectAttachment: mocks.deleteDirectAttachment,
  deleteTunnelAttachment: mocks.deleteTunnelAttachment,
  explorerCodeSessionBindingCurrent: mocks.explorerCodeSessionBindingCurrent,
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
  acquireDesktopCodeTransport,
  desktopCodeTransportRuntime,
  forceDesktopTunnelRelay,
  invalidateDesktopTunnelForward,
  maintainDesktopCodeTransportsOnce,
  refreshDesktopTunnelRelay,
  refreshDesktopTunnelWorkerLinkAttachment,
  releaseDesktopCodeTransport,
  startDesktopTunnel,
  startDirectDesktopTunnel,
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

function directTicket() {
  return {
    broker: {
      available: true as const,
      leaseRenewal: true,
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

function sharedOwnedAttachment() {
  return {
    attachment: {
      formatVersion: 2 as const,
      transport: {
        formatVersion: 2 as const,
        transportId: "tunnel-1",
        tunnelId: "tunnel-1",
        workerId: "worker-1",
        securityScopeId: "11111111-1111-4111-8111-111111111111",
        serverId: "server-one",
        serverControlPlaneGeneration: "22222222-2222-4222-8222-222222222222",
        protectedKeyRevision: 1,
        workerProcessGeneration: "33333333-3333-4333-8333-333333333333",
        expiresAt,
      },
      session: {
        formatVersion: 2 as const,
        attachmentId: "code-session-attachment-one",
        transportId: "tunnel-1",
        sessionId: "code-session-one",
        routeGrant: "route_grant_123456789012345678901234",
        expiresAt,
        runtime: {
          sessionId: "code-session-one",
          status: "running" as const,
          editorBuild: {
            version: "1.109.5",
            upstreamRevision: "a".repeat(40),
            patchset: 1,
            fingerprint: "b".repeat(64),
          },
          processInstanceId: "process-one",
          bridgeConnected: true,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always" as const,
            agentStatus: "idle" as const,
          },
          startedAt: "2026-08-25T00:00:00.000Z",
          lastActivityAt: "2026-08-25T00:00:00.000Z",
          lastError: null,
        },
      },
    },
    binding: {
      identity: {
        accountId: "account-one",
        connectionId: "connection-one",
        generation: 7,
        incarnationId: "44444444-4444-4444-8444-444444444444",
        serverId: "server-one",
        serverUrl: "https://bound-server.example",
        userId: "user-one",
      },
      serverUrl: "https://bound-server.example",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.explorerCodeSessionBindingCurrent.mockReturnValue(true);
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

describe("shared desktop Code transport", () => {
  const forward = {
    attachmentId: "attachment-1",
    codePoolGeneration: "generation-one",
    diagnosticTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt,
    localHost: "127.0.0.1" as const,
    localPort: 41_234,
    routeState: "relayed" as const,
    relayFallbackAvailable: false,
    directCapabilityId: null,
    directFallbackReason: null,
    tunnelId: "tunnel-1",
  };

  it("retains the exact native lease registry across hot module replacement", () => {
    const hotState = {};
    const first = desktopCodeTransportRuntime(hotState);
    const lease = {
      binding: sharedOwnedAttachment().binding,
      forward,
      generation: "generation-hot",
      leaseId: "lease-hot",
      serverUrl: "https://bound-server.example",
      workerId: "worker-1",
    };
    first.maintenanceLeases.set(lease.leaseId, lease);
    first.pendingRetirementLeases.add(lease.leaseId);
    first.identitySubscriptionsInstalled = true;
    first.terminalForwardListenerReady = Promise.resolve();

    const reloaded = desktopCodeTransportRuntime(hotState);

    expect(reloaded).toBe(first);
    expect(reloaded.windowInstanceId).toBe(first.windowInstanceId);
    expect(reloaded.maintenanceLeases.get(lease.leaseId)).toBe(lease);
    expect(reloaded.pendingRetirementLeases.has(lease.leaseId)).toBe(true);
    expect(reloaded.identitySubscriptionsInstalled).toBe(true);
    expect(reloaded.recentTerminalForwards).toBe(first.recentTerminalForwards);
    expect(reloaded.terminalForwardSubscribers).toBe(
      first.terminalForwardSubscribers,
    );
    expect(reloaded.terminalForwardListenerReady).toBe(
      first.terminalForwardListenerReady,
    );
  });

  it("elects before creating credentials and publishes one exact leader lease", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        return {
          generation: "generation-one",
          reservationId: "reservation-one",
          state: "leader",
        };
      }
      if (command === "complete_worker_link_code_transport_forward") {
        return {
          bridge: {
            token: "bridge-token",
            url: "ws://127.0.0.1:43210/worker-link-tunnel",
          },
          forward,
          generation: "generation-one",
        };
      }
      if (command === "publish_code_transport_forward") {
        return {
          forward,
          generation: "generation-one",
          leaseId: "lease-one",
          state: "ready",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const owned = sharedOwnedAttachment();
    await expect(acquireDesktopCodeTransport(owned)).resolves.toMatchObject({
      forward,
      generation: "generation-one",
      leaseId: "lease-one",
      serverUrl: owned.binding.serverUrl,
      workerId: "worker-1",
    });

    expect(
      mocks.invoke.mock.calls.find(
        ([command]) => command === "acquire_code_transport_forward",
      ),
    ).toEqual([
      "acquire_code_transport_forward",
      {
        request: {
          acquisitionId: expect.any(String),
          consumerId: owned.attachment.session.attachmentId,
          identity: {
            accountId: "account-one",
            clientIdentityGeneration: 7,
            clientIdentityIncarnationId: owned.binding.identity.incarnationId,
            connectionId: "connection-one",
            protectedKeyRevision: 1,
            securityScopeId: owned.attachment.transport.securityScopeId,
            serverControlPlaneGeneration:
              owned.attachment.transport.serverControlPlaneGeneration,
            serverId: "server-one",
            serverUrl: owned.binding.serverUrl,
            transportId: "tunnel-1",
            userId: "user-one",
            workerId: "worker-1",
            workerProcessGeneration:
              owned.attachment.transport.workerProcessGeneration,
          },
          windowInstanceId: expect.any(String),
        },
      },
    ]);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(mocks.createTunnelAttachment).toHaveBeenCalledWith(
      "tunnel-1",
      { clientId: "generation-one" },
      expect.objectContaining({ serverUrl: owned.binding.serverUrl }),
    );
    expect(mocks.createDirectTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.activateDirectTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.attachDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith(
      {
        attachmentId: "attachment-1",
        diagnosticTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tunnelId: "tunnel-1",
        workerId: "worker-1",
      },
      {
        token: "bridge-token",
        url: "ws://127.0.0.1:43210/worker-link-tunnel",
      },
    );
    expect(
      mocks.invoke.mock.calls
        .map(([command]) => command)
        .filter(
          (command) => command !== "register_code_transport_window_instance",
        ),
    ).toEqual([
      "acquire_code_transport_forward",
      "complete_worker_link_code_transport_forward",
      "publish_code_transport_forward",
    ]);
  });

  it("waits as a follower without creating relay or direct credentials", async () => {
    let acquisition = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        acquisition += 1;
        return acquisition === 1
          ? { generation: "generation-one", state: "waiting" }
          : {
              forward,
              generation: "generation-one",
              leaseId: "lease-two",
              state: "ready",
            };
      }
      if (command === "wait_code_transport_forward") return true;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      acquireDesktopCodeTransport(sharedOwnedAttachment()),
    ).resolves.toMatchObject({ leaseId: "lease-two" });

    expect(mocks.getTunnelDataProtection).not.toHaveBeenCalled();
    expect(mocks.createTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.createDirectTunnelAttachment).not.toHaveBeenCalled();
    expect(
      mocks.invoke.mock.calls
        .map(([command]) => command)
        .filter(
          (command) => command !== "register_code_transport_window_instance",
        ),
    ).toEqual([
      "acquire_code_transport_forward",
      "wait_code_transport_forward",
      "acquire_code_transport_forward",
    ]);
  });

  it("claims the exact degraded WorkerLink carrier after a window handoff", async () => {
    const degraded = { ...forward, routeState: "degraded" as const };
    const bridge = {
      token: "handoff-bridge-token",
      url: "ws://127.0.0.1:43211/worker-link-tunnel",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        return {
          forward: degraded,
          generation: "generation-one",
          leaseId: "lease-handoff",
          state: "ready",
        };
      }
      if (command === "claim_worker_link_tunnel_bridge") return bridge;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      acquireDesktopCodeTransport(sharedOwnedAttachment()),
    ).resolves.toMatchObject({
      forward: degraded,
      leaseId: "lease-handoff",
      workerId: "worker-1",
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "claim_worker_link_tunnel_bridge",
      {
        attachmentId: "attachment-1",
        codePoolGeneration: "generation-one",
        leaseId: "lease-handoff",
        tunnelId: "tunnel-1",
        windowInstanceId: expect.any(String),
      },
    );
    expect(mocks.attachDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith(
      {
        attachmentId: "attachment-1",
        diagnosticTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tunnelId: "tunnel-1",
        workerId: "worker-1",
      },
      bridge,
    );
  });

  it("releases an exact ready lease when abort wins after native commit", async () => {
    const committed = deferred<unknown>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        return committed.promise;
      }
      if (command === "release_code_transport_forward") {
        return { released: true, remainingLeases: 0, stopped: null };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const controller = new AbortController();
    const operation = acquireDesktopCodeTransport(sharedOwnedAttachment(), {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "acquire_code_transport_forward",
        expect.any(Object),
      ),
    );
    controller.abort(new DOMException("closed", "AbortError"));
    committed.resolve({
      forward,
      generation: "generation-one",
      leaseId: "lease-after-abort",
      state: "ready",
    });

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "release_code_transport_forward",
      expect.objectContaining({
        generation: "generation-one",
        leaseId: "lease-after-abort",
        transportId: "tunnel-1",
        windowInstanceId: expect.any(String),
      }),
    );
  });

  it("fails an exact leader reservation when abort wins after election", async () => {
    const elected = deferred<unknown>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") return elected.promise;
      if (command === "fail_code_transport_forward") return;
      throw new Error(`Unexpected command: ${command}`);
    });
    const controller = new AbortController();
    const operation = acquireDesktopCodeTransport(sharedOwnedAttachment(), {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "acquire_code_transport_forward",
        expect.any(Object),
      ),
    );
    controller.abort(new DOMException("closed", "AbortError"));
    elected.resolve({
      generation: "generation-one",
      reservationId: "reservation-after-abort",
      state: "leader",
    });

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "fail_code_transport_forward",
      expect.objectContaining({
        generation: "generation-one",
        reservationId: "reservation-after-abort",
        transportId: "tunnel-1",
        windowInstanceId: expect.any(String),
      }),
    );
  });

  it("deletes physical credentials only when the exact last lease stops", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        released: true,
        remainingLeases: 1,
        stopped: null,
      })
      .mockResolvedValueOnce({
        released: true,
        remainingLeases: 0,
        stopped: {
          attachmentId: "attachment-1",
          bytesFromLocal: 0,
          bytesToLocal: 0,
          connectionsClosed: 0,
          connectionsOpened: 0,
          directCapabilityId: capabilityId,
          tunnelId: "tunnel-1",
        },
      });
    const first = {
      binding: sharedOwnedAttachment().binding,
      forward,
      generation: "generation-one",
      leaseId: "lease-one",
      serverUrl: "https://bound-server.example",
      workerId: "worker-1",
    };

    await releaseDesktopCodeTransport(first);
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();

    await releaseDesktopCodeTransport({ ...first, leaseId: "lease-two" });
    expect(mocks.stopDesktopTunnelWorkerLinkForward).toHaveBeenCalledWith(
      "tunnel-1",
    );
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledOnce();
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith("attachment-1", {
      serverUrl: "https://bound-server.example",
    });
  });

  it("retries a transient native release failure without maintaining the retired lease", async () => {
    const lease = {
      binding: sharedOwnedAttachment().binding,
      forward,
      generation: "generation-retry",
      leaseId: "lease-retry",
      serverUrl: "https://bound-server.example",
      workerId: "worker-1",
    };
    let targetReleaseAttempts = 0;
    mocks.invoke.mockImplementation(async (command: string, input: unknown) => {
      if (
        command === "release_code_transport_forward" &&
        (input as { leaseId?: string }).leaseId === lease.leaseId
      ) {
        targetReleaseAttempts += 1;
        if (targetReleaseAttempts === 1) throw new Error("transient IPC loss");
        return { released: true, remainingLeases: 0, stopped: null };
      }
      if (command === "claim_code_transport_maintenance") return null;
      if (command === "release_code_transport_forward") {
        return { released: true, remainingLeases: 1, stopped: null };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(releaseDesktopCodeTransport(lease)).resolves.toBe(false);
    await maintainDesktopCodeTransportsOnce();

    expect(targetReleaseAttempts).toBe(2);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command, input]) =>
          command === "claim_code_transport_maintenance" &&
          (input as { leaseId?: string }).leaseId === lease.leaseId,
      ),
    ).toHaveLength(0);
  });

  it("reconciles a publication response lost after native commit", async () => {
    let acquisitions = 0;
    let publications = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        acquisitions += 1;
        return {
          generation: "generation-one",
          reservationId: "reservation-one",
          state: "leader",
        };
      }
      if (command === "complete_worker_link_code_transport_forward") {
        return {
          bridge: { token: "bridge-token", url: "ws://127.0.0.1:43210" },
          forward,
          generation: "generation-one",
        };
      }
      if (command === "publish_code_transport_forward") {
        publications += 1;
        throw new Error("response lost after commit");
      }
      if (command === "reconcile_code_transport_forward") {
        return {
          forward,
          generation: "generation-one",
          leaseId: "lease-one",
          state: "ready",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      acquireDesktopCodeTransport(sharedOwnedAttachment()),
    ).resolves.toMatchObject({ leaseId: "lease-one" });

    expect(publications).toBe(2);
    expect(acquisitions).toBe(1);
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteDirectAttachment).not.toHaveBeenCalled();
  });

  it("does not elect an abandoned leader when publication reconciliation is empty", async () => {
    let acquisitions = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "register_code_transport_window_instance") return;
      if (command === "acquire_code_transport_forward") {
        acquisitions += 1;
        return {
          generation: "generation-one",
          reservationId: "reservation-one",
          state: "leader",
        };
      }
      if (command === "complete_worker_link_code_transport_forward") {
        return {
          bridge: { token: "bridge-token", url: "ws://127.0.0.1:43210" },
          forward,
          generation: "generation-one",
        };
      }
      if (command === "publish_code_transport_forward") {
        throw new Error("publication unavailable");
      }
      if (command === "reconcile_code_transport_forward") return null;
      if (command === "fail_code_transport_forward") return;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      acquireDesktopCodeTransport(sharedOwnedAttachment()),
    ).rejects.toThrow("publication unavailable");

    expect(acquisitions).toBe(1);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fail_code_transport_forward",
      ),
    ).toHaveLength(1);
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
    expect(mocks.createDirectTunnelAttachment).not.toHaveBeenCalled();
    expect(mocks.activateDirectTunnelAttachment).not.toHaveBeenCalled();
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

  it("uses the physical Code generation when rotating a pooled attachment", async () => {
    const forward = {
      attachmentId: "attachment-1",
      codePoolGeneration: "generation-one",
      diagnosticTraceId: null,
      expiresAt: "2026-08-26T12:00:00.000Z",
      localHost: "127.0.0.1" as const,
      localPort: 41_234,
      routeState: "relayed" as const,
      relayFallbackAvailable: false,
      directCapabilityId: null,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
    };

    await expect(
      refreshDesktopTunnelWorkerLinkAttachment(forward, {
        clientId: "generation-one",
        serverUrl: "https://bound-server.example",
      }),
    ).resolves.toBe(true);

    expect(mocks.createTunnelAttachment).toHaveBeenCalledWith(
      "tunnel-1",
      { clientId: "generation-one" },
      { serverUrl: "https://bound-server.example" },
    );
  });
});

describe("stopDesktopTunnel", () => {
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
