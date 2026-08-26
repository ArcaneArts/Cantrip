import {
  WORKER_LINK_PEER_CONTROL_CHANNEL,
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  workerLinkPeerHandshakeSchema,
  workerLinkPeerLaneChannelLabel,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerConfiguration,
  type WorkerLinkPeerSession,
} from "@cantrip/protocol/worker-link";
import type { RTCDataChannel, RTCPeerConnection } from "werift";
import { describe, expect, it, vi } from "vitest";

import { createWorkerLinkWebRtcTransportFactory } from "./worker-link-webrtc.js";
import type { WorkerLinkFrameResponder } from "./worker-link-gateway.js";

class FakeEvent<T extends unknown[]> {
  readonly listeners: Array<(...args: T) => void> = [];

  subscribe(listener: (...args: T) => void): void {
    this.listeners.push(listener);
  }

  emit(...args: T): void {
    for (const listener of this.listeners) listener(...args);
  }
}

class FakeDataChannel {
  bufferedAmount = 0;
  readonly onMessage = new FakeEvent<[string | Buffer]>();
  readyState = "open";
  readonly sent: Array<string | Buffer> = [];
  readonly stateChanged = new FakeEvent<[]>();

  constructor(readonly label: string) {}

  close(): void {
    this.readyState = "closed";
    this.stateChanged.emit();
  }

  send(value: string | Buffer): void {
    this.sent.push(value);
  }
}

class FakePeerConnection {
  readonly connectionStateChange = new FakeEvent<[string]>();
  readonly onDataChannel = new FakeEvent<[RTCDataChannel]>();
  readonly onIceCandidate = new FakeEvent<
    [
      | {
          candidate: string;
          sdpMid?: string;
          sdpMLineIndex?: number;
          usernameFragment?: string;
        }
      | undefined,
    ]
  >();
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);

  async createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return { type: "answer", sdp: "v=0\r\n" };
  }

  async setLocalDescription(): Promise<{ toSdp(): { sdp: string } }> {
    return { toSdp: () => ({ sdp: "v=0\r\n" }) };
  }
}

const now = Date.now();
const identity = {
  serverId: "server-1",
  serverGeneration: "server-generation-1",
  ownerId: "owner-1",
  accountSessionId: "account-session-1",
  clientInstanceId: "client-instance-1",
  workerId: "worker-1",
  workerProcessGeneration: "worker-process-1",
};
const peerSession: WorkerLinkPeerSession = {
  peerSessionId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  identity,
  routeGeneration: 2,
  route: "lan",
  lease: {
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 120_000).toISOString(),
  },
};
const laneLimit = {
  maxChannels: 64,
  maxQueuedFrames: 128,
  maxQueuedBytes: 4 * 1_024 * 1_024,
  maxBytesPerSecond: 16 * 1_024 * 1_024,
};
const configuration: WorkerLinkPeerConfiguration = {
  directRoutes: { local: true, lan: true, wan: true },
  relayOnly: false,
  stunUrls: ["stun:stun.cloudflare.com:3478"],
  interfacePolicy: { mode: "default", interfaces: [] },
  vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
  negotiationTimeoutMs: 1_000,
  upgradeProbeTimeoutMs: 2_000,
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
};

describe("worker WorkerLink WebRTC transport", () => {
  it("filters candidates, authenticates DTLS-bound identity, and carries frames", async () => {
    const peer = new FakePeerConnection();
    let receivedHeader: WorkerLinkFrameHeader | null = null;
    let receivedPayload: Uint8Array | null = null;
    let receivedResponder: WorkerLinkFrameResponder | null = null;
    const handleFrame = vi.fn(
      async (
        header: WorkerLinkFrameHeader,
        payload: Uint8Array,
        respond: WorkerLinkFrameResponder,
      ) => {
        receivedHeader = header;
        receivedPayload = payload;
        receivedResponder = respond;
        return true;
      },
    );
    const disconnectResponder = vi.fn(async () => 0);
    const emitSignal = vi.fn(() => true);
    const advertiseCandidates = vi.fn(() => true);
    const reportInvalidHandshake = vi.fn(() => true);
    const factory = createWorkerLinkWebRtcTransportFactory({
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      disconnectResponder,
      handleFrame,
    });
    const transport = await factory.open({
      advertiseCandidates,
      configuration,
      emitSignal,
      peerSession,
      reportInvalidHandshake,
    });
    await transport.handleSignal({ type: "offer", sdp: "v=0\r\n" });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "v=0\r\n",
    });
    expect(emitSignal).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0\r\n",
    });

    peer.onIceCandidate.emit({
      candidate: "candidate:1 1 udp 2122260223 192.168.1.20 43123 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    peer.onIceCandidate.emit({
      candidate: "candidate:2 1 udp 2122260223 1.1.1.1 43124 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    peer.onIceCandidate.emit(undefined);
    expect(advertiseCandidates).toHaveBeenNthCalledWith(
      1,
      [
        expect.objectContaining({
          candidate: expect.stringContaining("192.168"),
        }),
      ],
      false,
    );
    expect(advertiseCandidates).toHaveBeenNthCalledWith(2, [], true);

    const control = new FakeDataChannel(WORKER_LINK_PEER_CONTROL_CHANNEL);
    peer.onDataChannel.emit(control as unknown as RTCDataChannel);
    const channels = new Map<string, FakeDataChannel>();
    for (const lane of [
      "events",
      "interactive",
      "stream",
      "realtime",
      "bulk",
    ] as const) {
      const channel = new FakeDataChannel(workerLinkPeerLaneChannelLabel(lane));
      channels.set(lane, channel);
      peer.onDataChannel.emit(channel as unknown as RTCDataChannel);
    }
    const handshake = workerLinkPeerHandshakeSchema.parse({
      type: "worker-link-peer-handshake",
      protocolVersion: 1,
      role: "client",
      peerSessionId: peerSession.peerSessionId,
      sessionId: peerSession.sessionId,
      routeGeneration: peerSession.routeGeneration,
      route: peerSession.route,
      identity: peerSession.identity,
      challenge: "a".repeat(43),
    });
    control.onMessage.emit(JSON.stringify(handshake));
    expect(
      workerLinkPeerHandshakeSchema.parse(JSON.parse(String(control.sent[0]))),
    ).toMatchObject({ role: "worker", challenge: handshake.challenge });

    const header: WorkerLinkFrameHeader = {
      protocolVersion: 1,
      sessionId: peerSession.sessionId,
      routeGeneration: peerSession.routeGeneration,
      effectiveRoute: "lan",
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      lane: "interactive",
      sequence: 1,
      kind: "data",
      direction: "client-to-worker",
      payloadFormat: "raw",
    };
    channels
      .get("interactive")!
      .onMessage.emit(
        Buffer.from(encodeWorkerLinkFrame(header, new Uint8Array([7]))),
      );
    await vi.waitFor(() => expect(handleFrame).toHaveBeenCalledTimes(1));
    expect(receivedHeader).toEqual(header);
    expect(receivedPayload).toEqual(new Uint8Array([7]));
    expect(receivedResponder).toBeTypeOf("function");
    const respond = receivedResponder as unknown as WorkerLinkFrameResponder;
    expect(
      respond(
        { ...header, direction: "worker-to-client", sequence: 2 },
        new Uint8Array([8]),
      ),
    ).toBe(true);
    const outbound = channels.get("interactive")!.sent[0] as Buffer;
    expect(decodeWorkerLinkFrame(new Uint8Array(outbound)).payload).toEqual(
      new Uint8Array([8]),
    );
    expect(reportInvalidHandshake).not.toHaveBeenCalled();

    await transport.close("test-complete");
    expect(disconnectResponder).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the peer identity handshake is stale", async () => {
    const peer = new FakePeerConnection();
    const reportInvalidHandshake = vi.fn(() => true);
    const transport = await createWorkerLinkWebRtcTransportFactory({
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      disconnectResponder: async () => 0,
      handleFrame: async () => true,
    }).open({
      advertiseCandidates: () => true,
      configuration,
      emitSignal: () => true,
      peerSession,
      reportInvalidHandshake,
    });
    const control = new FakeDataChannel(WORKER_LINK_PEER_CONTROL_CHANNEL);
    peer.onDataChannel.emit(control as unknown as RTCDataChannel);
    control.onMessage.emit(
      JSON.stringify({
        type: "worker-link-peer-handshake",
        protocolVersion: 1,
        role: "client",
        peerSessionId: peerSession.peerSessionId,
        sessionId: peerSession.sessionId,
        routeGeneration: peerSession.routeGeneration,
        route: peerSession.route,
        identity: { ...peerSession.identity, accountSessionId: "stale" },
        challenge: "a".repeat(43),
      }),
    );
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalled());
    expect(reportInvalidHandshake).toHaveBeenCalledTimes(1);
    await transport.close("test-complete");
  });

  it("admits unclassified browser VPN candidates only in WAN and rejects role-invalid signaling", async () => {
    const peer = new FakePeerConnection();
    const reportInvalidHandshake = vi.fn(() => true);
    const transport = await createWorkerLinkWebRtcTransportFactory({
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      disconnectResponder: async () => 0,
      handleFrame: async () => true,
    }).open({
      advertiseCandidates: () => true,
      configuration,
      emitSignal: () => true,
      peerSession: { ...peerSession, route: "wan" },
      reportInvalidHandshake,
    });
    await transport.handleSignal({ type: "offer", sdp: "v=0\r\n" });
    await expect(
      transport.handleSignal({
        type: "candidate",
        candidate: {
          candidate: "candidate:1 1 udp 2122260223 10.147.20.3 43123 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      }),
    ).resolves.toBeUndefined();
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    await expect(
      transport.handleSignal({ type: "answer", sdp: "v=0\r\n" }),
    ).rejects.toThrow(/cannot send an answer/i);
    expect(reportInvalidHandshake).toHaveBeenCalledTimes(1);
  });
});
