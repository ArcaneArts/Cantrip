import { randomUUID } from "node:crypto";

import type {
  WorkerLinkPeerConfiguration,
  WorkerLinkPeerSession,
} from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerLinkPeerGateway,
  type WorkerLinkPeerTransportFactory,
} from "./worker-link-peer-gateway.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");

function configuration(
  overrides: Partial<WorkerLinkPeerConfiguration> = {},
): WorkerLinkPeerConfiguration {
  const laneLimit = {
    maxChannels: 64,
    maxQueuedFrames: 128,
    maxQueuedBytes: 4 * 1_024 * 1_024,
    maxBytesPerSecond: 16 * 1_024 * 1_024,
  };
  return {
    directRoutes: { local: true, lan: true, wan: true },
    relayOnly: false,
    stunUrls: ["stun:stun.cloudflare.com:3478"],
    interfacePolicy: { mode: "default", interfaces: [] },
    vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
    negotiationTimeoutMs: 8_000,
    upgradeProbeTimeoutMs: 15_000,
    maxPeerSessionsPerClient: 4,
    maxPeerSessionsPerWorker: 32,
    invalidHandshakeRatePerMinute: 60,
    laneLimits: {
      events: laneLimit,
      interactive: laneLimit,
      stream: laneLimit,
      realtime: laneLimit,
      bulk: laneLimit,
    },
    ...overrides,
  };
}

function peerSession(
  overrides: Partial<WorkerLinkPeerSession> = {},
): WorkerLinkPeerSession {
  return {
    peerSessionId: randomUUID(),
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
    routeGeneration: 1,
    route: "lan",
    lease: {
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now + 120_000).toISOString(),
    },
    ...overrides,
  };
}

describe("WorkerLinkPeerGateway", () => {
  it("buffers exact sequenced signaling until a transport is registered", async () => {
    const notifications: unknown[] = [];
    const handled = vi.fn();
    const closed = vi.fn();
    let callbacks!: Parameters<WorkerLinkPeerTransportFactory["open"]>[0];
    const peer = peerSession();
    const gateway = new WorkerLinkPeerGateway({
      authorize: (candidate) => candidate.peerSessionId === peer.peerSessionId,
      emit: (notification) => {
        notifications.push(notification);
        return true;
      },
      now: () => now,
      sweepIntervalMs: 0,
    });

    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.install",
        peerSession: peer,
        configuration: configuration(),
      }),
    ).resolves.toEqual({ accepted: true });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.peer.signal",
      envelope: {
        peerSessionId: peer.peerSessionId,
        sessionId: peer.sessionId,
        routeGeneration: peer.routeGeneration,
        route: peer.route,
        sender: "client",
        signalSequence: 0,
        signal: { type: "offer", sdp: "offer-sdp" },
      },
    });
    expect(gateway.stats()).toMatchObject({
      peerSessions: 1,
      pendingSignals: 1,
    });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.signal",
        envelope: {
          peerSessionId: peer.peerSessionId,
          sessionId: peer.sessionId,
          routeGeneration: peer.routeGeneration,
          route: peer.route,
          sender: "client",
          signalSequence: 0,
          signal: { type: "offer", sdp: "replayed-offer" },
        },
      }),
    ).rejects.toThrow(/sequence/i);

    gateway.registerTransportFactory({
      open: (input) => {
        callbacks = input;
        return { close: closed, handleSignal: handled };
      },
    });
    await vi.waitFor(() =>
      expect(handled).toHaveBeenCalledWith({
        type: "offer",
        sdp: "offer-sdp",
      }),
    );
    expect(gateway.stats().pendingSignals).toBe(0);

    expect(callbacks.emitSignal({ type: "answer", sdp: "answer-sdp" })).toBe(
      true,
    );
    expect(
      callbacks.advertiseCandidates(
        [
          {
            candidate:
              "candidate:1 1 UDP 2122260223 192.168.1.20 43123 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
            usernameFragment: "fragment",
          },
        ],
        true,
      ),
    ).toBe(true);
    expect(notifications).toEqual([
      {
        type: "worker-link.peer.signal",
        envelope: {
          peerSessionId: peer.peerSessionId,
          sessionId: peer.sessionId,
          routeGeneration: 1,
          route: "lan",
          sender: "worker",
          signalSequence: 0,
          signal: { type: "answer", sdp: "answer-sdp" },
        },
      },
      expect.objectContaining({
        type: "worker-link.peer.candidates",
        advertisement: expect.objectContaining({
          advertisementSequence: 0,
          peerSessionId: peer.peerSessionId,
        }),
      }),
    ]);

    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.revoke",
        peerSessionId: peer.peerSessionId,
        sessionId: peer.sessionId,
        revocation: {
          reason: "released",
          revokedAt: new Date(now).toISOString(),
        },
      }),
    ).resolves.toEqual({ accepted: true });
    expect(closed).toHaveBeenCalledWith("released");
    expect(gateway.stats().peerSessions).toBe(0);
    await gateway.close();
  });

  it("enforces policy, peer limits, authorization, and route generations", async () => {
    let authorized = true;
    const peer = peerSession();
    const gateway = new WorkerLinkPeerGateway({
      authorize: () => authorized,
      emit: () => true,
      now: () => now,
      sweepIntervalMs: 0,
    });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.install",
        peerSession: peer,
        configuration: configuration({
          maxPeerSessionsPerClient: 1,
          maxPeerSessionsPerWorker: 1,
        }),
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.install",
        peerSession: peerSession({ sessionId: randomUUID() }),
        configuration: configuration({
          maxPeerSessionsPerClient: 1,
          maxPeerSessionsPerWorker: 1,
        }),
      }),
    ).rejects.toThrow(/limit/i);
    expect(await gateway.replaceRouteGeneration(peer.sessionId, 2)).toBe(1);
    expect(gateway.stats().peerSessions).toBe(0);

    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.install",
        peerSession: peerSession(),
        configuration: configuration({
          directRoutes: { local: true, lan: false, wan: true },
        }),
      }),
    ).rejects.toThrow(/disabled/i);

    const replacement = peerSession();
    await gateway.handleCoordinatorCommand({
      type: "worker-link.peer.install",
      peerSession: replacement,
      configuration: configuration(),
    });
    authorized = false;
    expect(await gateway.sweepExpired()).toBe(1);
    expect(gateway.stats().peerSessions).toBe(0);
    await gateway.close();
  });

  it("retires a peer after its bounded invalid-handshake rate is exceeded", async () => {
    const closed = vi.fn();
    let reportInvalidHandshake!: () => boolean;
    const peer = peerSession();
    const gateway = new WorkerLinkPeerGateway({
      authorize: () => true,
      emit: () => true,
      now: () => now,
      sweepIntervalMs: 0,
    });
    gateway.registerTransportFactory({
      open: (input) => {
        reportInvalidHandshake = input.reportInvalidHandshake;
        return { close: closed, handleSignal: () => undefined };
      },
    });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.peer.install",
      peerSession: peer,
      configuration: configuration({ invalidHandshakeRatePerMinute: 2 }),
    });

    expect(reportInvalidHandshake()).toBe(true);
    expect(reportInvalidHandshake()).toBe(true);
    expect(reportInvalidHandshake()).toBe(false);
    await vi.waitFor(() => expect(gateway.stats().peerSessions).toBe(0));
    expect(closed).toHaveBeenCalledWith("invalid-handshake-rate-limit");
    await gateway.close();
  });

  it("bounds buffered signaling by bytes before a transport is available", async () => {
    const peer = peerSession();
    const gateway = new WorkerLinkPeerGateway({
      authorize: () => true,
      emit: () => true,
      now: () => now,
      sweepIntervalMs: 0,
    });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.peer.install",
      peerSession: peer,
      configuration: configuration(),
    });
    for (let signalSequence = 0; signalSequence < 4; signalSequence += 1) {
      await gateway.handleCoordinatorCommand({
        type: "worker-link.peer.signal",
        envelope: {
          peerSessionId: peer.peerSessionId,
          sessionId: peer.sessionId,
          routeGeneration: peer.routeGeneration,
          route: peer.route,
          sender: "client",
          signalSequence,
          signal: { type: "offer", sdp: "s".repeat(900_000) },
        },
      });
    }
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.peer.signal",
        envelope: {
          peerSessionId: peer.peerSessionId,
          sessionId: peer.sessionId,
          routeGeneration: peer.routeGeneration,
          route: peer.route,
          sender: "client",
          signalSequence: 4,
          signal: { type: "offer", sdp: "s".repeat(900_000) },
        },
      }),
    ).rejects.toThrow(/capacity/i);
    expect(gateway.stats().pendingSignals).toBe(4);
    await gateway.close();
  });
});
