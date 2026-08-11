import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceFrameHeader,
  type RemoteSurfaceWebRtcConfiguration,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteSurfaceTransportClient,
  remoteSurfaceReconnectDelay,
  type RemoteSurfaceTransportClientOptions,
  type RemoteSurfaceWebRtcTransport,
} from "./use-remote-surface-transport";

class FakeWebSocket {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = 0;
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.emit("close", { code, reason });
  });
  readonly send = vi.fn();
  readonly url: string;
  readonly #listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = 1;
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  error(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: object): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as MessageEvent);
    }
  }
}

class FakeWebRtcTransport implements RemoteSurfaceWebRtcTransport {
  readonly close = vi.fn();
  readonly handleSignal = vi.fn(async () => undefined);
  readonly send = vi.fn(() => true);
  readonly start = vi.fn(async () => undefined);
}

const messages = {
  closeReason: "Surface closed",
  congestionReason: "Surface congested",
  connectionError: "Could not connect",
  invalidConnectionMessage: "Invalid connection message",
  invalidFrame: "Invalid frame",
};

const webrtcConfiguration: RemoteSurfaceWebRtcConfiguration = {
  iceServers: [{ urls: ["turn:relay.test:3478"] }],
  iceTransportPolicy: "relay",
  negotiationTimeoutMs: 1_000,
};

function encodedFrame(
  header: Partial<RemoteSurfaceFrameHeader>,
  payload = new Uint8Array([9]),
): ArrayBuffer {
  return Uint8Array.from(
    encodeRemoteSurfaceFrame(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 1,
        channel: "frame",
        ...header,
      },
      payload,
    ),
  ).buffer;
}

function harness(overrides: Partial<RemoteSurfaceTransportClientOptions> = {}) {
  const sockets: FakeWebSocket[] = [];
  const onConnectionState = vi.fn();
  const onError = vi.fn();
  const onFrame = vi.fn();
  const onReady = vi.fn();
  const onTransportState = vi.fn();
  const client = new RemoteSurfaceTransportClient({
    surfaceId: "surface-1",
    webSocketUrl: () => "ws://surface.test",
    messages,
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onConnectionState,
    onError,
    onFrame,
    onReady,
    onTransportState,
    ...overrides,
  });
  client.start();
  return {
    client,
    onConnectionState,
    onError,
    onFrame,
    onReady,
    onTransportState,
    sockets,
  };
}

function ready(socket: FakeWebSocket, transport: "websocket" | "webrtc") {
  socket.open();
  socket.message(
    JSON.stringify({
      type: "ready",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      transport,
      webrtc: transport === "webrtc" ? webrtcConfiguration : null,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("remoteSurfaceReconnectDelay", () => {
  it("uses bounded exponential backoff", () => {
    expect([0, 1, 2, 3, 4, 20].map(remoteSurfaceReconnectDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});

describe("RemoteSurfaceTransportClient", () => {
  it("attaches, sequences outbound frames, and rejects stale inbound frames", () => {
    const run = harness();
    expect(run.sockets).toHaveLength(1);
    expect(run.sockets[0]!.url).toBe("ws://surface.test");
    expect(run.sockets[0]!.binaryType).toBe("arraybuffer");
    expect(run.onConnectionState).toHaveBeenLastCalledWith("connecting");

    ready(run.sockets[0]!, "websocket");
    expect(run.onConnectionState).toHaveBeenLastCalledWith("ready");
    expect(run.onTransportState).toHaveBeenLastCalledWith("fallback");
    expect(run.onReady).toHaveBeenCalledOnce();

    expect(run.client.send("control", new Uint8Array([1, 2]))).toBe(true);
    expect(run.client.send("clipboard", new Uint8Array([3]))).toBe(true);
    const sent = run.sockets[0]!.send.mock.calls.map(([value]) =>
      decodeRemoteSurfaceFrame(new Uint8Array(value)),
    );
    expect(sent.map((frame) => frame.header.sequence)).toEqual([0, 1]);
    expect(sent[0]!.header.attachmentId).toBe("attachment-1");
    expect(sent[0]!.payload).toEqual(new Uint8Array([1, 2]));

    run.sockets[0]!.message(encodedFrame({ sequence: 4 }));
    run.sockets[0]!.message(encodedFrame({ sequence: 3 }));
    run.sockets[0]!.message(
      encodedFrame({ sequence: 5, surfaceId: "another-surface" }),
    );
    expect(run.onFrame).toHaveBeenCalledOnce();
    expect(run.onFrame.mock.calls[0]![0].payload).toEqual(new Uint8Array([9]));
    run.client.close();
  });

  it("prefers WebRTC and keeps signaling on the WebSocket", async () => {
    const webRtc = new FakeWebRtcTransport();
    let webRtcOptions:
      | Parameters<
          NonNullable<RemoteSurfaceTransportClientOptions["createWebRtcClient"]>
        >[0]
      | undefined;
    const run = harness({
      createWebRtcClient: (options) => {
        webRtcOptions = options;
        return webRtc;
      },
    });
    ready(run.sockets[0]!, "webrtc");
    expect(webRtc.start).toHaveBeenCalledOnce();

    expect(run.client.send("control", new Uint8Array([7]))).toBe(true);
    expect(webRtc.send).toHaveBeenCalledOnce();
    expect(run.sockets[0]!.send).not.toHaveBeenCalled();

    webRtcOptions!.onSignal({ type: "end-of-candidates" });
    expect(run.sockets[0]!.send).toHaveBeenCalledOnce();
    const signalFrame = decodeRemoteSurfaceFrame(
      new Uint8Array(run.sockets[0]!.send.mock.calls[0]![0]),
    );
    expect(signalFrame.header.channel).toBe("webrtc-signal");

    run.sockets[0]!.message(
      encodedFrame(
        { channel: "webrtc-signal", sequence: 8 },
        new TextEncoder().encode(JSON.stringify({ type: "end-of-candidates" })),
      ),
    );
    await vi.waitFor(() => expect(webRtc.handleSignal).toHaveBeenCalledOnce());
    expect(run.onFrame).not.toHaveBeenCalled();
    run.client.close();
  });

  it("closes a congested socket and reconnects with backoff", async () => {
    vi.useFakeTimers();
    const run = harness();
    ready(run.sockets[0]!, "websocket");
    run.sockets[0]!.bufferedAmount = 8 * 1_024 * 1_024 + 1;

    expect(run.client.send("control", new Uint8Array([1]))).toBe(false);
    expect(run.sockets[0]!.close).toHaveBeenCalledWith(
      1013,
      "Surface congested",
    );
    expect(run.onConnectionState).toHaveBeenLastCalledWith("reconnecting");
    await vi.advanceTimersByTimeAsync(499);
    expect(run.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.sockets).toHaveLength(2);
    expect(run.onConnectionState).toHaveBeenLastCalledWith("reconnecting");
    run.client.close();
  });

  it("reports malformed messages and cancels pending reconnects on close", async () => {
    vi.useFakeTimers();
    const run = harness();
    run.sockets[0]!.message("not json");
    expect(run.onError).toHaveBeenLastCalledWith("Invalid connection message");
    run.sockets[0]!.message(new Uint8Array([1, 2, 3]));
    expect(run.onError).toHaveBeenLastCalledWith("Invalid frame");

    run.sockets[0]!.error();
    expect(run.onError).toHaveBeenLastCalledWith("Could not connect");
    run.client.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.sockets).toHaveLength(1);
  });
});
