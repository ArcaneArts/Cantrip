import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceWebRtcConfiguration,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteSurfaceWebRtcClient } from "./remote-surface-webrtc";

class FakeDataChannel {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState: RTCDataChannelState = "connecting";
  readonly send = vi.fn();

  constructor(readonly label: string) {}

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
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

  createDataChannel(label: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.set(label, channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nfake-offer" };
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

const configuration: RemoteSurfaceWebRtcConfiguration = {
  iceServers: [
    {
      urls: ["turn:relay.cantrip.art:3478"],
      username: "short-lived",
      credential: "credential",
    },
  ],
  iceTransportPolicy: "relay",
  negotiationTimeoutMs: 1_000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteSurfaceWebRtcClient", () => {
  it("negotiates and routes full binary envelopes over two data channels", async () => {
    const peer = new FakePeerConnection();
    const onFrame = vi.fn();
    const onSignal = vi.fn();
    const onState = vi.fn();
    const client = new RemoteSurfaceWebRtcClient({
      configuration,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      onFrame,
      onSignal,
      onState,
    });
    await client.start();
    expect(onSignal).toHaveBeenCalledWith({
      type: "offer",
      sdp: "v=0\r\nfake-offer",
    });

    peer.channels.get("cantrip-visual-v1")!.open();
    peer.channels.get("cantrip-control-v1")!.open();
    expect(client.state).toBe("connected");

    expect(
      client.send(
        {
          protocolVersion: 1,
          surfaceId: "surface-1",
          attachmentId: "attachment-1",
          sequence: 2,
          channel: "control",
        },
        new Uint8Array([4, 5]),
      ),
    ).toBe(true);
    const sent =
      peer.channels.get("cantrip-control-v1")!.send.mock.calls[0]![0];
    expect(decodeRemoteSurfaceFrame(new Uint8Array(sent)).payload).toEqual(
      new Uint8Array([4, 5]),
    );

    const incoming = Uint8Array.from(
      encodeRemoteSurfaceFrame(
        {
          protocolVersion: 1,
          surfaceId: "surface-1",
          attachmentId: "attachment-1",
          sequence: 3,
          channel: "frame",
        },
        new Uint8Array([9]),
      ),
    );
    peer.channels.get("cantrip-visual-v1")!.onmessage?.({
      data: incoming.buffer,
    });
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledWith(incoming));
    client.close();
  });

  it("falls back when relay negotiation does not finish", async () => {
    vi.useFakeTimers();
    const peer = new FakePeerConnection();
    const onSignal = vi.fn();
    const onState = vi.fn();
    const client = new RemoteSurfaceWebRtcClient({
      configuration,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      onFrame: vi.fn(),
      onSignal,
      onState,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.state).toBe("fallback");
    expect(onSignal).toHaveBeenLastCalledWith({
      type: "transport-state",
      state: "failed",
      message: "WebRTC negotiation timed out.",
    });
    expect(onState).toHaveBeenLastCalledWith("fallback");
  });
});
