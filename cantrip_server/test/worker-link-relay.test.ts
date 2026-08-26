import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import { WorkerLinkRelay } from "../src/worker-links/relay.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const empty = new Uint8Array();

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
    header: WorkerLinkFrameHeader;
    payload: Uint8Array;
    workerId: string;
  }> = [];
  frameListener:
    ((header: WorkerLinkFrameHeader, payload: Uint8Array) => void) | null =
    null;
  offlineListener: (() => void) | null = null;

  sendWorkerLinkFrame = vi.fn(
    (workerId: string, header: WorkerLinkFrameHeader, payload: Uint8Array) => {
      this.delivered.push({ workerId, header, payload });
      return true;
    },
  );

  subscribeWorkerLinkFrames(
    _workerId: string,
    listener: (header: WorkerLinkFrameHeader, payload: Uint8Array) => void,
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

    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);
    expect(workers.delivered).toEqual([
      { workerId: "worker-1", header: open, payload: empty },
    ]);

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
    workers.frameListener?.(accept, empty);
    expect(decodeWorkerLinkFrame(socket.sent[0]!)).toEqual({
      header: accept,
      payload: empty,
    });
    expect(relay.stats()).toEqual({ channels: 1, connections: 1 });
    relay.close();
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
    expect(workers.delivered.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "endpoint-disconnected",
      channel: open.channel,
      sequence: 1,
    });
    expect(relay.stats()).toEqual({ channels: 0, connections: 0 });
  });

  it("closes the relay when worker output skips its per-channel sequence", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const socket = new FakeSocket();
    const open = openFrame();
    relay.attach(session(), socket);
    socket.emit("message", encodeWorkerLinkFrame(open, empty), true);

    workers.frameListener?.(
      {
        protocolVersion: 1,
        sessionId: open.sessionId,
        routeGeneration: open.routeGeneration,
        effectiveRoute: "relay",
        channel: open.channel,
        lane: open.lane,
        sequence: 1,
        kind: "accept",
        initialCreditBytes: 1_024,
      },
      empty,
    );
    expect(socket.closes.at(-1)?.code).toBe(1008);
    expect(relay.stats()).toEqual({ channels: 0, connections: 0 });
  });

  it("rejects non-relay sessions and ends relays when the worker is offline", () => {
    const workers = new FakeWorkerBus();
    const relay = new WorkerLinkRelay(workers.asBus());
    const localSocket = new FakeSocket();
    expect(
      relay.attach(
        { ...session(), preferredRoute: "local", routeGeneration: 1 },
        localSocket,
      ),
    ).toBe(false);
    expect(localSocket.closes.at(-1)?.code).toBe(1013);

    const alreadyClosedSocket = new FakeSocket();
    alreadyClosedSocket.readyState = 3;
    expect(relay.attach(session(), alreadyClosedSocket)).toBe(false);
    expect(relay.stats().connections).toBe(0);

    const relaySocket = new FakeSocket();
    relay.attach(session(), relaySocket);
    workers.offlineListener?.();
    expect(relaySocket.closes.at(-1)?.reason).toMatch(/offline/i);
  });
});
