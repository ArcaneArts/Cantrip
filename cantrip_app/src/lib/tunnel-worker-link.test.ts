import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkSession,
  type WorkerLinkTunnelGrant,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  openTunnelWorkerLink,
  type TunnelWorkerLinkDependencies,
} from "./tunnel-worker-link";
import type {
  WorkerLink,
  WorkerLinkDataListener,
  WorkerLinkStream,
  WorkerLinkStreamCloseListener,
  WorkerLinkStreamErrorListener,
  WorkerLinkStreamHalfCloseListener,
  WorkerLinkStreamWritableListener,
} from "./worker-link";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const tunnelId = "tunnel-1";
const attachmentId = "attachment-1";
const grantId = "11111111-1111-4111-8111-111111111111";

function session(): WorkerLinkSession {
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    identity: {
      serverId: "server-1",
      serverGeneration: "server-generation-1",
      ownerId: "owner-1",
      accountSessionId: "account-session-1",
      clientInstanceId: "client-instance-1",
      workerId: "worker-1",
      workerProcessGeneration: "worker-generation-1",
    },
    lease: {
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString(),
      absoluteExpiresAt: new Date(now + 3_600_000).toISOString(),
    },
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
}

function issued(activeSession: WorkerLinkSession): WorkerLinkTunnelGrant {
  return {
    grant: {
      binding: {
        grantId,
        grantGeneration: 1,
        sessionId: activeSession.sessionId,
        identity: activeSession.identity,
        resource: { kind: "tunnel", resourceId: tunnelId, attachmentId },
        lanes: ["stream"],
        operations: [
          "stream:open",
          "stream:read",
          "stream:write",
          "stream:half-close",
        ],
        maxChannels: 1,
        lease: {
          ...activeSession.lease,
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      },
      token: "a".repeat(43),
    },
    route: {
      tunnelId,
      attachmentId,
      sourceEndpointId: `worker-link-client:${grantId}`,
      destinationEndpointId: "worker-link-worker:worker-1",
      target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
    },
  };
}

class FakeStream implements WorkerLinkStream {
  readonly channelId = "33333333-3333-4333-8333-333333333333";
  readonly connectionId = "44444444-4444-4444-8444-444444444444";
  readonly lane = "stream" as const;
  readonly route = "local" as const;
  readonly acknowledgements: number[] = [];
  readonly writes: Uint8Array[] = [];
  readonly closeListeners = new Set<WorkerLinkStreamCloseListener>();
  readonly dataListeners = new Set<WorkerLinkDataListener>();
  readonly errorListeners = new Set<WorkerLinkStreamErrorListener>();
  readonly halfCloseListeners = new Set<WorkerLinkStreamHalfCloseListener>();
  readonly writableListeners = new Set<WorkerLinkStreamWritableListener>();

  acknowledge(bytes: number): boolean {
    this.acknowledgements.push(bytes);
    return true;
  }
  close(code: WorkerLinkChannelCloseCode = "normal"): void {
    for (const listener of this.closeListeners) listener(code);
  }
  halfClose(): boolean {
    return true;
  }
  onClose(listener: WorkerLinkStreamCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onData(listener: WorkerLinkDataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onError(listener: WorkerLinkStreamErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  onHalfClose(listener: WorkerLinkStreamHalfCloseListener): () => void {
    this.halfCloseListeners.add(listener);
    return () => this.halfCloseListeners.delete(listener);
  }
  onWritable(listener: WorkerLinkStreamWritableListener): () => void {
    this.writableListeners.add(listener);
    return () => this.writableListeners.delete(listener);
  }
  write(payload: Uint8Array): boolean {
    this.writes.push(payload.slice());
    return true;
  }
  receive(payload: Uint8Array): void {
    for (const listener of this.dataListeners) listener(payload);
  }
}

function base(sequence = 0) {
  return {
    protocolVersion: 1 as const,
    tunnelId,
    attachmentId,
    sourceEndpointId: `worker-link-client:${grantId}`,
    destinationEndpointId: "worker-link-worker:worker-1",
    connectionId: "connection-1",
    sequence,
  };
}

function setup() {
  const activeSession = session();
  const activeGrant = issued(activeSession);
  const stream = new FakeStream();
  const release = vi.fn();
  const link: WorkerLink = {
    preferredRoute: "local",
    session: activeSession,
    workerId: "worker-1",
    onRouteChanged: (listener) => {
      listener({
        preferredRoute: "local",
        effectiveRoute: "local",
        routeGeneration: 1,
        latencyMs: 1,
        fallbackReason: null,
        changedAt: new Date(now).toISOString(),
      });
      return () => undefined;
    },
    openStream: vi.fn(async () => stream),
    reprobe: vi.fn(async () => undefined),
  };
  const dependencies: TunnelWorkerLinkDependencies = {
    createGrant: vi.fn(async () => activeGrant),
    manager: { acquire: vi.fn(async () => ({ link, release })) },
    now: () => now,
    renewGrant: vi.fn(async () => activeGrant.grant.binding.lease),
    revokeGrant: vi.fn(async () => undefined),
  };
  return { dependencies, release, stream };
}

describe("Tunnel WorkerLink client", () => {
  it("turns source opens into authorized connects and returns credit after delivery", async () => {
    const fixture = setup();
    const received: Uint8Array[] = [];
    const connection = await openTunnelWorkerLink(
      {
        attachmentId,
        diagnosticTraceId: "55555555-5555-4555-8555-555555555555",
        onClose: vi.fn(),
        onFrame: async (frame) => {
          received.push(frame);
        },
        workerId: "worker-1",
      },
      fixture.dependencies,
    );
    const open: TunnelDataPlaneFrameHeader = {
      ...base(),
      kind: "open",
      initialCreditBytes: 1024,
    };
    expect(
      connection.send(encodeTunnelDataPlaneFrame(open, new Uint8Array())),
    ).toBe(true);
    expect(
      decodeTunnelDataPlaneFrame(fixture.stream.writes[0]!).header,
    ).toEqual({
      ...open,
      kind: "connect",
      target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
      diagnosticTraceId: "55555555-5555-4555-8555-555555555555",
    });

    const accepted: TunnelDataPlaneFrameHeader = {
      ...base(),
      kind: "accepted",
      initialCreditBytes: 1024,
    };
    const encoded = encodeTunnelDataPlaneFrame(accepted, new Uint8Array());
    fixture.stream.receive(encoded);
    await Promise.resolve();
    expect(received).toHaveLength(0);
    connection.activate();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(fixture.stream.acknowledgements).toEqual([encoded.byteLength]);
    connection.close();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("fails closed when a nested frame changes attachment identity", async () => {
    const fixture = setup();
    const onClose = vi.fn();
    const connection = await openTunnelWorkerLink(
      {
        attachmentId,
        onClose,
        onFrame: vi.fn(),
        workerId: "worker-1",
      },
      fixture.dependencies,
    );
    const escaped: TunnelDataPlaneFrameHeader = {
      ...base(),
      attachmentId: "another-attachment",
      kind: "open",
      initialCreditBytes: 1024,
    };
    expect(
      connection.send(encodeTunnelDataPlaneFrame(escaped, new Uint8Array())),
    ).toBe(false);
    expect(onClose).toHaveBeenCalledWith("protocol-error");
  });
});
