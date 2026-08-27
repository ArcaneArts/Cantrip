import {
  createWorkerLinkFrame,
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerLaneLimits,
  type WorkerLinkQosLane,
  type WorkerLinkResourceKind,
  type WorkerLinkSession,
  type ValidatedWorkerLinkFrame,
} from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import { WorkerLinkRelay } from "../src/worker-links/relay.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const empty = new Uint8Array();

function validatedFrame(
  header: WorkerLinkFrameHeader,
  payload: Uint8Array = empty,
): ValidatedWorkerLinkFrame {
  return createWorkerLinkFrame(header, payload);
}

function session(): WorkerLinkSession {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
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
      issuedAt: "2026-08-26T12:00:00.000Z",
      expiresAt: "2026-08-26T12:05:00.000Z",
      absoluteExpiresAt: "2026-08-26T13:00:00.000Z",
    },
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "relay"],
    },
    routeGeneration: 2,
    preferredRoute: "relay",
  };
}

function openFrame(): Extract<WorkerLinkFrameHeader, { kind: "open" }> {
  const active = session();
  return {
    protocolVersion: 1,
    sessionId: active.sessionId,
    routeGeneration: active.routeGeneration,
    effectiveRoute: "relay",
    channel: {
      channelId: "22222222-2222-4222-8222-222222222222",
      connectionId: "33333333-3333-4333-8333-333333333333",
    },
    lane: "interactive",
    sequence: 0,
    kind: "open",
    openNonce: "44444444-4444-4444-8444-444444444444",
    channelKind: "reliable-stream",
    grant: {
      binding: {
        grantId: "55555555-5555-4555-8555-555555555555",
        grantGeneration: 1,
        sessionId: active.sessionId,
        identity: active.identity,
        resource: {
          kind: "terminal",
          resourceId: "terminal-1",
          attachmentId: null,
        },
        lanes: ["interactive"],
        operations: ["stream:open", "stream:read", "stream:write"],
        maxChannels: 1,
        lease: active.lease,
      },
      token: "a".repeat(43),
    },
    initialCreditBytes: 1_024,
  };
}

function distinctOpenFrame(input: {
  channelId: string;
  grantId: string;
  lane: WorkerLinkQosLane;
  openNonce: string;
  resourceKind?: WorkerLinkResourceKind;
}): Extract<WorkerLinkFrameHeader, { kind: "open" }> {
  const base = openFrame();
  return {
    ...base,
    channel: {
      channelId: input.channelId,
      connectionId: input.channelId,
    },
    grant: {
      ...base.grant,
      binding: {
        ...base.grant.binding,
        grantId: input.grantId,
        lanes: [input.lane],
        resource: {
          ...base.grant.binding.resource,
          kind: input.resourceKind ?? "terminal",
        },
      },
    },
    lane: input.lane,
    openNonce: input.openNonce,
  };
}

function laneLimits(
  override: Partial<WorkerLinkPeerLaneLimits> = {},
): WorkerLinkPeerLaneLimits {
  const limit = {
    maxChannels: 64,
    maxQueuedFrames: 8,
    maxQueuedBytes: 64 * 1_024,
    maxBytesPerSecond: 64 * 1_024,
  };
  return {
    events: limit,
    interactive: limit,
    stream: limit,
    realtime: limit,
    bulk: limit,
    ...override,
  };
}

class FakeSocket {
  bufferedAmount = 0;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readyState = 1;
  readonly sent: Uint8Array[] = [];

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeWorkerBus {
  readonly delivered: Array<{
    frame: ValidatedWorkerLinkFrame;
    workerId: string;
  }> = [];
  frameListener: ((frame: ValidatedWorkerLinkFrame) => void) | null = null;
  offlineListener: (() => void) | null = null;

  sendWorkerLinkFrame = vi.fn(
    (workerId: string, frame: ValidatedWorkerLinkFrame) => {
      this.delivered.push({ workerId, frame });
      return true;
    },
  );

  subscribeWorkerLinkFrames(
    _workerId: string,
    listener: (frame: ValidatedWorkerLinkFrame) => void,
  ) {
    this.frameListener = listener;
    return () => {
      if (this.frameListener === listener) this.frameListener = null;
    };
  }

  subscribeWorkerOffline(_workerId: string, listener: () => void) {
    this.offlineListener = listener;
    return () => {
      if (this.offlineListener === listener) this.offlineListener = null;
    };
  }

  subscribeWorkerDisconnect(_workerId: string, listener: () => void) {
    return this.subscribeWorkerOffline(_workerId, listener);
  }

  asBus(): WorkerCommandBus {
    return this as unknown as WorkerCommandBus;
  }
}

describe("WorkerLinkRelay", () => {
  it("forwards the same bounded frames in both directions", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const socket = new FakeSocket();
    const open = openFrame();
    expect(relay.attach(session(), socket)).toBe(true);

    const inbound = encodeWorkerLinkFrame(open, empty);
    socket.emit("message", inbound, true);
    expect(workers.delivered[0]).toMatchObject({
      workerId: "worker-1",
      frame: { header: open, payload: empty },
    });
    expect(workers.delivered[0]?.frame.bytes).toBe(inbound);

    const accept: WorkerLinkFrameHeader = {
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "relay",
      channel: open.channel,
      lane: open.lane,
      sequence: 0,
      kind: "accept",
      initialCreditBytes: 1_024,
    };
    const outbound = validatedFrame(accept);
    workers.frameListener?.(outbound);
    expect(socket.sent[0]).toBe(outbound.bytes);
    expect(decodeWorkerLinkFrame(socket.sent[0]!)).toMatchObject({
      header: accept,
      payload: empty,
    });
    expect(relay.stats()).toMatchObject({ channels: 1, connections: 1 });
    relay.close();
  });

  it("rejects malformed bytes before the validated frame reaches a worker", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const socket = new FakeSocket();
    relay.attach(session(), socket);
    const malformed = encodeWorkerLinkFrame(openFrame(), empty);
    malformed[0] ^= 0xff;

    socket.emit("message", malformed, true);

    expect(socket.closes.at(-1)).toMatchObject({
      code: 1003,
      reason: expect.stringMatching(/frame is invalid/i),
    });
    expect(workers.delivered).toHaveLength(0);
  });

  it("fails closed on stale generations and closes worker channels on disconnect", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const socket = new FakeSocket();
    const open = openFrame();
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);

    socket.emit(
      "message",
      encodeWorkerLinkFrame(
        {
          ...open,
          channel: {
            channelId: "66666666-6666-4666-8666-666666666666",
            connectionId: "77777777-7777-4777-8777-777777777777",
          },
          openNonce: "88888888-8888-4888-8888-888888888888",
          routeGeneration: open.routeGeneration + 1,
        },
        empty,
      ),
      true,
    );
    expect(socket.closes.at(-1)?.code).toBe(1008);
    expect(workers.delivered.at(-1)?.frame.header).toMatchObject({
      kind: "close",
      code: "endpoint-disconnected",
      channel: open.channel,
      sequence: 1,
    });
    expect(relay.stats()).toMatchObject({ channels: 0, connections: 0 });
  });

  it("closes the relay when worker output skips its per-channel sequence", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const socket = new FakeSocket();
    const open = openFrame();
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);

    workers.frameListener?.(
      validatedFrame({
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "relay",
        channel: open.channel,
        lane: open.lane,
        sequence: 1,
        kind: "accept",
        initialCreditBytes: 1_024,
      }),
    );
    expect(socket.closes.at(-1)?.code).toBe(1008);
    expect(relay.stats()).toMatchObject({ channels: 0, connections: 0 });
  });

  it("keeps RELAY on standby, rejects disabled RELAY, and ends offline relays", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const localSocket = new FakeSocket();
    expect(
      relay.attach(
        { ...session(), preferredRoute: "local", routeGeneration: 1 },
        localSocket,
      ),
    ).toBe(true);
    localSocket.close();

    const disabledSocket = new FakeSocket();
    expect(
      relay.attach(
        {
          ...session(),
          preferredRoute: "local",
          routeGeneration: 1,
          routePolicy: {
            priority: ["local", "lan", "wan", "relay"],
            enabled: ["local"],
          },
        },
        disabledSocket,
      ),
    ).toBe(false);
    expect(disabledSocket.closes.at(-1)?.code).toBe(1013);

    const alreadyClosedSocket = new FakeSocket();
    alreadyClosedSocket.readyState = 3;
    expect(relay.attach(session(), alreadyClosedSocket)).toBe(false);
    expect(relay.stats().connections).toBe(0);

    const relaySocket = new FakeSocket();
    relay.attach(session(), relaySocket);
    workers.offlineListener?.();
    expect(relaySocket.closes.at(-1)?.reason).toMatch(/offline/i);
  });

  it("queues congested output separately and drains higher-priority lanes first", async () => {
    vi.useFakeTimers();
    try {
      const workers = new FakeWorkerBus();
      const relay = new WorkerLinkRelay(workers.asBus(), {
        laneLimits: laneLimits(),
      });
      const socket = new FakeSocket();
      socket.bufferedAmount = 8 * 1_024 * 1_024 + 1;
      relay.attach(session(), socket);
      const bulk = distinctOpenFrame({
        channelId: "66666666-6666-4666-8666-666666666666",
        grantId: "77777777-7777-4777-8777-777777777777",
        lane: "bulk",
        openNonce: "88888888-8888-4888-8888-888888888888",
      });
      const interactive = distinctOpenFrame({
        channelId: "99999999-9999-4999-8999-999999999999",
        grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        lane: "interactive",
        openNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });
      socket.emit("message", encodeWorkerLinkFrame(bulk, empty), true);
      socket.emit("message", encodeWorkerLinkFrame(interactive, empty), true);
      for (const open of [bulk, interactive]) {
        workers.frameListener?.(
          validatedFrame({
            protocolVersion: 1,
            sessionId: open.sessionId,
            routeGeneration: open.routeGeneration,
            effectiveRoute: "relay",
            channel: open.channel,
            lane: open.lane,
            sequence: 0,
            kind: "accept",
            initialCreditBytes: 1_024,
          }),
        );
      }
      expect(relay.stats()).toMatchObject({
        queuedFrames: 2,
        queuedFramesByLane: { bulk: 1, interactive: 1 },
      });

      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(5);
      expect(
        socket.sent.map((frame) => decodeWorkerLinkFrame(frame).header.lane),
      ).toEqual(["interactive", "bulk"]);
      expect(relay.stats()).toMatchObject({ queuedBytes: 0, queuedFrames: 0 });
      relay.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when one lane exceeds its independent relay queue", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus(), {
      laneLimits: laneLimits({
        interactive: {
          maxChannels: 64,
          maxQueuedFrames: 1,
          maxQueuedBytes: 64 * 1_024,
          maxBytesPerSecond: 64 * 1_024,
        },
      }),
    });
    const socket = new FakeSocket();
    socket.bufferedAmount = 8 * 1_024 * 1_024 + 1;
    const open = openFrame();
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);
    workers.frameListener?.(
      validatedFrame({
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "relay",
        channel: open.channel,
        lane: open.lane,
        sequence: 0,
        kind: "accept",
        initialCreditBytes: 1_024,
      }),
    );
    workers.frameListener?.(
      validatedFrame(
        {
          protocolVersion: 1,
          sessionId: open.sessionId,
          routeGeneration: open.routeGeneration,
          effectiveRoute: "relay",
          channel: open.channel,
          lane: open.lane,
          sequence: 1,
          kind: "data",
          direction: "worker-to-client",
          payloadFormat: "raw",
        },
        new Uint8Array([1]),
      ),
    );
    expect(socket.closes.at(-1)).toMatchObject({
      code: 1013,
      reason: expect.stringMatching(/lane is congested/i),
    });
    expect(relay.stats()).toMatchObject({ connections: 0, queuedFrames: 0 });
  });

  it("fails closed when a congested client makes no drain progress", async () => {
    vi.useFakeTimers();
    try {
      const workers = new FakeWorkerBus();
      const relay = new WorkerLinkRelay(workers.asBus());
      const socket = new FakeSocket();
      socket.bufferedAmount = 8 * 1_024 * 1_024 + 1;
      const open = openFrame();
      relay.attach(session(), socket);
      socket.emit("message", encodeWorkerLinkFrame(open, empty), true);
      workers.frameListener?.(
        validatedFrame({
          protocolVersion: 1,
          sessionId: open.sessionId,
          routeGeneration: open.routeGeneration,
          effectiveRoute: "relay",
          channel: open.channel,
          lane: open.lane,
          sequence: 0,
          kind: "accept",
          initialCreditBytes: 1_024,
        }),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.closes.at(-1)).toMatchObject({
        code: 1013,
        reason: expect.stringMatching(/too slow/i),
      });
      expect(relay.stats()).toMatchObject({ connections: 0, queuedFrames: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one Remote Surface quota across a grant's lanes", () => {
    const workers = new FakeWorkerBus();
    const releaseSurface = vi.fn();
    const acquireRemoteSurface = vi.fn(() => releaseSurface);
    const relay = new WorkerLinkRelay(workers.asBus(), {
      acquireRemoteSurface,
    });
    const socket = new FakeSocket();
    const interactive = distinctOpenFrame({
      channelId: "66666666-6666-4666-8666-666666666666",
      grantId: "77777777-7777-4777-8777-777777777777",
      lane: "interactive",
      openNonce: "88888888-8888-4888-8888-888888888888",
      resourceKind: "remote-desktop",
    });
    interactive.grant.binding.lanes = ["interactive", "realtime"];
    interactive.grant.binding.maxChannels = 2;
    const realtime: Extract<WorkerLinkFrameHeader, { kind: "open" }> = {
      ...interactive,
      channel: {
        channelId: "99999999-9999-4999-8999-999999999999",
        connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      lane: "realtime",
      openNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(interactive, empty), true);
    socket.emit("message", encodeWorkerLinkFrame(realtime, empty), true);

    expect(acquireRemoteSurface).toHaveBeenCalledOnce();
    for (const open of [interactive, realtime]) {
      const close: WorkerLinkFrameHeader = {
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "relay",
        channel: open.channel,
        lane: open.lane,
        sequence: 1,
        kind: "close",
        code: "normal",
      };
      socket.emit("message", encodeWorkerLinkFrame(close, empty), true);
      if (open === interactive) expect(releaseSurface).not.toHaveBeenCalled();
    }
    expect(releaseSurface).toHaveBeenCalledOnce();
    relay.close();
  });

  it("meters feature traffic and enforces shared relay and Remote Surface quotas", () => {
    const workers = new FakeWorkerBus();
    const releaseSurface = vi.fn();
    const consumeRelayBytes = vi.fn(() => false);
    const record = vi.fn(() => true);
    const relay = new WorkerLinkRelay(workers.asBus(), {
      acquireRemoteSurface: vi.fn(() => releaseSurface),
      consumeRelayBytes,
      usageRecorder: { record },
    });
    const socket = new FakeSocket();
    const open = distinctOpenFrame({
      channelId: "66666666-6666-4666-8666-666666666666",
      grantId: "77777777-7777-4777-8777-777777777777",
      lane: "interactive",
      openNonce: "88888888-8888-4888-8888-888888888888",
      resourceKind: "browser",
    });
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);
    const data: WorkerLinkFrameHeader = {
      protocolVersion: 1,
      sessionId: open.sessionId,
      routeGeneration: open.routeGeneration,
      effectiveRoute: "relay",
      channel: open.channel,
      lane: open.lane,
      sequence: 1,
      kind: "data",
      direction: "client-to-worker",
      payloadFormat: "raw",
    };
    const encodedData = encodeWorkerLinkFrame(data, new Uint8Array([1, 2, 3]));
    socket.emit("message", encodedData, true);

    expect(consumeRelayBytes).toHaveBeenCalledWith("owner-1", "worker-1", 3);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "remote-surface-relay",
        direction: "ingress",
        ownerId: "owner-1",
        bytes: encodedData.byteLength,
      }),
    );
    expect(socket.closes.at(-1)).toMatchObject({
      code: 1013,
      reason: expect.stringMatching(/bandwidth quota/i),
    });
    expect(releaseSurface).toHaveBeenCalledOnce();
  });
});
