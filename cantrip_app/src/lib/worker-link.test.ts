import {
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkResourceGrant,
  type WorkerLinkRoute,
  type WorkerLinkSession,
  type ValidatedWorkerLinkFrame,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientSessionIdentitySnapshot } from "./client-session";
import {
  WorkerLinkManager,
  WorkerLinkTelemetryReporter,
  type WorkerLinkEnvironmentReason,
  type WorkerLinkManagerDependencies,
} from "./worker-link";
import type {
  WorkerLinkCarrier,
  WorkerLinkCarrierCloseListener,
  WorkerLinkCarrierFrameListener,
} from "./worker-link-carriers";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

const identity: ClientSessionIdentitySnapshot = {
  accountId: "account-1",
  connectionId: "connection-1",
  generation: 1,
  incarnationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverId: "server-1",
  serverUrl: "https://cantrip.example",
  userId: "owner-1",
};

function session(
  clientInstanceId = ids[0]!,
  route: WorkerLinkRoute = "local",
  routeGeneration = 1,
  enabled: WorkerLinkRoute[] = [route],
): WorkerLinkSession {
  return {
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    identity: {
      serverId: identity.serverId,
      serverGeneration: "server-generation-1",
      ownerId: identity.userId,
      accountSessionId: "account-session-1",
      clientInstanceId,
      workerId: "worker-1",
      workerProcessGeneration: "worker-generation-1",
    },
    lease: {
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      absoluteExpiresAt: new Date(now + 3_600_000).toISOString(),
    },
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled,
    },
    routeGeneration,
    preferredRoute: route,
  };
}

function grant(activeSession: WorkerLinkSession): WorkerLinkResourceGrant {
  return {
    binding: {
      grantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      grantGeneration: 1,
      sessionId: activeSession.sessionId,
      identity: activeSession.identity,
      resource: {
        kind: "terminal",
        resourceId: "terminal-1",
        attachmentId: null,
      },
      lanes: ["interactive"],
      operations: [
        "stream:open",
        "stream:read",
        "stream:write",
        "stream:half-close",
      ],
      maxChannels: 2,
      lease: activeSession.lease,
    },
    token: "a".repeat(43),
  };
}

function observationGrant(
  activeSession: WorkerLinkSession,
): WorkerLinkResourceGrant {
  return {
    binding: {
      grantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      grantGeneration: 1,
      sessionId: activeSession.sessionId,
      identity: activeSession.identity,
      resource: {
        kind: "observations",
        resourceId: activeSession.identity.workerId,
        attachmentId: "77777777-7777-4777-8777-777777777777",
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
      lease: activeSession.lease,
    },
    token: "b".repeat(43),
  };
}

class FakeCarrier implements WorkerLinkCarrier {
  readonly closes = new Set<WorkerLinkCarrierCloseListener>();
  closed = false;
  readonly frames = new Set<WorkerLinkCarrierFrameListener>();
  readonly sent: ValidatedWorkerLinkFrame[] = [];
  writable = true;

  constructor(
    readonly route: WorkerLinkRoute,
    readonly latencyMs = 5,
  ) {}

  send(frame: ValidatedWorkerLinkFrame): boolean {
    if (this.closed || !this.writable) return false;
    this.sent.push(frame);
    return true;
  }

  onClose(listener: WorkerLinkCarrierCloseListener): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  onFrame(listener: WorkerLinkCarrierFrameListener): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closes]) listener("closed");
  }

  receive(header: WorkerLinkFrameHeader, payload = new Uint8Array()): void {
    const frame = encodeWorkerLinkFrame(header, payload);
    for (const listener of this.frames) listener(frame);
  }
}

function dependencies(
  options: {
    enabled?: WorkerLinkRoute[];
    local?: () => Promise<WorkerLinkCarrier>;
    localSupported?: boolean;
    peer?: (route: "lan" | "wan") => Promise<WorkerLinkCarrier>;
    preferredRoute?: WorkerLinkRoute;
    relay?: () => Promise<WorkerLinkCarrier>;
    renew?: (activeSession: WorkerLinkSession) => Promise<WorkerLinkSession>;
  } = {},
) {
  let activeIdentity: ClientSessionIdentitySnapshot | null = identity;
  let idIndex = 0;
  let identityListener: () => void = () => undefined;
  let environmentListener: (reason: WorkerLinkEnvironmentReason) => void = () =>
    undefined;
  const preferredRoute = options.preferredRoute ?? "local";
  const enabled = options.enabled ?? [preferredRoute];
  let activeSession = session(ids[0], preferredRoute, 1, enabled);
  const dependency: WorkerLinkManagerDependencies = {
    createId: () => ids[idIndex++] ?? crypto.randomUUID(),
    createSession: vi.fn(async (_workerId, clientInstanceId) => {
      activeSession = session(clientInstanceId, preferredRoute, 1, enabled);
      return activeSession;
    }),
    deleteSession: vi.fn(async () => undefined),
    getIdentity: () => activeIdentity,
    localSupported: () => options.localSupported ?? true,
    now: () => now,
    openLocal:
      options.local ??
      (async () => new FakeCarrier("local") as WorkerLinkCarrier),
    openPeer: async (_session, route) => {
      if (options.peer) return options.peer(route);
      throw new Error(`${route} unavailable`);
    },
    openRelay:
      options.relay ??
      (async () => new FakeCarrier("relay") as WorkerLinkCarrier),
    recordTelemetry: vi.fn(async () => undefined),
    renewSession: vi.fn(async () =>
      options.renew ? options.renew(activeSession) : activeSession,
    ),
    setRoute: vi.fn(async (_sessionId, route) => {
      activeSession = session(
        activeSession.identity.clientInstanceId,
        route,
        activeSession.routeGeneration + 1,
        enabled,
      );
      return activeSession;
    }),
    subscribeEnvironment: (listener) => {
      environmentListener = listener;
      return () => undefined;
    },
    subscribeIdentity: (listener) => {
      identityListener = listener;
      return () => undefined;
    },
  };
  return {
    dependency,
    triggerEnvironment(reason: WorkerLinkEnvironmentReason) {
      environmentListener(reason);
    },
    invalidateIdentity() {
      activeIdentity = null;
      identityListener();
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function acceptOpen(carrier: FakeCarrier, index = 0): WorkerLinkFrameHeader {
  const open = carrier.sent[index]?.header;
  if (!open || open.kind !== "open") throw new Error("Missing open frame.");
  carrier.receive({
    protocolVersion: 1,
    sessionId: open.sessionId,
    routeGeneration: open.routeGeneration,
    effectiveRoute: carrier.route,
    channel: open.channel,
    lane: open.lane,
    sequence: 0,
    kind: "accept",
    initialCreditBytes: 32,
  });
  return open;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerLinkTelemetryReporter", () => {
  it("collapses streamed surface and Terminal counters without losing bytes", async () => {
    const recordTelemetry = vi.fn<
      WorkerLinkManagerDependencies["recordTelemetry"]
    >(async () => undefined);
    const readNow = vi.fn(() => now);
    const reporter = new WorkerLinkTelemetryReporter("session-1", {
      now: readNow,
      recordTelemetry,
    });
    const surfaceFrameBytes = 1_920 * 1_080 * 4;
    const terminalWriteBytes = 256;

    for (let frame = 0; frame < 120; frame += 1) {
      reporter.record(
        1,
        "bytes-received",
        surfaceFrameBytes,
        "none",
        "realtime",
        "local",
        null,
      );
      reporter.record(
        1,
        "relay-bytes-avoided",
        surfaceFrameBytes,
        "none",
        "realtime",
        "local",
        null,
      );
      reporter.record(
        1,
        "bytes-sent",
        terminalWriteBytes,
        "none",
        "interactive",
        "local",
        null,
      );
      reporter.record(
        1,
        "relay-bytes-avoided",
        terminalWriteBytes,
        "none",
        "interactive",
        "local",
        null,
      );
    }

    await reporter.close();

    expect(recordTelemetry).toHaveBeenCalledOnce();
    expect(recordTelemetry).toHaveBeenCalledWith(
      "session-1",
      1,
      expect.arrayContaining([
        expect.objectContaining({
          event: "bytes-received",
          lane: "realtime",
          value: surfaceFrameBytes * 120,
        }),
        expect.objectContaining({
          event: "bytes-sent",
          lane: "interactive",
          value: terminalWriteBytes * 120,
        }),
        expect.objectContaining({
          event: "relay-bytes-avoided",
          lane: "realtime",
          value: surfaceFrameBytes * 120,
        }),
        expect.objectContaining({
          event: "relay-bytes-avoided",
          lane: "interactive",
          value: terminalWriteBytes * 120,
        }),
      ]),
    );
    expect(recordTelemetry.mock.calls[0]?.[2]).toHaveLength(4);
    expect(readNow).toHaveBeenCalledTimes(4);
  });

  it("keeps route transitions and latency-bearing events individually timestamped", async () => {
    let currentTime = now;
    const recordTelemetry = vi.fn<
      WorkerLinkManagerDependencies["recordTelemetry"]
    >(async () => undefined);
    const reporter = new WorkerLinkTelemetryReporter("session-1", {
      now: () => currentTime,
      recordTelemetry,
    });
    const record = (
      event: "negotiation-completed" | "route-fallback" | "route-selected",
      latencyMs: number | null,
    ) => {
      reporter.record(
        1,
        event,
        1,
        event === "route-fallback" ? "local-unavailable" : "none",
        null,
        "local",
        latencyMs,
      );
      currentTime += 10;
    };

    record("route-selected", 4);
    record("route-selected", 5);
    record("route-fallback", null);
    record("route-fallback", null);
    record("negotiation-completed", 4);
    record("negotiation-completed", 5);
    await reporter.close();

    const samples = recordTelemetry.mock.calls[0]?.[2] ?? [];
    expect(samples).toHaveLength(6);
    expect(samples.map((sample) => sample.value)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(samples.map((sample) => sample.occurredAt)).toEqual(
      Array.from({ length: 6 }, (_, index) =>
        new Date(now + index * 10).toISOString(),
      ),
    );
  });

  it("keeps additive route, lane, reason, and generation dimensions independent", async () => {
    const recordTelemetry = vi.fn<
      WorkerLinkManagerDependencies["recordTelemetry"]
    >(async () => undefined);
    const reporter = new WorkerLinkTelemetryReporter("session-1", {
      now: () => now,
      recordTelemetry,
    });

    reporter.record(
      1,
      "frame-dropped",
      2,
      "congested",
      "realtime",
      "local",
      null,
    );
    reporter.record(
      1,
      "frame-dropped",
      3,
      "congested",
      "realtime",
      "local",
      null,
    );
    reporter.record(
      1,
      "frame-dropped",
      5,
      "protocol-error",
      "realtime",
      "local",
      null,
    );
    reporter.record(
      1,
      "frame-dropped",
      7,
      "congested",
      "stream",
      "local",
      null,
    );
    reporter.record(
      1,
      "frame-dropped",
      11,
      "congested",
      "realtime",
      "relay",
      null,
    );
    reporter.record(
      2,
      "frame-dropped",
      13,
      "congested",
      "realtime",
      "local",
      null,
    );
    await reporter.close();

    expect(recordTelemetry.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(recordTelemetry.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "realtime",
          reason: "congested",
          route: "local",
          value: 5,
        }),
        expect.objectContaining({ reason: "protocol-error", value: 5 }),
        expect.objectContaining({ lane: "stream", value: 7 }),
        expect.objectContaining({ route: "relay", value: 11 }),
      ]),
    );
    expect(recordTelemetry.mock.calls[0]?.[2]).toHaveLength(4);
    expect(recordTelemetry.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({ value: 13 }),
    ]);
  });

  it("keeps generation batches bounded and drains later samples after a failed post", async () => {
    let currentTime = now;
    const recordTelemetry = vi
      .fn<WorkerLinkManagerDependencies["recordTelemetry"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const reporter = new WorkerLinkTelemetryReporter("session-1", {
      now: () => currentTime++,
      recordTelemetry,
    });

    for (let sample = 0; sample < 128; sample += 1) {
      reporter.record(1, "route-selected", 1, "none", null, "local", sample);
    }
    for (let sample = 0; sample < 2; sample += 1) {
      reporter.record(2, "route-selected", 1, "none", null, "relay", sample);
    }

    await reporter.close();

    expect(recordTelemetry).toHaveBeenCalledTimes(2);
    expect(recordTelemetry.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(recordTelemetry.mock.calls.map((call) => call[2].length)).toEqual([
      128, 2,
    ]);
  });
});

describe("WorkerLinkManager", () => {
  it("shares one exact session and releases it after the final reference", async () => {
    const setup = dependencies();
    const manager = new WorkerLinkManager(setup.dependency);

    const [first, second] = await Promise.all([
      manager.acquire("worker-1"),
      manager.acquire("worker-1"),
    ]);
    expect(first.link).toBe(second.link);
    expect(setup.dependency.createSession).toHaveBeenCalledOnce();
    expect(first.link.preferredRoute).toBe("local");
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({ consumerCount: 2, workerId: "worker-1" }),
    );

    first.release();
    expect(setup.dependency.deleteSession).not.toHaveBeenCalled();
    expect(manager.getStatusSnapshot()[0]?.consumerCount).toBe(1);
    second.release();
    await vi.waitFor(() =>
      expect(setup.dependency.deleteSession).toHaveBeenCalledOnce(),
    );
    await manager.close();
  });

  it("keeps simultaneous workers isolated beneath one client manager", async () => {
    const setup = dependencies();
    const carriers = new Map<string, FakeCarrier>();
    let sessionIndex = 0;
    setup.dependency.createSession = vi.fn(
      async (workerId, clientInstanceId) => {
        const created = session(clientInstanceId);
        sessionIndex += 1;
        return {
          ...created,
          sessionId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(sessionIndex).padStart(12, "0")}`,
          identity: { ...created.identity, workerId },
        };
      },
    );
    setup.dependency.openLocal = vi.fn(async (activeSession) => {
      const carrier = new FakeCarrier("local");
      carriers.set(activeSession.identity.workerId, carrier);
      return carrier;
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const [first, second] = await Promise.all([
      manager.acquire("worker-1"),
      manager.acquire("worker-2"),
    ]);

    expect(first.link).not.toBe(second.link);
    expect(first.link.session.sessionId).not.toBe(
      second.link.session.sessionId,
    );
    expect(
      manager
        .getStatusSnapshot()
        .map((status) => status.workerId)
        .sort(),
    ).toEqual(["worker-1", "worker-2"]);

    const firstOpening = first.link.openStream(
      grant(first.link.session),
      "interactive",
    );
    const secondOpening = second.link.openStream(
      grant(second.link.session),
      "interactive",
    );
    await vi.waitFor(() =>
      expect(
        [...carriers.values()].every((carrier) => carrier.sent.length > 0),
      ).toBe(true),
    );
    acceptOpen(carriers.get("worker-1")!);
    acceptOpen(carriers.get("worker-2")!);
    await expect(
      Promise.all([firstOpening, secondOpening]),
    ).resolves.toHaveLength(2);

    first.release();
    second.release();
    await manager.close();
  });

  it("honors LOCAL-only and RELAY-only policy without rewriting authority", async () => {
    const local = vi.fn(
      async () => new FakeCarrier("local") as WorkerLinkCarrier,
    );
    const relay = vi.fn(
      async () => new FakeCarrier("relay") as WorkerLinkCarrier,
    );
    const localSetup = dependencies({ local, relay });
    const localManager = new WorkerLinkManager(localSetup.dependency);
    const localReference = await localManager.acquire("worker-1");
    expect(local).toHaveBeenCalledOnce();
    expect(relay).not.toHaveBeenCalled();
    expect(localSetup.dependency.setRoute).not.toHaveBeenCalled();
    localReference.release();
    await localManager.close();

    const unsupportedLocal = vi.fn(
      async () => new FakeCarrier("local") as WorkerLinkCarrier,
    );
    const relayOnly = vi.fn(
      async () => new FakeCarrier("relay") as WorkerLinkCarrier,
    );
    const relaySetup = dependencies({
      enabled: ["relay"],
      local: unsupportedLocal,
      localSupported: false,
      preferredRoute: "relay",
      relay: relayOnly,
    });
    const relayManager = new WorkerLinkManager(relaySetup.dependency);
    const relayReference = await relayManager.acquire("worker-1");
    expect(unsupportedLocal).not.toHaveBeenCalled();
    expect(relayOnly).toHaveBeenCalledOnce();
    expect(relaySetup.dependency.setRoute).not.toHaveBeenCalled();
    expect(relayReference.link.preferredRoute).toBe("relay");
    relayReference.release();
    await relayManager.close();
  });

  it.each([
    {
      availablePeer: null,
      expected: "local" as const,
      expectedPeerAttempts: [] as Array<"lan" | "wan">,
      id: "same-machine-local",
      localAvailable: true,
      localSupported: true,
    },
    {
      availablePeer: "lan" as const,
      expected: "lan" as const,
      expectedPeerAttempts: ["lan"] as Array<"lan" | "wan">,
      id: "same-lan",
      localAvailable: false,
      localSupported: false,
    },
    {
      availablePeer: "wan" as const,
      expected: "wan" as const,
      expectedPeerAttempts: ["lan", "wan"] as Array<"lan" | "wan">,
      id: "public-stun-wan",
      localAvailable: false,
      localSupported: false,
    },
    {
      availablePeer: null,
      expected: "relay" as const,
      expectedPeerAttempts: ["lan", "wan"] as Array<"lan" | "wan">,
      id: "udp-blocked-relay",
      localAvailable: false,
      localSupported: false,
    },
    {
      availablePeer: null,
      expected: "relay" as const,
      expectedPeerAttempts: ["lan", "wan"] as Array<"lan" | "wan">,
      id: "listener-blocked-relay",
      localAvailable: false,
      localSupported: false,
    },
  ])(
    "$id selects $expected through the shared priority ladder",
    async (testCase) => {
      const peerAttempts: Array<"lan" | "wan"> = [];
      const relay = new FakeCarrier("relay", 50);
      const setup = dependencies({
        enabled: ["local", "lan", "wan", "relay"],
        local: async () => {
          if (!testCase.localAvailable) throw new Error("loopback unavailable");
          return new FakeCarrier("local", 1);
        },
        localSupported: testCase.localSupported,
        peer: async (route) => {
          peerAttempts.push(route);
          if (route !== testCase.availablePeer) {
            throw new Error(`${route} unavailable`);
          }
          return new FakeCarrier(route, route === "lan" ? 5 : 15);
        },
        relay: async () => relay,
      });
      const manager = new WorkerLinkManager(setup.dependency);
      const reference = await manager.acquire("worker-1");

      await vi.waitFor(() =>
        expect(peerAttempts).toEqual(testCase.expectedPeerAttempts),
      );
      await vi.waitFor(() =>
        expect(reference.link.preferredRoute).toBe(testCase.expected),
      );
      expect(reference.link.session.routePolicy.priority).toEqual([
        "local",
        "lan",
        "wan",
        "relay",
      ]);
      expect(relay.closed).toBe(false);

      reference.release();
      await manager.close();
    },
  );

  it("projects feature-neutral route, channel, consumer, and last-used status", async () => {
    vi.useFakeTimers();
    const carrier = new FakeCarrier("local", 7);
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency, {
      lastUsedStatusTtlMs: 1_000,
    });
    const changed = vi.fn();
    const unsubscribe = manager.subscribeStatus(changed);
    const reference = await manager.acquire("worker-1");

    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        activeChannelCount: 0,
        activeLinkCount: 1,
        consumerCount: 1,
        effectiveRoutes: ["local"],
        fallbackReason: null,
        freshness: "active",
        latencyMs: 7,
        preferredRoute: "local",
        routeGeneration: 1,
        state: "active",
        transitionReason: "carrier-ready",
        workerId: "worker-1",
      }),
    ]);
    expect(manager.getStatusSnapshot()[0]?.routeChannelCounts).toEqual([
      { channelCount: 0, route: "local" },
      { channelCount: 0, route: "lan" },
      { channelCount: 0, route: "wan" },
      { channelCount: 0, route: "relay" },
    ]);
    expect(JSON.stringify(manager.getStatusSnapshot())).not.toMatch(
      /account-1|owner-1|account-session|cantrip\.example|a{43}/,
    );

    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.advanceTimersByTimeAsync(0);
    const open = carrier.sent[0]?.header;
    if (!open || open.kind !== "open") throw new Error("Missing open frame.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: open.lane,
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 32,
    });
    const stream = await opening;
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({ activeChannelCount: 1, state: "active" }),
    );
    expect(manager.getStatusSnapshot()[0]?.routeChannelCounts).toEqual([
      { channelCount: 1, route: "local" },
      { channelCount: 0, route: "lan" },
      { channelCount: 0, route: "wan" },
      { channelCount: 0, route: "relay" },
    ]);

    stream.close();
    expect(manager.getStatusSnapshot()[0]?.activeChannelCount).toBe(0);
    reference.release();
    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        activeChannelCount: 0,
        activeLinkCount: 0,
        consumerCount: 0,
        effectiveRoutes: ["local"],
        freshness: "last-used",
        state: "idle",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.getStatusSnapshot()).toEqual([]);
    expect(changed).toHaveBeenCalled();
    unsubscribe();
    await manager.close();
  });

  it("opens read-only event subscriptions through the shared carrier", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    await expect(
      reference.link.openStream(
        observationGrant(reference.link.session),
        "events",
      ),
    ).rejects.toThrow(/does not authorize/i);
    const opening = reference.link.openEventSubscription(
      observationGrant(reference.link.session),
    );
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(1));
    const open = carrier.sent[0]!.header;
    expect(open).toMatchObject({
      kind: "open",
      channelKind: "event-subscription",
      lane: "events",
    });
    if (open.kind !== "open") throw new Error("Missing subscription open.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: "events",
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 64 * 1_024,
    });
    const subscription = await opening;
    const received = vi.fn();
    subscription.onData(received);
    carrier.receive(
      {
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "local",
        channel: open.channel,
        lane: "events",
        sequence: 1,
        kind: "data",
        direction: "worker-to-client",
        payloadFormat: "raw",
      },
      new Uint8Array([1, 2, 3]),
    );
    expect(received).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(subscription.write(new Uint8Array([4]))).toBe(false);
    expect(subscription.acknowledge(3)).toBe(true);
    reference.release();
    await manager.close();
  });

  it("falls back from LOCAL to the same logical RELAY link", async () => {
    const relay = new FakeCarrier("relay", 14);
    const setup = dependencies({
      enabled: ["local", "relay"],
      local: async () => {
        throw new Error("loopback unavailable");
      },
      relay: async () => relay,
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const routes: string[] = [];
    reference.link.onRouteChanged((status) =>
      routes.push(
        `${status.effectiveRoute}:${status.fallbackReason}:${status.routeGeneration}`,
      ),
    );

    await vi.waitFor(() =>
      expect(routes).toContain("relay:local-unavailable:1"),
    );
    expect(setup.dependency.setRoute).not.toHaveBeenCalled();
    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        effectiveRoutes: ["relay"],
        fallbackReason: "local-unavailable",
        latencyMs: 14,
        preferredRoute: "relay",
        routeGeneration: 1,
        state: "active",
      }),
    ]);
    reference.release();
    await vi.waitFor(() =>
      expect(setup.dependency.recordTelemetry).toHaveBeenCalled(),
    );
    const samples = vi
      .mocked(setup.dependency.recordTelemetry)
      .mock.calls.flatMap((call) => call[2]);
    expect(samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "negotiation-started",
          route: "relay",
        }),
        expect.objectContaining({
          event: "negotiation-completed",
          route: "relay",
          latencyMs: 14,
        }),
        expect.objectContaining({
          event: "route-selected",
          route: "relay",
          latencyMs: 14,
        }),
        expect.objectContaining({
          event: "route-fallback",
          route: "local",
          reason: "local-unavailable",
        }),
        expect.objectContaining({ event: "session-opened", route: "relay" }),
        expect.objectContaining({ event: "session-closed", route: "relay" }),
      ]),
    );
    expect(vi.mocked(setup.dependency.recordTelemetry).mock.calls[0]?.[1]).toBe(
      1,
    );
    await manager.close();
  });

  it("promotes new streams to LAN while preserving RELAY streams and standby", async () => {
    const relay = new FakeCarrier("relay", 40);
    const lan = new FakeCarrier("lan", 3);
    const pendingLan = deferred<WorkerLinkCarrier>();
    const peer = vi
      .fn<(route: "lan" | "wan") => Promise<WorkerLinkCarrier>>()
      .mockImplementationOnce(async () => pendingLan.promise)
      .mockRejectedValue(new Error("peer unavailable"));
    const setup = dependencies({
      enabled: ["lan", "relay"],
      peer,
      preferredRoute: "lan",
      relay: async () => relay,
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");

    expect(reference.link.preferredRoute).toBe("relay");
    expect(reference.link.session.routeGeneration).toBe(1);
    expect(setup.dependency.setRoute).not.toHaveBeenCalled();

    const relayOpening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    acceptOpen(relay);
    const relayStream = await relayOpening;
    expect(relayStream.route).toBe("relay");

    pendingLan.resolve(lan);
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("lan"));
    expect(relay.closed).toBe(false);

    const lanOpening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(lan.sent).toHaveLength(1));
    acceptOpen(lan);
    const lanStream = await lanOpening;
    expect(lanStream.route).toBe("lan");
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        activeChannelCount: 2,
        effectiveRoutes: ["lan", "relay"],
        preferredRoute: "lan",
        routeGeneration: 1,
      }),
    );
    expect(manager.getStatusSnapshot()[0]?.routeChannelCounts).toEqual([
      { channelCount: 0, route: "local" },
      { channelCount: 1, route: "lan" },
      { channelCount: 0, route: "wan" },
      { channelCount: 1, route: "relay" },
    ]);

    const lanClosed = vi.fn();
    const relayClosed = vi.fn();
    lanStream.onClose(lanClosed);
    relayStream.onClose(relayClosed);
    lan.close();
    await vi.waitFor(() => expect(lanClosed).toHaveBeenCalledOnce());
    expect(relayClosed).not.toHaveBeenCalled();
    expect(relayStream.write(new Uint8Array([1]))).toBe(true);
    await vi.waitFor(() => expect(relay.sent).toHaveLength(2));
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        activeChannelCount: 1,
        effectiveRoutes: ["relay"],
        preferredRoute: "relay",
        transitionReason: "ice-failure",
      }),
    );

    const fallbackOpening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(relay.sent).toHaveLength(3));
    acceptOpen(relay, 2);
    const fallbackStream = await fallbackOpening;
    expect(fallbackStream.route).toBe("relay");
    expect(setup.dependency.setRoute).not.toHaveBeenCalled();

    reference.release();
    await manager.close();
    const routeTransitions = vi
      .mocked(setup.dependency.recordTelemetry)
      .mock.calls.flatMap((call) => call[2]);
    expect(routeTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "route-promoted", route: "lan" }),
        expect.objectContaining({ event: "route-demoted", route: "relay" }),
      ]),
    );
  });

  it("reconnects event subscriptions after LOCAL replaces RELAY", async () => {
    const relay = new FakeCarrier("relay", 30);
    const local = new FakeCarrier("local", 2);
    const pendingLocal = deferred<WorkerLinkCarrier>();
    const setup = dependencies({
      enabled: ["local", "relay"],
      local: async () => pendingLocal.promise,
      preferredRoute: "local",
      relay: async () => relay,
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    expect(reference.link.preferredRoute).toBe("relay");

    const opening = reference.link.openEventSubscription(
      observationGrant(reference.link.session),
    );
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    acceptOpen(relay);
    const subscription = await opening;
    const closed = vi.fn();
    subscription.onClose(closed);

    pendingLocal.resolve(local);
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("local"));
    await vi.waitFor(() =>
      expect(closed).toHaveBeenCalledWith("route-replaced"),
    );
    expect(relay.closed).toBe(false);
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        activeChannelCount: 0,
        effectiveRoutes: ["local"],
        preferredRoute: "local",
        transitionReason: "route-promoted",
      }),
    );

    reference.release();
    await manager.close();
  });

  it("widens browser direct probing from LAN to WAN before retaining RELAY", async () => {
    const relay = new FakeCarrier("relay", 50);
    const wan = new FakeCarrier("wan", 12);
    const attempted: Array<"lan" | "wan"> = [];
    const setup = dependencies({
      enabled: ["local", "lan", "wan", "relay"],
      localSupported: false,
      peer: async (route) => {
        attempted.push(route);
        if (route === "lan") throw new Error("not on the same LAN");
        return wan;
      },
      relay: async () => relay,
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");

    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("wan"));
    expect(attempted).toEqual(["lan", "wan"]);
    expect(relay.closed).toBe(false);
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        effectiveRoutes: ["wan"],
        fallbackReason: "lan-unavailable",
        latencyMs: 12,
        preferredRoute: "wan",
        routeGeneration: 1,
      }),
    );
    expect(setup.dependency.setRoute).not.toHaveBeenCalled();

    reference.release();
    await manager.close();
  });

  it("multiplexes reliable streams and ignores stale route frames", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(1));
    const open = carrier.sent[0]?.header;
    if (!open || open.kind !== "open") throw new Error("Missing open frame.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: open.lane,
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 32,
    });
    const stream = await opening;
    const received = vi.fn();
    const writable = vi.fn();
    stream.onData(received);
    stream.onWritable(writable);
    expect(writable).toHaveBeenCalledOnce();
    const outbound = new Uint8Array([1, 2, 3]);
    expect(stream.write(outbound)).toBe(true);
    outbound.fill(9);

    carrier.receive(
      {
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration + 1,
        effectiveRoute: "local",
        channel: open.channel,
        lane: open.lane,
        sequence: 1,
        kind: "data",
        direction: "worker-to-client",
        payloadFormat: "raw",
      },
      new Uint8Array([9]),
    );
    expect(received).not.toHaveBeenCalled();
    carrier.receive(
      {
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "local",
        channel: open.channel,
        lane: open.lane,
        sequence: 1,
        kind: "data",
        direction: "worker-to-client",
        payloadFormat: "raw",
      },
      new Uint8Array([7, 8]),
    );
    expect(received).toHaveBeenCalledWith(new Uint8Array([7, 8]));
    expect(stream.acknowledge(3)).toBe(false);
    expect(stream.acknowledge(2)).toBe(true);
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: open.lane,
      sequence: 2,
      kind: "credit",
      direction: "client-to-worker",
      bytes: 3,
    });
    expect(writable).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(3));
    expect(carrier.sent.map((frame) => frame.header.kind)).toEqual([
      "open",
      "data",
      "credit",
    ]);
    expect(carrier.sent[1]?.payload).toEqual(new Uint8Array([1, 2, 3]));

    reference.release();
    await vi.waitFor(() =>
      expect(setup.dependency.recordTelemetry).toHaveBeenCalled(),
    );
    const samples = vi
      .mocked(setup.dependency.recordTelemetry)
      .mock.calls.flatMap((call) => call[2]);
    expect(samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "channel-opened",
          lane: "interactive",
        }),
        expect.objectContaining({ event: "bytes-sent", value: 3 }),
        expect.objectContaining({ event: "bytes-received", value: 2 }),
        expect.objectContaining({
          event: "frame-dropped",
          reason: "route-replaced",
        }),
        expect.objectContaining({
          event: "relay-bytes-avoided",
          route: "local",
          value: 5,
        }),
        expect.objectContaining({
          event: "channel-closed",
          reason: "normal",
        }),
      ]),
    );
    expect(
      samples.filter(
        (sample) =>
          sample.event === "relay-bytes-avoided" &&
          sample.route === "local" &&
          sample.lane === "interactive",
      ),
    ).toHaveLength(1);
    await manager.close();
  });

  it("reports rejected channels without duplicating their terminal event", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(1));
    const open = carrier.sent[0]!.header;
    if (open.kind !== "open") throw new Error("Missing open frame.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: open.lane,
      sequence: 0,
      kind: "reject",
      code: "grant-expired",
    });
    await expect(opening).rejects.toThrow(/grant-expired/);

    reference.release();
    await vi.waitFor(() =>
      expect(setup.dependency.recordTelemetry).toHaveBeenCalled(),
    );
    const rejected = vi
      .mocked(setup.dependency.recordTelemetry)
      .mock.calls.flatMap((call) => call[2])
      .filter((sample) => sample.event === "channel-rejected");
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "grant-expired", value: 1 }),
    ]);
    await manager.close();
  });

  it("notifies a writable stream when its saturated scheduler lane drains", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(1));
    const open = carrier.sent[0]!.header;
    if (open.kind !== "open") throw new Error("Missing open frame.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "local",
      channel: open.channel,
      lane: open.lane,
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 1_024,
    });
    const stream = await opening;
    const writable = vi.fn();
    stream.onWritable(writable);
    writable.mockClear();
    carrier.writable = false;
    for (let index = 0; index < 128; index += 1) {
      expect(stream.write(new Uint8Array([index % 255]))).toBe(true);
    }
    for (let index = 0; index < 160; index += 1) {
      expect(stream.write(new Uint8Array([255]))).toBe(false);
    }

    carrier.writable = true;
    await vi.waitFor(() => expect(writable).toHaveBeenCalled());

    reference.release();
    await vi.waitFor(() =>
      expect(setup.dependency.recordTelemetry).toHaveBeenCalled(),
    );
    const calls = vi.mocked(setup.dependency.recordTelemetry).mock.calls;
    expect(calls.every((call) => call[2].length <= 128)).toBe(true);
    const samples = calls.flatMap((call) => call[2]);
    expect(samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "queue-pressure",
          reason: "congested",
          value: 160,
        }),
        expect.objectContaining({ event: "session-closed" }),
      ]),
    );
    expect(
      samples.filter((sample) => sample.event === "queue-pressure"),
    ).toHaveLength(1);
    await manager.close();
  });

  it("schedules interactive frames ahead of queued bulk without sharing queue limits", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const sharedGrant = grant(reference.link.session);
    sharedGrant.binding.lanes = ["interactive", "bulk"];

    const openingBulk = reference.link.openStream(sharedGrant, "bulk");
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(1));
    const bulkOpen = carrier.sent[0]!.header;
    if (bulkOpen.kind !== "open") throw new Error("Missing bulk open frame.");
    carrier.receive({
      protocolVersion: 1,
      sessionId: bulkOpen.sessionId,
      routeGeneration: bulkOpen.routeGeneration,
      effectiveRoute: "local",
      channel: bulkOpen.channel,
      lane: "bulk",
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 1_024,
    });
    const bulk = await openingBulk;

    const openingInteractive = reference.link.openStream(
      sharedGrant,
      "interactive",
    );
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(2));
    const interactiveOpen = carrier.sent[1]!.header;
    if (interactiveOpen.kind !== "open") {
      throw new Error("Missing interactive open frame.");
    }
    carrier.receive({
      protocolVersion: 1,
      sessionId: interactiveOpen.sessionId,
      routeGeneration: interactiveOpen.routeGeneration,
      effectiveRoute: "local",
      channel: interactiveOpen.channel,
      lane: "interactive",
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 1_024,
    });
    const interactive = await openingInteractive;

    for (let index = 0; index < 20; index += 1) {
      expect(bulk.write(new Uint8Array([index]))).toBe(true);
    }
    expect(interactive.write(new Uint8Array([99]))).toBe(true);
    await vi.waitFor(() => expect(carrier.sent).toHaveLength(23));
    const lanes = carrier.sent.slice(2).map((frame) => frame.header.lane);
    expect(lanes[0]).toBe("interactive");
    expect(lanes.filter((lane) => lane === "bulk")).toHaveLength(20);

    reference.release();
    await manager.close();
  });

  it("revokes live links when the authenticated client identity changes", async () => {
    const carrier = new FakeCarrier("local");
    const setup = dependencies({ local: async () => carrier });
    const manager = new WorkerLinkManager(setup.dependency);
    await manager.acquire("worker-1");
    expect(manager.getStatusSnapshot()).toHaveLength(1);

    setup.invalidateIdentity();
    expect(manager.getStatusSnapshot()).toEqual([]);
    await vi.waitFor(() => expect(carrier.closed).toBe(true));
    await vi.waitFor(() =>
      expect(setup.dependency.deleteSession).toHaveBeenCalledOnce(),
    );
    await expect(manager.acquire("worker-1")).rejects.toThrow(/authenticated/i);
    await manager.close();
  });

  it("keeps a healthy local carrier and its streams across environment reprobes", async () => {
    vi.useFakeTimers();
    const initialLocal = new FakeCarrier("local", 4);
    const relay = new FakeCarrier("relay", 30);
    const openRelay = vi.fn(async () => relay as WorkerLinkCarrier);
    const local = vi.fn(async () => initialLocal as WorkerLinkCarrier);
    const setup = dependencies({
      enabled: ["local", "relay"],
      local,
      relay: openRelay,
    });
    const manager = new WorkerLinkManager(setup.dependency, {
      environmentReprobeDebounceMs: 0,
    });
    const reference = await manager.acquire("worker-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce());

    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.advanceTimersByTimeAsync(0);
    acceptOpen(initialLocal);
    const stream = await opening;
    const closed = vi.fn();
    stream.onClose(closed);

    setup.triggerEnvironment("network-change");
    await vi.advanceTimersByTimeAsync(0);
    expect(local).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(initialLocal.closed).toBe(false);
    expect(relay.closed).toBe(false);
    expect(reference.link.preferredRoute).toBe("local");
    expect(setup.dependency.createSession).toHaveBeenCalledOnce();
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: "active",
        transitionReason: "network-change",
      }),
    );

    setup.triggerEnvironment("application-resume");
    await vi.advanceTimersByTimeAsync(0);
    expect(local).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(initialLocal.closed).toBe(false);
    expect(relay.closed).toBe(false);
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: "active",
        transitionReason: "application-resume",
      }),
    );
    const sentBeforeResumeWrite = initialLocal.sent.length;
    expect(stream.write(new Uint8Array([1, 2, 3]))).toBe(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(initialLocal.sent).toHaveLength(sentBeforeResumeWrite + 1);

    reference.release();
    await manager.close();
  });

  it("reopens LOCAL on the same session when the active carrier disconnects", async () => {
    vi.useFakeTimers();
    const initialLocal = new FakeCarrier("local", 4);
    const replacementLocal = new FakeCarrier("local", 5);
    const local = vi
      .fn<() => Promise<WorkerLinkCarrier>>()
      .mockResolvedValueOnce(initialLocal)
      .mockResolvedValueOnce(replacementLocal);
    const setup = dependencies({ local });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const sessionId = reference.link.session.sessionId;
    const routeGeneration = reference.link.session.routeGeneration;

    initialLocal.close();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(local).toHaveBeenCalledTimes(2));

    expect(reference.link.session.sessionId).toBe(sessionId);
    expect(reference.link.session.routeGeneration).toBe(routeGeneration);
    expect(reference.link.preferredRoute).toBe("local");
    expect(setup.dependency.createSession).toHaveBeenCalledOnce();
    expect(manager.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        effectiveRoutes: ["local"],
        state: "active",
      }),
    );

    reference.release();
    await manager.close();
  });

  it("moves cellular to Wi-Fi to cellular through LAN, WAN, then RELAY", async () => {
    vi.useFakeTimers();
    type NetworkPhase = "cellular" | "wifi" | "blocked";
    let phase: NetworkPhase = "cellular";
    const attempts: string[] = [];
    const relay = new FakeCarrier("relay", 60);
    const setup = dependencies({
      enabled: ["lan", "wan", "relay"],
      localSupported: false,
      peer: async (route) => {
        attempts.push(`${phase}:${route}`);
        if (phase === "wifi" && route === "lan") {
          return new FakeCarrier("lan", 4);
        }
        if (phase === "cellular" && route === "wan") {
          return new FakeCarrier("wan", 18);
        }
        throw new Error(`${route} unavailable during ${phase}`);
      },
      preferredRoute: "lan",
      relay: async () => relay,
    });
    const manager = new WorkerLinkManager(setup.dependency, {
      environmentReprobeDebounceMs: 0,
    });
    const reference = await manager.acquire("worker-1");
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("wan"));

    phase = "wifi";
    setup.triggerEnvironment("network-change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("lan"));

    phase = "cellular";
    setup.triggerEnvironment("network-change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("wan"));

    phase = "blocked";
    setup.triggerEnvironment("network-change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(attempts).toEqual(
        expect.arrayContaining(["blocked:lan", "blocked:wan"]),
      ),
    );
    await vi.waitFor(() => expect(reference.link.preferredRoute).toBe("relay"));
    expect(relay.closed).toBe(false);
    expect(attempts).toEqual(
      expect.arrayContaining([
        "cellular:lan",
        "cellular:wan",
        "wifi:lan",
        "blocked:lan",
        "blocked:wan",
      ]),
    );

    reference.release();
    await manager.close();
  });

  it("adopts a renewed route generation and reconnects without stale authority", async () => {
    vi.useFakeTimers();
    const initialLocal = new FakeCarrier("local", 4);
    const replacementLocal = new FakeCarrier("local", 5);
    const local = vi
      .fn<() => Promise<WorkerLinkCarrier>>()
      .mockResolvedValueOnce(initialLocal)
      .mockResolvedValueOnce(replacementLocal);
    const setup = dependencies({
      local,
      renew: async (active) => ({
        ...active,
        lease: {
          ...active.lease,
          expiresAt: new Date(now + 900_000).toISOString(),
        },
        routeGeneration: active.routeGeneration + 1,
      }),
    });
    const manager = new WorkerLinkManager(setup.dependency);
    const reference = await manager.acquire("worker-1");
    const reasons: string[] = [];
    manager.subscribeStatus(() => {
      const reason = manager.getStatusSnapshot()[0]?.transitionReason;
      if (reason) reasons.push(reason);
    });
    const opening = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.advanceTimersByTimeAsync(0);
    acceptOpen(initialLocal);
    const stream = await opening;
    const closed = vi.fn();
    stream.onClose(closed);

    await vi.advanceTimersByTimeAsync(270_000);
    await vi.waitFor(() => expect(local).toHaveBeenCalledTimes(2));
    expect(reference.link.session.routeGeneration).toBe(2);
    expect(closed).toHaveBeenCalledWith("route-replaced");
    expect(reasons).toContain("authority-replaced");
    expect(setup.dependency.createSession).toHaveBeenCalledOnce();

    const reopened = reference.link.openStream(
      grant(reference.link.session),
      "interactive",
    );
    await vi.advanceTimersByTimeAsync(0);
    const reopenedHeader = acceptOpen(replacementLocal);
    expect(reopenedHeader.routeGeneration).toBe(2);
    await reopened;

    reference.release();
    await manager.close();
  });

  it("bounds automatic reconnect attempts while retrying LOCAL before RELAY", async () => {
    vi.useFakeTimers();
    const initial = new FakeCarrier("local");
    const local = vi
      .fn<() => Promise<WorkerLinkCarrier>>()
      .mockResolvedValueOnce(initial)
      .mockRejectedValue(new Error("local down"));
    const relay = vi
      .fn<() => Promise<WorkerLinkCarrier>>()
      .mockRejectedValue(new Error("relay down"));
    const setup = dependencies({ enabled: ["local", "relay"], local, relay });
    const manager = new WorkerLinkManager(setup.dependency);
    await manager.acquire("worker-1");
    const states: string[] = [];
    manager.subscribeStatus(() => {
      const state = manager.getStatusSnapshot()[0]?.state;
      if (state) states.push(state);
    });

    initial.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(local).toHaveBeenCalledTimes(1 + 4 + 1);
    expect(relay).toHaveBeenCalledTimes(1 + 4 + 1);
    expect(setup.dependency.createSession).toHaveBeenCalledTimes(2);
    expect(states).toEqual(expect.arrayContaining(["reconnecting", "offline"]));
    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        activeLinkCount: 1,
        effectiveRoutes: [],
        freshness: "active",
        state: "offline",
      }),
    ]);
    await manager.close();
  });

  it("retains a bounded offline status when initial route setup fails", async () => {
    vi.useFakeTimers();
    const setup = dependencies({
      enabled: ["local", "relay"],
      local: async () => {
        throw new Error("local down");
      },
      relay: async () => {
        throw new Error("relay down");
      },
    });
    const manager = new WorkerLinkManager(setup.dependency, {
      lastUsedStatusTtlMs: 500,
    });

    await expect(manager.acquire("worker-1")).rejects.toThrow(
      "No WorkerLink route could be established.",
    );
    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        activeLinkCount: 0,
        effectiveRoutes: [],
        freshness: "last-used",
        state: "offline",
        workerId: "worker-1",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getStatusSnapshot()).toEqual([]);
    await manager.close();
  });
});
