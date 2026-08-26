import {
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkResourceGrant,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientSessionIdentitySnapshot } from "./client-session";
import {
  WorkerLinkManager,
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
  route: "local" | "relay" = "local",
  routeGeneration = 1,
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
      enabled: ["local", "relay"],
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

class FakeCarrier implements WorkerLinkCarrier {
  readonly closes = new Set<WorkerLinkCarrierCloseListener>();
  closed = false;
  readonly frames = new Set<WorkerLinkCarrierFrameListener>();
  readonly sent: Array<{ header: WorkerLinkFrameHeader; payload: Uint8Array }> =
    [];
  writable = true;

  constructor(
    readonly route: "local" | "relay",
    readonly latencyMs = 5,
  ) {}

  send(header: WorkerLinkFrameHeader, payload: Uint8Array): boolean {
    if (this.closed || !this.writable) return false;
    this.sent.push({ header, payload });
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
    local?: () => Promise<WorkerLinkCarrier>;
    localSupported?: boolean;
    relay?: () => Promise<WorkerLinkCarrier>;
  } = {},
) {
  let activeIdentity: ClientSessionIdentitySnapshot | null = identity;
  let idIndex = 0;
  let identityListener: () => void = () => undefined;
  let activeSession = session();
  const dependency: WorkerLinkManagerDependencies = {
    createId: () => ids[idIndex++] ?? crypto.randomUUID(),
    createSession: vi.fn(async (_workerId, clientInstanceId) => {
      activeSession = session(clientInstanceId);
      return activeSession;
    }),
    deleteSession: vi.fn(async () => undefined),
    getIdentity: () => activeIdentity,
    localSupported: () => options.localSupported ?? true,
    now: () => now,
    openLocal:
      options.local ??
      (async () => new FakeCarrier("local") as WorkerLinkCarrier),
    openRelay:
      options.relay ??
      (async () => new FakeCarrier("relay") as WorkerLinkCarrier),
    recordTelemetry: vi.fn(async () => undefined),
    renewSession: vi.fn(async () => activeSession),
    setRoute: vi.fn(async (_sessionId, route) => {
      activeSession = session(
        activeSession.identity.clientInstanceId,
        route,
        activeSession.routeGeneration + 1,
      );
      return activeSession;
    }),
    subscribeIdentity: (listener) => {
      identityListener = listener;
      return () => undefined;
    },
  };
  return {
    dependency,
    invalidateIdentity() {
      activeIdentity = null;
      identityListener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
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

  it("keeps the pre-peer baseline deterministic for LOCAL and RELAY", async () => {
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
      local: unsupportedLocal,
      localSupported: false,
      relay: relayOnly,
    });
    const relayManager = new WorkerLinkManager(relaySetup.dependency);
    const relayReference = await relayManager.acquire("worker-1");
    expect(unsupportedLocal).not.toHaveBeenCalled();
    expect(relayOnly).toHaveBeenCalledOnce();
    expect(relaySetup.dependency.setRoute).toHaveBeenCalledOnce();
    expect(relayReference.link.preferredRoute).toBe("relay");
    relayReference.release();
    await relayManager.close();
  });

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

  it("falls back from LOCAL to the same logical RELAY link", async () => {
    const relay = new FakeCarrier("relay", 14);
    const setup = dependencies({
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

    expect(routes).toEqual(["relay:local-unavailable:2"]);
    expect(setup.dependency.setRoute).toHaveBeenCalledWith(
      session().sessionId,
      "relay",
    );
    expect(manager.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        effectiveRoutes: ["relay"],
        fallbackReason: "local-unavailable",
        latencyMs: 14,
        preferredRoute: "relay",
        routeGeneration: 2,
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
          event: "route-selected",
          route: "relay",
          latencyMs: 14,
        }),
        expect.objectContaining({
          event: "route-fallback",
          route: "relay",
          reason: "local-unavailable",
        }),
        expect.objectContaining({ event: "session-opened", route: "relay" }),
        expect.objectContaining({ event: "session-closed", route: "relay" }),
      ]),
    );
    expect(vi.mocked(setup.dependency.recordTelemetry).mock.calls[0]?.[1]).toBe(
      2,
    );
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
    expect(stream.write(new Uint8Array([1, 2, 3]))).toBe(true);

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
          event: "channel-closed",
          reason: "normal",
        }),
      ]),
    );
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
    expect(calls.flatMap((call) => call[2])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "queue-pressure",
          reason: "congested",
        }),
        expect.objectContaining({ event: "session-closed" }),
      ]),
    );
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
    const setup = dependencies({ local, relay });
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
    expect(relay).toHaveBeenCalledTimes(4 + 1);
    expect(setup.dependency.createSession).toHaveBeenCalledTimes(2);
    expect(states).toEqual(
      expect.arrayContaining(["degraded", "reconnecting", "offline"]),
    );
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

    await expect(manager.acquire("worker-1")).rejects.toThrow("relay down");
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
