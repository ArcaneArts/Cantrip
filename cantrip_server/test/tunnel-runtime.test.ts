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
  readonly listeners = new Set<WorkerTunnelDataPlaneFrameListener>();

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
  subscribeWorkerDisconnect() {
    return () => undefined;
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
        ? { ...base, kind: "accepted", initialCreditBytes: 1_024 }
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
    host: "127.0.0.1",
    port: 9_001,
  },
  expiresAt: new Date(Date.now() + 60_000),
  ownerId: "owner-1",
  projectId: "project-1",
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
      localHost: "127.0.0.1",
      localPort: 45_001,
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
});
