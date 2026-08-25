import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  TunnelStreamBroker,
  type TunnelDataPlaneEndpoint,
  type TunnelEndpointFrameListener,
  type TunnelEndpointPlacement,
} from "../src/tunnels/broker.js";

const EMPTY_PAYLOAD = new Uint8Array();

class FakeEndpoint implements TunnelDataPlaneEndpoint {
  readonly disconnectListeners = new Set<() => void>();
  readonly listeners = new Set<TunnelEndpointFrameListener>();
  readonly sent: Array<{
    header: TunnelDataPlaneFrameHeader;
    payload: Uint8Array;
  }> = [];
  failSend = false;

  constructor(
    readonly endpointId: string,
    readonly placement: TunnelEndpointPlacement,
  ) {}

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    if (this.failSend) return false;
    this.sent.push({ header, payload: payload.slice() });
    return true;
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  emit(header: TunnelDataPlaneFrameHeader, payload = EMPTY_PAYLOAD): void {
    for (const listener of this.listeners) listener(header, payload);
  }

  disconnect(): void {
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

const identity = {
  protocolVersion: 1 as const,
  tunnelId: "tunnel-1",
  attachmentId: "attachment-1",
  sourceEndpointId: "worker-a-listener",
  destinationEndpointId: "worker-b-tcp",
};

function setup(
  options: ConstructorParameters<typeof TunnelStreamBroker>[0] = {},
  authoritativeRootRequired = false,
) {
  const broker = new TunnelStreamBroker(options);
  const source = new FakeEndpoint("worker-a-listener", {
    kind: "worker",
    workerId: "worker-a",
  });
  const destination = new FakeEndpoint("worker-b-tcp", {
    kind: "worker",
    workerId: "worker-b",
  });
  broker.registerRoute({
    tunnelId: identity.tunnelId,
    attachmentId: identity.attachmentId,
    authoritativeRootRequired,
    source,
    destination,
    destinationTarget: { kind: "tcp", host: "127.0.0.1", port: 5173 },
  });
  return { broker, destination, source };
}

describe("generic tunnel stream broker", () => {
  it("reports activity only for the exact tunnel carrying a valid frame", () => {
    const activity: string[] = [];
    const { broker, destination, source } = setup({
      onActivity: (tunnelId) => {
        activity.push(tunnelId);
        return true;
      },
    });
    source.emit({
      ...identity,
      tunnelId: "unrelated-tunnel",
      connectionId: "ignored-connection",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 8,
    });

    expect(activity).toEqual([identity.tunnelId, identity.tunnelId]);
    broker.close();
  });

  it("does not forward an open frame after its activity lease expires", () => {
    const { broker, destination, source } = setup({
      onActivity: () => false,
    });

    source.emit({
      ...identity,
      connectionId: "expired-open",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });

    expect(destination.sent).toHaveLength(0);
    expect(broker.stats().activeConnections).toBe(0);
    broker.close();
  });

  it("fails closed when a Code route lacks its exact local root authority", () => {
    const activity: Array<[string, string, boolean]> = [];
    const { broker, destination, source } = setup(
      {
        onActivity: (tunnelId, attachmentId, authoritativeRootRequired) => {
          activity.push([tunnelId, attachmentId, authoritativeRootRequired]);
          return !authoritativeRootRequired;
        },
      },
      true,
    );

    source.emit({
      ...identity,
      connectionId: "missing-root",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });

    expect(activity).toEqual([
      [identity.tunnelId, identity.attachmentId, true],
    ]);
    expect(destination.sent).toHaveLength(0);
    expect(source.sent).toEqual([
      expect.objectContaining({
        header: expect.objectContaining({
          connectionId: "missing-root",
          kind: "rejected",
          code: "unauthorized",
        }),
      }),
    ]);
    expect(broker.stats().activeConnections).toBe(0);
    broker.close();
  });

  it("does not forward data after an established route activity lease expires", () => {
    let active = true;
    const { broker, destination, source } = setup({
      onActivity: () => active,
    });
    source.emit({
      ...identity,
      connectionId: "expired-data",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    destination.emit({
      ...identity,
      connectionId: "expired-data",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 8,
    });
    active = false;

    source.emit(
      {
        ...identity,
        connectionId: "expired-data",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
        protection: null,
      },
      new Uint8Array([1]),
    );

    expect(destination.sent.some(({ header }) => header.kind === "data")).toBe(
      false,
    );
    expect(broker.stats().activeConnections).toBe(0);
    broker.close();
  });

  it("forwards protected payloads opaquely while charging plaintext flow credit", () => {
    const { broker, destination, source } = setup();
    source.emit({
      ...identity,
      connectionId: "protected-connection",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 3,
    });
    destination.emit({
      ...identity,
      connectionId: "protected-connection",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 3,
    });
    const ciphertext = new Uint8Array(19).fill(0xa5);
    source.emit(
      {
        ...identity,
        connectionId: "protected-connection",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
        protection: {
          formatVersion: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "n".repeat(16),
        },
      },
      ciphertext,
    );

    expect(destination.sent.at(-1)?.payload).toEqual(ciphertext);
    expect(broker.stats().activeConnections).toBe(1);
    broker.close();
  });

  it("routes a bidirectional, credited, half-close-capable stream between arbitrary endpoints", () => {
    const { broker, destination, source } = setup();
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    expect(destination.sent.at(-1)?.header).toMatchObject({
      kind: "connect",
      target: { kind: "tcp", port: 5173 },
    });
    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 8,
    });
    expect(source.sent.at(-1)?.header.kind).toBe("accepted");

    source.emit(
      {
        ...identity,
        connectionId: "connection-1",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
      },
      new Uint8Array([1, 2, 3]),
    );
    destination.emit(
      {
        ...identity,
        connectionId: "connection-1",
        sequence: 1,
        kind: "data",
        direction: "destination-to-source",
      },
      new Uint8Array([4, 5]),
    );
    expect(destination.sent.at(-1)?.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(source.sent.at(-1)?.payload).toEqual(new Uint8Array([4, 5]));

    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 2,
      kind: "credit",
      direction: "source-to-destination",
      bytes: 3,
    });
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 2,
      kind: "credit",
      direction: "destination-to-source",
      bytes: 2,
    });
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 3,
      kind: "half-close",
      direction: "source-to-destination",
    });
    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 3,
      kind: "half-close",
      direction: "destination-to-source",
    });
    expect(destination.sent.at(-1)?.header.kind).toBe("half-close");
    expect(source.sent.at(-1)?.header.kind).toBe("half-close");

    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 4,
      kind: "close",
      code: "normal",
    });
    expect(broker.stats()).toMatchObject({
      activeConnections: 0,
      openedConnections: 1,
      closedConnections: 1,
      bytesFromSource: 3,
      bytesToSource: 2,
    });
    broker.close();
  });

  it("supports concurrent connection identities on one logical tunnel", () => {
    const { broker, destination, source } = setup();
    for (const connectionId of ["connection-1", "connection-2"]) {
      source.emit({
        ...identity,
        connectionId,
        sequence: 0,
        kind: "open",
        initialCreditBytes: 1,
      });
      destination.emit({
        ...identity,
        connectionId,
        sequence: 0,
        kind: "accepted",
        initialCreditBytes: 1,
      });
    }
    expect(broker.stats().activeConnections).toBe(2);
    broker.close();
    expect(broker.stats().activeConnections).toBe(0);
  });

  it("rejects excess connections and fails congestion or credit violations closed", () => {
    const { broker, destination, source } = setup({
      maxConnectionsPerTunnel: 1,
    });
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 1,
    });
    source.emit({
      ...identity,
      connectionId: "connection-2",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 1,
    });
    expect(source.sent.at(-1)?.header).toMatchObject({
      kind: "rejected",
      code: "limit-exceeded",
    });

    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 1,
    });
    source.emit(
      {
        ...identity,
        connectionId: "connection-1",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
      },
      new Uint8Array([1, 2]),
    );
    expect(broker.stats().activeConnections).toBe(0);
    expect(destination.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "protocol-error",
    });
    expect(broker.stats().terminationsByReason["protocol-error"]).toBe(1);
    broker.close();

    const congested = setup();
    congested.source.emit({
      ...identity,
      connectionId: "connection-congested",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    congested.destination.emit({
      ...identity,
      connectionId: "connection-congested",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 8,
    });
    congested.destination.failSend = true;
    congested.source.emit(
      {
        ...identity,
        connectionId: "connection-congested",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
      },
      new Uint8Array([1]),
    );
    expect(congested.source.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "congested",
    });
    expect(congested.broker.stats().activeConnections).toBe(0);
    congested.broker.close();
  });

  it("cleans up revocation, endpoint disconnect, idle, lifetime, and bandwidth limits", () => {
    let now = 1_000;
    const { broker, destination, source } = setup({
      idleTimeoutMs: 100,
      maxLifetimeMs: 200,
      maxBytesPerSecond: 1,
      now: () => now,
    });
    source.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    destination.emit({
      ...identity,
      connectionId: "connection-1",
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 8,
    });
    source.emit(
      {
        ...identity,
        connectionId: "connection-1",
        sequence: 1,
        kind: "data",
        direction: "source-to-destination",
      },
      new Uint8Array([1, 2]),
    );
    expect(destination.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "bandwidth-limit",
    });

    source.emit({
      ...identity,
      connectionId: "connection-2",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    now += 101;
    broker.sweep();
    expect(source.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "idle-timeout",
    });

    source.emit({
      ...identity,
      connectionId: "connection-3",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    expect(broker.revokeAttachment(identity.attachmentId)).toBe(1);
    expect(broker.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 0,
    });
    const destinationFrames = destination.sent.length;
    source.emit({
      ...identity,
      connectionId: "stale-attachment",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    expect(destination.sent).toHaveLength(destinationFrames);
    destination.disconnect();
    broker.close();

    const disconnected = setup();
    disconnected.source.emit({
      ...identity,
      connectionId: "connection-disconnect",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    disconnected.destination.disconnect();
    expect(disconnected.broker.stats()).toMatchObject({
      activeConnections: 0,
      activeRoutes: 0,
    });
    expect(disconnected.source.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "endpoint-disconnected",
    });
    disconnected.broker.close();

    let lifetimeNow = 5_000;
    const lifetime = setup({
      idleTimeoutMs: 10_000,
      maxLifetimeMs: 100,
      now: () => lifetimeNow,
    });
    lifetime.source.emit({
      ...identity,
      connectionId: "connection-lifetime",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 8,
    });
    lifetimeNow += 101;
    lifetime.broker.sweep();
    expect(lifetime.source.sent.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "lifetime-expired",
    });
    lifetime.broker.close();
  });

  it("treats a worker-A source and worker-B destination as ordinary adapters", () => {
    const { broker, destination, source } = setup();
    expect(source.placement).toEqual({ kind: "worker", workerId: "worker-a" });
    expect(destination.placement).toEqual({
      kind: "worker",
      workerId: "worker-b",
    });
    source.emit({
      ...identity,
      connectionId: "future-worker-relay",
      sequence: 0,
      kind: "open",
      initialCreditBytes: 1,
    });
    expect(destination.sent.at(-1)?.header).toMatchObject({ kind: "connect" });
    broker.close();
  });
});
