import { EventEmitter } from "node:events";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountUsageMeasurement,
  AccountUsageRecorder,
} from "../src/account-usage/bandwidth-meter.js";
import type {
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../src/db/repository.js";
import {
  TunnelRuntimeManager,
  tunnelBandwidthChannel,
} from "../src/tunnels/runtime.js";
import { TunnelStreamBroker } from "../src/tunnels/broker.js";
import { DesktopTunnelEndpoint } from "../src/tunnels/desktop-endpoint.js";
import type {
  WorkerCommandBus,
  WorkerTunnelDataPlaneFrameListener,
} from "../src/workers/bridge.js";

const EMPTY = new Uint8Array();
const ACTIVATED_AT = new Date("2026-08-24T12:00:00.000Z");

class RecordingMeter implements AccountUsageRecorder {
  readonly measurements: AccountUsageMeasurement[] = [];
  record(measurement: AccountUsageMeasurement): boolean {
    this.measurements.push(measurement);
    return true;
  }
}

class FakeDesktopSocket extends EventEmitter {
  bufferedAmount = 0;
  lastPingToken: Uint8Array | null = null;
  pings = 0;
  readyState = 1;
  readonly sent: Array<ReturnType<typeof decodeTunnelDataPlaneFrame>> = [];

  close(code = 1000, reason = "closed"): void {
    if (this.readyState > 1) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  send(data: Uint8Array): void {
    this.sent.push(decodeTunnelDataPlaneFrame(data));
  }

  ping(data = EMPTY): void {
    this.pings += 1;
    this.lastPingToken = Uint8Array.from(data);
  }

  pong(data: unknown = this.lastPingToken): void {
    this.emit("pong", data);
  }

  emitFrame(header: TunnelDataPlaneFrameHeader, payload = EMPTY): void {
    this.emit("message", encodeTunnelDataPlaneFrame(header, payload), true);
  }
}

class EchoWorkerBridge implements WorkerCommandBus {
  readonly disconnectListeners = new Set<() => void>();
  readonly listeners = new Set<WorkerTunnelDataPlaneFrameListener>();
  readonly received: TunnelDataPlaneFrameHeader[] = [];

  constructor(
    private readonly rejectedConnectCode?: "protected-endpoint-unavailable",
  ) {}

  attach() {}
  close() {}
  isConnected(workerId: string) {
    return workerId === "worker-b";
  }
  sendSurfaceFrame() {
    return false;
  }
  subscribeSurfaceFrames() {
    return () => undefined;
  }
  subscribeWorkerDisconnect(_workerId: string, listener: () => void) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  subscribeTunnelDataPlaneFrames(
    _workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  sendTunnelDataPlaneFrame(
    _workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ) {
    this.received.push(header);
    const base = {
      protocolVersion: header.protocolVersion,
      tunnelId: header.tunnelId,
      attachmentId: header.attachmentId,
      sourceEndpointId: header.sourceEndpointId,
      destinationEndpointId: header.destinationEndpointId,
      connectionId: header.connectionId,
      sequence: header.sequence,
    };
    const response: TunnelDataPlaneFrameHeader | null =
      header.kind === "connect"
        ? this.rejectedConnectCode
          ? { ...base, kind: "rejected", code: this.rejectedConnectCode }
          : { ...base, kind: "accepted", initialCreditBytes: 1_024 }
        : header.kind === "data"
          ? {
              ...base,
              kind: "data",
              direction: "destination-to-source",
              sequence: header.sequence,
            }
          : header.kind === "half-close"
            ? {
                ...base,
                kind: "half-close",
                direction: "destination-to-source",
                sequence: header.sequence,
              }
            : null;
    if (response) {
      for (const listener of this.listeners) listener(response, payload);
    }
    return true;
  }
  async request() {
    throw new Error("Unexpected worker command.");
  }
}

class OfflineAwareWorkerBridge extends EchoWorkerBridge {
  readonly offlineListeners = new Set<() => void>();

  subscribeWorkerOffline(_workerId: string, listener: () => void) {
    this.offlineListeners.add(listener);
    return () => this.offlineListeners.delete(listener);
  }
}

const authorization: TunnelAttachmentAuthorization = {
  attachmentId: "attachment-1",
  clientId: "desktop-1",
  destination: {
    kind: "worker-tcp",
    workerId: "worker-b",
  },
  expiresAt: new Date(Date.now() + 60_000),
  ownerId: "owner-1",
  origin: "user",
  projectId: "project-1",
  protectedRecord: {
    operationId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    protectedContent: {
      formatVersion: 1,
      domain: "tunnel-content",
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  },
  secretExpiresAt: new Date(Date.now() + 30_000),
  tunnelId: "tunnel-1",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function sourceFrame(
  connectionId: string,
  sequence: number,
  frame: Omit<
    TunnelDataPlaneFrameHeader,
    | "protocolVersion"
    | "tunnelId"
    | "attachmentId"
    | "sourceEndpointId"
    | "destinationEndpointId"
    | "connectionId"
    | "sequence"
  >,
): TunnelDataPlaneFrameHeader {
  return {
    protocolVersion: 1,
    tunnelId: authorization.tunnelId,
    attachmentId: authorization.attachmentId,
    sourceEndpointId: "desktop:desktop-1:attachment-1",
    destinationEndpointId: "worker:worker-b",
    connectionId,
    sequence,
    ...frame,
  } as TunnelDataPlaneFrameHeader;
}

describe("desktop tunnel runtime", () => {
  it("gates both directions until the desktop endpoint is activated", () => {
    const socket = new FakeDesktopSocket();
    const endpoint = new DesktopTunnelEndpoint(
      socket,
      authorization.clientId,
      authorization.attachmentId,
    );
    const frame = sourceFrame("pre-activation-egress", 0, {
      kind: "open",
      initialCreditBytes: 1_024,
    });

    expect(endpoint.send(frame, EMPTY)).toBe(false);
    expect(socket.sent).toHaveLength(0);
    expect(endpoint.activate()).toBe(true);
    expect(endpoint.send(frame, EMPTY)).toBe(true);
    expect(socket.sent).toHaveLength(1);
    endpoint.close();
  });

  it("meters both physical tunnel legs without double counting", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const meter = new RecordingMeter();
    const runtime = new TunnelRuntimeManager(
      repository,
      bridge,
      () => {},
      undefined,
      meter,
    );
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    const open = sourceFrame("metered-connection", 0, {
      kind: "open",
      initialCreditBytes: 1_024,
    });
    const openBytes = encodeTunnelDataPlaneFrame(open, EMPTY).byteLength;

    socket.emitFrame(open);

    expect(meter.measurements).toHaveLength(4);
    expect(meter.measurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerId: "owner-1",
          direction: "ingress",
          channel: "tunnel-relay",
          bytes: openBytes,
        }),
        expect.objectContaining({
          ownerId: "owner-1",
          direction: "egress",
          channel: "tunnel-relay",
        }),
      ]),
    );
    expect(
      meter.measurements.filter(({ direction }) => direction === "ingress"),
    ).toHaveLength(2);
    expect(
      meter.measurements.filter(({ direction }) => direction === "egress"),
    ).toHaveLength(2);
    runtime.close();
  });

  it("classifies managed Code and project-share data planes", () => {
    expect(
      tunnelBandwidthChannel({
        ...authorization,
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "code",
          resourceId: "code-1",
        },
      }),
    ).toBe("code-relay");
    expect(
      tunnelBandwidthChannel({
        ...authorization,
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "project-share",
          resourceId: "share-1",
        },
      }),
    ).toBe("project-share-relay");
  });

  it("relays concurrent binary streams and half-closes through a worker endpoint", async () => {
    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
      stopDesktopTunnelAttachment: async () => ({
        projectId: authorization.projectId,
        tunnelId: authorization.tunnelId,
      }),
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const changes: unknown[] = [];
    const runtime = new TunnelRuntimeManager(repository, bridge, (change) =>
      changes.push(change),
    );
    const socket = new FakeDesktopSocket();
    const ready = await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
      diagnosticTraceId,
    });
    expect(ready).toMatchObject({
      sourceEndpointId: "desktop:desktop-1:attachment-1",
      destinationEndpointId: "worker:worker-b",
    });
    for (const connectionId of ["connection-a", "connection-b"]) {
      socket.emitFrame(
        sourceFrame(connectionId, 0, {
          kind: "open",
          initialCreditBytes: 1_024,
        }),
      );
      socket.emitFrame(
        sourceFrame(connectionId, 1, {
          kind: "data",
          direction: "source-to-destination",
        }),
        new Uint8Array([0, 1, 2, 255]),
      );
      socket.emitFrame(
        sourceFrame(connectionId, 2, {
          kind: "half-close",
          direction: "source-to-destination",
        }),
      );
    }

    expect(bridge.received[0]).toMatchObject({
      kind: "connect",
      diagnosticTraceId,
      target: {
        kind: "protected-tunnel",
        recordId: authorization.tunnelId,
        protectedRecord: authorization.protectedRecord,
      },
    });

    expect(
      socket.sent.filter(({ header }) => header.kind === "accepted"),
    ).toHaveLength(2);
    expect(
      socket.sent.filter(({ header }) => header.kind === "data"),
    ).toHaveLength(2);
    expect(
      socket.sent.filter(({ header }) => header.kind === "half-close"),
    ).toHaveLength(2);
    expect(runtime.stats()).toMatchObject({
      activeConnections: 2,
      activeRoutes: 1,
      bytesFromSource: 8,
      bytesToSource: 8,
    });
    expect(changes).toHaveLength(1);
    runtime.close();
    expect(runtime.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 0,
    });
  });

  it("preserves a protected endpoint rejection from worker to desktop", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge("protected-endpoint-unavailable");
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });

    socket.emitFrame(
      sourceFrame("protected-endpoint-failure", 0, {
        kind: "open",
        initialCreditBytes: 1_024,
      }),
    );

    expect(bridge.received[0]).toMatchObject({
      kind: "connect",
      target: {
        kind: "protected-tunnel",
        recordId: authorization.tunnelId,
      },
    });
    expect(socket.sent).toEqual([
      expect.objectContaining({
        header: expect.objectContaining({
          kind: "rejected",
          code: "protected-endpoint-unavailable",
          connectionId: "protected-endpoint-failure",
        }),
      }),
    ]);
    expect(runtime.stats()).toMatchObject({
      activeConnections: 0,
      rejectedConnections: 1,
    });
    runtime.close();
  });

  it("authorizes revocation before closing another owner's active route", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
      stopDesktopTunnelAttachment: async (ownerId: string) =>
        ownerId === authorization.ownerId
          ? {
              projectId: authorization.projectId,
              tunnelId: authorization.tunnelId,
            }
          : null,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });

    expect(await runtime.revoke("owner-2", authorization.attachmentId)).toBe(
      false,
    );
    expect(runtime.stats().activeRoutes).toBe(1);
    expect(socket.readyState).toBe(1);
    expect(await runtime.revoke("owner-1", authorization.attachmentId)).toBe(
      true,
    );
    expect(runtime.stats().activeRoutes).toBe(0);
    expect(socket.readyState).toBe(3);
    runtime.close();
  });

  it("closes child desktop attachments by their owning Code tunnel", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });

    expect(authorization.attachmentId).not.toBe(authorization.tunnelId);
    expect(
      runtime.closeTunnel(
        authorization.tunnelId,
        "Code attachment revoked",
        1008,
      ),
    ).toBe(1);
    expect(runtime.stats().activeRoutes).toBe(0);
    expect(socket.readyState).toBe(3);
    expect(runtime.closeTunnel("different-tunnel", "Unrelated cleanup")).toBe(
      0,
    );
    runtime.close();
  });

  it("unsubscribes worker disconnect handling when the desktop socket closes", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline: async () => undefined,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    expect(bridge.disconnectListeners).toHaveLength(2);

    socket.close();
    expect(bridge.disconnectListeners).toHaveLength(0);
    expect(runtime.stats().activeRoutes).toBe(0);
    runtime.close();
  });

  it("keeps an active route through reconnecting and cleans it up when the worker is offline", async () => {
    const markDesktopTunnelAttachmentOffline = vi.fn(async () => undefined);
    const repository = {
      activateDesktopTunnelAttachment: async () => ACTIVATED_AT,
      markDesktopTunnelAttachmentOffline,
    } as unknown as ServerRepository;
    const bridge = new OfflineAwareWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    await runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });

    expect(bridge.disconnectListeners).toHaveLength(0);
    expect(bridge.offlineListeners).toHaveLength(2);
    expect(runtime.stats().activeRoutes).toBe(1);
    expect(socket.readyState).toBe(1);
    expect(markDesktopTunnelAttachmentOffline).not.toHaveBeenCalled();

    for (const listener of [...bridge.offlineListeners]) listener();
    await vi.waitFor(() =>
      expect(markDesktopTunnelAttachmentOffline).toHaveBeenCalledOnce(),
    );
    expect(runtime.stats().activeRoutes).toBe(0);
    expect(socket.readyState).toBe(3);
    expect(bridge.offlineListeners).toHaveLength(0);
    runtime.close();
  });

  it("cleans up the route when attachment activation fails", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => {
        throw new Error("database unavailable");
      },
      markDesktopTunnelAttachmentOffline: async () => undefined,
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();

    await expect(
      runtime.attach(socket, authorization, {
        type: "initialize",
        clientId: authorization.clientId,
      }),
    ).rejects.toThrow("database unavailable");
    expect(bridge.disconnectListeners).toHaveLength(0);
    expect(runtime.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 0,
    });
    expect(socket.readyState).toBe(3);
    runtime.close();
  });

  it("does not publish an attachment closed while activation is pending", async () => {
    const activation = deferred<Date>();
    let activationCommitted = false;
    const offlineCommitStates: boolean[] = [];
    const changes = vi.fn();
    const repository = {
      activateDesktopTunnelAttachment: vi.fn(async () => {
        const activated = await activation.promise;
        activationCommitted = true;
        return activated;
      }),
      markDesktopTunnelAttachmentOffline: vi.fn(async () => {
        offlineCommitStates.push(activationCommitted);
        return undefined;
      }),
    } as unknown as ServerRepository;
    const runtime = new TunnelRuntimeManager(
      repository,
      new EchoWorkerBridge(),
      changes,
    );
    const socket = new FakeDesktopSocket();
    const attaching = runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    await vi.waitFor(() =>
      expect(repository.activateDesktopTunnelAttachment).toHaveBeenCalledOnce(),
    );

    socket.close(1006, "transport disappeared");
    activation.resolve(ACTIVATED_AT);

    await expect(attaching).rejects.toThrow(/disconnected|stale/iu);
    expect(changes).not.toHaveBeenCalled();
    expect(offlineCommitStates).toEqual([true]);
    expect(
      repository.markDesktopTunnelAttachmentOffline,
    ).toHaveBeenLastCalledWith(
      authorization.attachmentId,
      authorization.secretExpiresAt,
      ACTIVATED_AT,
    );
    expect(runtime.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 0,
    });
    runtime.close();
  });

  it("drops data-plane frames until exact attachment activation completes", async () => {
    const activation = deferred<Date>();
    const repository = {
      activateDesktopTunnelAttachment: vi.fn(() => activation.promise),
      markDesktopTunnelAttachmentOffline: vi.fn(async () => false),
    } as unknown as ServerRepository;
    const bridge = new EchoWorkerBridge();
    const runtime = new TunnelRuntimeManager(repository, bridge, () => {});
    const socket = new FakeDesktopSocket();
    const attaching = runtime.attach(socket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    await vi.waitFor(() =>
      expect(repository.activateDesktopTunnelAttachment).toHaveBeenCalledOnce(),
    );

    socket.emitFrame(
      sourceFrame("pre-activation", 0, {
        kind: "open",
        initialCreditBytes: 1_024,
      }),
    );
    expect(bridge.received).toHaveLength(0);
    expect(runtime.stats().openedConnections).toBe(0);

    activation.resolve(new Date("2026-08-24T12:00:00.000Z"));
    await expect(attaching).resolves.toMatchObject({ type: "ready" });
    socket.emitFrame(
      sourceFrame("post-activation", 0, {
        kind: "open",
        initialCreditBytes: 1_024,
      }),
    );
    expect(bridge.received).toHaveLength(1);
    expect(bridge.received[0]).toMatchObject({
      connectionId: "post-activation",
      kind: "connect",
    });
    runtime.close();
  });

  it("generation-fences its automatic expiry stop", async () => {
    vi.useFakeTimers();
    try {
      const activatedAt = new Date("2026-08-24T12:00:00.000Z");
      const stopDesktopTunnelAttachment = vi.fn(async () => ({
        projectId: authorization.projectId,
        tunnelId: authorization.tunnelId,
      }));
      const repository = {
        activateDesktopTunnelAttachment: vi.fn(async () => activatedAt),
        markDesktopTunnelAttachmentOffline: vi.fn(async () => false),
        stopDesktopTunnelAttachment,
      } as unknown as ServerRepository;
      const expiresAt = new Date(Date.now() + 1_000);
      const expiringAuthorization = { ...authorization, expiresAt };
      const runtime = new TunnelRuntimeManager(
        repository,
        new EchoWorkerBridge(),
        () => {},
      );
      const socket = new FakeDesktopSocket();
      await runtime.attach(socket, expiringAuthorization, {
        type: "initialize",
        clientId: expiringAuthorization.clientId,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(stopDesktopTunnelAttachment).toHaveBeenCalledWith(
        expiringAuthorization.ownerId,
        expiringAuthorization.attachmentId,
        "attachment-expired",
        false,
        {
          activatedAt,
          expiresAt,
          secretExpiresAt: expiringAuthorization.secretExpiresAt,
        },
      );
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight activation before fencing automatic expiry", async () => {
    vi.useFakeTimers();
    try {
      const activation = deferred<Date>();
      const stopDesktopTunnelAttachment = vi.fn(async () => ({
        projectId: authorization.projectId,
        tunnelId: authorization.tunnelId,
      }));
      const repository = {
        activateDesktopTunnelAttachment: vi.fn(() => activation.promise),
        markDesktopTunnelAttachmentOffline: vi.fn(async () => false),
        stopDesktopTunnelAttachment,
      } as unknown as ServerRepository;
      const expiresAt = new Date(Date.now() + 1_000);
      const expiringAuthorization = { ...authorization, expiresAt };
      const runtime = new TunnelRuntimeManager(
        repository,
        new EchoWorkerBridge(),
        () => {},
      );
      const socket = new FakeDesktopSocket();
      const attaching = runtime.attach(socket, expiringAuthorization, {
        type: "initialize",
        clientId: expiringAuthorization.clientId,
      });
      await vi.waitFor(() =>
        expect(
          repository.activateDesktopTunnelAttachment,
        ).toHaveBeenCalledOnce(),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopDesktopTunnelAttachment).not.toHaveBeenCalled();
      activation.resolve(ACTIVATED_AT);

      await expect(attaching).rejects.toThrow(/disconnected/iu);
      await vi.waitFor(() =>
        expect(stopDesktopTunnelAttachment).toHaveBeenCalledWith(
          expiringAuthorization.ownerId,
          expiringAuthorization.attachmentId,
          "attachment-expired",
          false,
          {
            activatedAt: ACTIVATED_AT,
            expiresAt,
            secretExpiresAt: expiringAuthorization.secretExpiresAt,
          },
        ),
      );
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a delayed activation publish over its replacement", async () => {
    const firstActivation = deferred<Date>();
    const replacementActivatedAt = new Date("2026-08-24T12:00:00.001Z");
    const activateDesktopTunnelAttachment = vi
      .fn<ServerRepository["activateDesktopTunnelAttachment"]>()
      .mockImplementationOnce(() => firstActivation.promise)
      .mockResolvedValueOnce(replacementActivatedAt);
    const repository = {
      activateDesktopTunnelAttachment,
      markDesktopTunnelAttachmentOffline: vi.fn(async () => undefined),
    } as unknown as ServerRepository;
    const changes = vi.fn();
    const runtime = new TunnelRuntimeManager(
      repository,
      new EchoWorkerBridge(),
      changes,
    );
    const staleSocket = new FakeDesktopSocket();
    const replacementSocket = new FakeDesktopSocket();
    const staleAttach = runtime.attach(staleSocket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    await vi.waitFor(() =>
      expect(activateDesktopTunnelAttachment).toHaveBeenCalledOnce(),
    );

    const replacementAttach = runtime.attach(replacementSocket, authorization, {
      type: "initialize",
      clientId: authorization.clientId,
    });
    expect.soft(activateDesktopTunnelAttachment).toHaveBeenCalledTimes(1);
    firstActivation.resolve(ACTIVATED_AT);

    await expect(staleAttach).rejects.toThrow(/replaced|stale/iu);
    await expect(replacementAttach).resolves.toMatchObject({
      attachmentId: authorization.attachmentId,
    });
    expect(activateDesktopTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(staleSocket.readyState).toBe(3);
    expect(replacementSocket.readyState).toBe(1);
    expect(changes).toHaveBeenCalledOnce();
    expect(runtime.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 1,
    });
    replacementSocket.close(1006, "replacement disconnected");
    await vi.waitFor(() =>
      expect(
        repository.markDesktopTunnelAttachmentOffline,
      ).toHaveBeenCalledWith(
        authorization.attachmentId,
        authorization.secretExpiresAt,
        replacementActivatedAt,
      ),
    );
    runtime.close();
  });

  it("renews only an exact pong and expires only the silent relay route", async () => {
    vi.useFakeTimers();
    try {
      const activity = vi.fn(() => true);
      const broker = new TunnelStreamBroker({ onActivity: activity });
      const repository = {
        activateDesktopTunnelAttachment: vi.fn(async () => ACTIVATED_AT),
        markDesktopTunnelAttachmentOffline: vi.fn(async () => undefined),
      } as unknown as ServerRepository;
      const RuntimeWithHeartbeat = TunnelRuntimeManager as unknown as new (
        repository: ServerRepository,
        bridge: WorkerCommandBus,
        changed: () => void,
        broker: TunnelStreamBroker,
        usage: undefined,
        options: {
          heartbeatIntervalMs: number;
          heartbeatTimeoutMs: number;
        },
      ) => TunnelRuntimeManager;
      const runtime = new RuntimeWithHeartbeat(
        repository,
        new EchoWorkerBridge(),
        () => {},
        broker,
        undefined,
        { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 250 },
      );
      const exactAuthorization = (
        attachmentId: string,
      ): TunnelAttachmentAuthorization => ({
        ...authorization,
        attachmentId,
        clientId: `client-${attachmentId}`,
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "code",
          resourceId: `tunnel-${attachmentId}`,
        },
        origin: "code",
        tunnelId: `tunnel-${attachmentId}`,
      });
      const healthyAuthorization = exactAuthorization("heartbeat-healthy");
      const silentAuthorization = exactAuthorization("heartbeat-silent");
      const healthySocket = new FakeDesktopSocket();
      const staleSocket = new FakeDesktopSocket();
      const silentSocket = new FakeDesktopSocket();
      await runtime.attach(healthySocket, healthyAuthorization, {
        type: "initialize",
        clientId: healthyAuthorization.clientId,
      });
      await runtime.attach(staleSocket, silentAuthorization, {
        type: "initialize",
        clientId: silentAuthorization.clientId,
      });
      await runtime.attach(silentSocket, silentAuthorization, {
        type: "initialize",
        clientId: silentAuthorization.clientId,
      });
      expect(staleSocket.readyState).toBe(3);
      activity.mockClear();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthySocket.pings).toBe(1);
      expect(silentSocket.pings).toBe(1);
      silentSocket.pong(new Uint8Array([0xff]));
      expect(activity).not.toHaveBeenCalled();
      healthySocket.pong();
      staleSocket.pong();
      expect(activity).toHaveBeenCalledTimes(1);
      expect(activity).toHaveBeenCalledWith(
        healthyAuthorization.tunnelId,
        healthyAuthorization.attachmentId,
        true,
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(healthySocket.readyState).toBe(1);
      expect(silentSocket.readyState).toBe(3);
      expect(runtime.stats()).toMatchObject({ activeRoutes: 1 });
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
