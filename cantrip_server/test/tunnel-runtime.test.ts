import { EventEmitter } from "node:events";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type {
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../src/db/repository.js";
import { TunnelRuntimeManager } from "../src/tunnels/runtime.js";
import type {
  WorkerCommandBus,
  WorkerTunnelDataPlaneFrameListener,
} from "../src/workers/bridge.js";

const EMPTY = new Uint8Array();

class FakeDesktopSocket extends EventEmitter {
  bufferedAmount = 0;
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

const authorization: TunnelAttachmentAuthorization = {
  attachmentId: "attachment-1",
  clientId: "desktop-1",
  destination: {
    kind: "worker-tcp",
    workerId: "worker-b",
  },
  expiresAt: new Date(Date.now() + 60_000),
  ownerId: "owner-1",
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
  tunnelId: "tunnel-1",
};

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
  it("relays concurrent binary streams and half-closes through a worker endpoint", async () => {
    const repository = {
      activateDesktopTunnelAttachment: async () => true,
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
      activateDesktopTunnelAttachment: async () => true,
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
      activateDesktopTunnelAttachment: async () => true,
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
      activateDesktopTunnelAttachment: async () => true,
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
      activateDesktopTunnelAttachment: async () => true,
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
});
