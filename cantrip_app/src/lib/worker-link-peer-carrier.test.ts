import {
  WORKER_LINK_PEER_CONTROL_CHANNEL,
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  workerLinkPeerHandshakeSchema,
  workerLinkPeerLaneChannelLabel,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerMailbox,
  type WorkerLinkPeerSessionDescriptor,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import { openWorkerLinkPeerCarrier } from "./worker-link-peer-carrier";

class FakeDataChannel {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState: RTCDataChannelState = "connecting";
  readonly sent: unknown[] = [];

  constructor(readonly label: string) {}

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(value: unknown): void {
    this.sent.push(value);
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate:
    ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  readonly channels = new Map<string, FakeDataChannel>();
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly getStats = vi.fn(async () => new Map());

  createDataChannel(label: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.set(label, channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\n" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

const identity = {
  serverId: "server-1",
  serverGeneration: "server-generation-1",
  ownerId: "owner-1",
  accountSessionId: "account-session-1",
  clientInstanceId: "client-instance-1",
  workerId: "worker-1",
  workerProcessGeneration: "worker-process-1",
};

const session: WorkerLinkSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  identity,
  lease: {
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  },
  routePolicy: {
    priority: ["local", "lan", "wan", "relay"],
    enabled: ["local", "lan", "wan", "relay"],
  },
  routeGeneration: 2,
  preferredRoute: "lan",
};

const laneLimit = {
  maxChannels: 64,
  maxQueuedFrames: 128,
  maxQueuedBytes: 4 * 1_024 * 1_024,
  maxBytesPerSecond: 16 * 1_024 * 1_024,
};

const descriptor: WorkerLinkPeerSessionDescriptor = {
  peerSession: {
    peerSessionId: "22222222-2222-4222-8222-222222222222",
    sessionId: session.sessionId,
    identity,
    routeGeneration: session.routeGeneration,
    route: "lan",
    lease: session.lease,
  },
  configuration: {
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
  },
};

describe("WorkerLink WebRTC PeerCarrier", () => {
  it("authenticates the exact peer and carries the shared envelope by lane", async () => {
    const peer = new FakePeerConnection();
    const sentSignals: unknown[] = [];
    const deletePeerSession = vi.fn(async () => undefined);
    let mailboxDelivered = false;
    const readMailbox = vi.fn(async (): Promise<WorkerLinkPeerMailbox> => {
      const signals = mailboxDelivered
        ? []
        : [
            {
              peerSessionId: descriptor.peerSession.peerSessionId,
              sessionId: session.sessionId,
              routeGeneration: session.routeGeneration,
              route: "lan" as const,
              sender: "worker" as const,
              signalSequence: 0,
              signal: { type: "answer" as const, sdp: "v=0\r\n" },
            },
          ];
      mailboxDelivered = true;
      return {
        peerSessionId: descriptor.peerSession.peerSessionId,
        sessionId: session.sessionId,
        routeGeneration: session.routeGeneration,
        route: "lan",
        signals,
        candidateAdvertisements: [],
      };
    });
    const opening = openWorkerLinkPeerCarrier({
      route: "lan",
      session,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createPeerSession: async () => descriptor,
      deletePeerSession,
      readMailbox,
      sendSignals: async (_sessionId, _peerSessionId, signals) => {
        sentSignals.push(...signals);
      },
    });
    await vi.waitFor(() => expect(sentSignals).toHaveLength(1));
    expect(sentSignals[0]).toMatchObject({
      sender: "client",
      signalSequence: 0,
      signal: { type: "offer" },
    });
    for (const channel of peer.channels.values()) channel.open();
    const control = peer.channels.get(WORKER_LINK_PEER_CONTROL_CHANNEL)!;
    const hello = workerLinkPeerHandshakeSchema.parse(
      JSON.parse(String(control.sent[0])),
    );
    control.onmessage?.({
      data: JSON.stringify({ ...hello, role: "worker" }),
    });
    const carrier = await opening;
    expect(carrier.route).toBe("lan");
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0\r\n",
    });

    const header: WorkerLinkFrameHeader = {
      protocolVersion: 1,
      sessionId: session.sessionId,
      routeGeneration: session.routeGeneration,
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
    expect(carrier.send(header, new Uint8Array([1, 2, 3]))).toBe(true);
    const interactive = peer.channels.get(
      workerLinkPeerLaneChannelLabel("interactive"),
    )!;
    expect(
      decodeWorkerLinkFrame(new Uint8Array(interactive.sent[0] as ArrayBuffer))
        .payload,
    ).toEqual(new Uint8Array([1, 2, 3]));

    const onFrame = vi.fn();
    carrier.onFrame(onFrame);
    const response = encodeWorkerLinkFrame(
      {
        ...header,
        sequence: 2,
        direction: "worker-to-client",
      },
      new Uint8Array([9]),
    );
    interactive.onmessage?.({ data: response.buffer });
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledWith(response));

    carrier.close("test-complete");
    expect(deletePeerSession).toHaveBeenCalledWith(
      session.sessionId,
      descriptor.peerSession.peerSessionId,
    );
  });

  it("rejects a mismatched authenticated worker handshake", async () => {
    const peer = new FakePeerConnection();
    const opening = openWorkerLinkPeerCarrier({
      route: "lan",
      session,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createPeerSession: async () => descriptor,
      deletePeerSession: async () => undefined,
      readMailbox: async () => ({
        peerSessionId: descriptor.peerSession.peerSessionId,
        sessionId: session.sessionId,
        routeGeneration: session.routeGeneration,
        route: "lan",
        signals: [],
        candidateAdvertisements: [],
      }),
      sendSignals: async () => undefined,
    });
    await vi.waitFor(() => expect(peer.channels.size).toBe(6));
    for (const channel of peer.channels.values()) channel.open();
    const control = peer.channels.get(WORKER_LINK_PEER_CONTROL_CHANNEL)!;
    const hello = workerLinkPeerHandshakeSchema.parse(
      JSON.parse(String(control.sent[0])),
    );
    control.onmessage?.({
      data: JSON.stringify({
        ...hello,
        role: "worker",
        identity: { ...hello.identity, workerProcessGeneration: "spoofed" },
      }),
    });
    await expect(opening).rejects.toThrow(/identity did not match authority/i);
  });
});
