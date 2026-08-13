import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteSurfaceWebRtcSignalSchema,
  type RemoteSurfaceFrameHeader,
  type RemoteSurfaceWebRtcConfiguration,
  type RemoteSurfaceWebRtcSignal,
} from "@cantrip/protocol";

const CONTROL_CHANNEL = "cantrip-control-v1";
const VISUAL_CHANNEL = "cantrip-visual-v1";
const MAX_BUFFERED_BYTES = 4 * 1_024 * 1_024;

export type RemoteSurfaceWebRtcState =
  "negotiating" | "connected" | "fallback" | "closed";
export type RemoteSurfaceWebRtcTransport =
  "webrtc-direct" | "webrtc-relay" | "webrtc-unknown";

export interface RemoteSurfaceWebRtcClientOptions {
  configuration: RemoteSurfaceWebRtcConfiguration;
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  onFrame(bytes: Uint8Array): void;
  onSignal(signal: RemoteSurfaceWebRtcSignal): void;
  onState(state: RemoteSurfaceWebRtcState): void;
  onTransport?(transport: RemoteSurfaceWebRtcTransport): void;
}

type StatsRecord = RTCStats & Record<string, unknown>;

export function classifyWebRtcTransport(
  report: Pick<RTCStatsReport, "forEach">,
): RemoteSurfaceWebRtcTransport {
  const stats = new Map<string, StatsRecord>();
  report.forEach((value) => stats.set(value.id, value as StatsRecord));
  const selectedPairId = [...stats.values()].find(
    (entry) => entry.type === "transport",
  )?.selectedCandidatePairId;
  const pair =
    (typeof selectedPairId === "string" ? stats.get(selectedPairId) : null) ??
    [...stats.values()].find(
      (entry) =>
        entry.type === "candidate-pair" &&
        entry.state === "succeeded" &&
        (entry.nominated === true || entry.selected === true),
    );
  if (!pair) return "webrtc-unknown";
  const local =
    typeof pair.localCandidateId === "string"
      ? stats.get(pair.localCandidateId)
      : null;
  const remote =
    typeof pair.remoteCandidateId === "string"
      ? stats.get(pair.remoteCandidateId)
      : null;
  const candidateTypes = [local?.candidateType, remote?.candidateType].filter(
    (value): value is string => typeof value === "string",
  );
  if (candidateTypes.includes("relay")) return "webrtc-relay";
  return candidateTypes.length > 0 ? "webrtc-direct" : "webrtc-unknown";
}

export class RemoteSurfaceWebRtcClient {
  readonly #configuration: RemoteSurfaceWebRtcConfiguration;
  readonly #control: RTCDataChannel;
  readonly #onFrame: (bytes: Uint8Array) => void;
  readonly #onSignal: (signal: RemoteSurfaceWebRtcSignal) => void;
  readonly #onState: (state: RemoteSurfaceWebRtcState) => void;
  readonly #onTransport?: (transport: RemoteSurfaceWebRtcTransport) => void;
  readonly #peer: RTCPeerConnection;
  readonly #visual: RTCDataChannel;
  #closed = false;
  #offerSent = false;
  #pendingCandidates: RemoteSurfaceWebRtcSignal[] = [];
  #state: RemoteSurfaceWebRtcState = "negotiating";
  #timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteSurfaceWebRtcClientOptions) {
    this.#configuration = options.configuration;
    this.#onFrame = options.onFrame;
    this.#onSignal = options.onSignal;
    this.#onState = options.onState;
    this.#onTransport = options.onTransport;
    const createPeerConnection =
      options.createPeerConnection ??
      ((configuration: RTCConfiguration) =>
        new RTCPeerConnection(configuration));
    this.#peer = createPeerConnection({
      iceServers: options.configuration.iceServers,
      iceTransportPolicy: options.configuration.iceTransportPolicy,
    });
    this.#visual = this.#peer.createDataChannel(VISUAL_CHANNEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    this.#control = this.#peer.createDataChannel(CONTROL_CHANNEL, {
      ordered: true,
    });
    this.bindChannel(this.#visual);
    this.bindChannel(this.#control);
    this.#peer.onicecandidate = (event) => {
      const signal = event.candidate
        ? remoteSurfaceWebRtcSignalSchema.parse({
            type: "candidate",
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          })
        : remoteSurfaceWebRtcSignalSchema.parse({
            type: "end-of-candidates",
          });
      if (this.#offerSent) this.#onSignal(signal);
      else this.#pendingCandidates.push(signal);
    };
    this.#peer.onconnectionstatechange = () => {
      if (
        this.#peer.connectionState === "failed" ||
        this.#peer.connectionState === "disconnected"
      ) {
        this.fallback("WebRTC peer connection failed.");
      }
    };
  }

  get state(): RemoteSurfaceWebRtcState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.setState("negotiating");
    this.#timeout = setTimeout(
      () => this.fallback("WebRTC negotiation timed out."),
      this.#configuration.negotiationTimeoutMs,
    );
    try {
      const offer = await this.#peer.createOffer();
      await this.#peer.setLocalDescription(offer);
      this.#onSignal(
        remoteSurfaceWebRtcSignalSchema.parse({
          type: "offer",
          sdp: this.#peer.localDescription?.sdp ?? offer.sdp,
        }),
      );
      this.#offerSent = true;
      for (const signal of this.#pendingCandidates) this.#onSignal(signal);
      this.#pendingCandidates = [];
    } catch {
      this.fallback("WebRTC offer creation failed.");
    }
  }

  async handleSignal(payload: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const signal = remoteSurfaceWebRtcSignalSchema.parse(
      JSON.parse(new TextDecoder().decode(payload)),
    );
    try {
      if (signal.type === "answer") {
        await this.#peer.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        });
      } else if (signal.type === "candidate") {
        await this.#peer.addIceCandidate({
          candidate: signal.candidate,
          sdpMid: signal.sdpMid,
          sdpMLineIndex: signal.sdpMLineIndex,
          usernameFragment: signal.usernameFragment,
        });
      } else if (signal.type === "end-of-candidates") {
        await this.#peer.addIceCandidate(null);
      } else if (
        signal.type === "transport-state" &&
        signal.state !== "connected"
      ) {
        this.fallback(signal.message ?? "Worker WebRTC transport closed.");
      }
    } catch {
      this.fallback("WebRTC signaling failed.");
    }
  }

  send(header: RemoteSurfaceFrameHeader, payload: Uint8Array): boolean {
    if (this.#state !== "connected") return false;
    const visual = header.channel === "frame" || header.channel === "cursor";
    const channel = visual ? this.#visual : this.#control;
    if (
      channel.readyState !== "open" ||
      channel.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return false;
    }
    try {
      channel.send(
        Uint8Array.from(encodeRemoteSurfaceFrame(header, payload)).buffer,
      );
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = null;
    this.#control.close();
    this.#visual.close();
    this.#peer.close();
    this.setState("closed");
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.maybeConnected();
    channel.onclose = () => {
      if (!this.#closed) this.fallback("WebRTC data channel closed.");
    };
    channel.onerror = () => {
      if (!this.#closed) this.fallback("WebRTC data channel failed.");
    };
    channel.onmessage = (event) => {
      void this.readMessage(event.data);
    };
  }

  private async readMessage(data: unknown): Promise<void> {
    try {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : typeof data === "string"
                ? new TextEncoder().encode(data)
                : null;
      if (!bytes) return;
      decodeRemoteSurfaceFrame(bytes);
      this.#onFrame(bytes);
    } catch {
      // Invalid data is isolated to the WebRTC path; WebSocket remains available.
    }
  }

  private maybeConnected(): void {
    if (
      this.#control.readyState !== "open" ||
      this.#visual.readyState !== "open"
    ) {
      return;
    }
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = null;
    this.setState("connected");
    this.#onTransport?.("webrtc-unknown");
    void this.reportSelectedTransport();
  }

  private async reportSelectedTransport(): Promise<void> {
    try {
      const transport = classifyWebRtcTransport(await this.#peer.getStats());
      if (!this.#closed && this.#state === "connected") {
        this.#onTransport?.(transport);
      }
    } catch {
      // Connected WebRTC remains usable when a platform cannot expose ICE stats.
    }
  }

  private fallback(message: string): void {
    if (this.#closed || this.#state === "fallback") return;
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = null;
    this.#onSignal({ type: "transport-state", state: "failed", message });
    this.setState("fallback");
    this.#control.close();
    this.#visual.close();
    this.#peer.close();
  }

  private setState(state: RemoteSurfaceWebRtcState): void {
    if (this.#state === state && state !== "negotiating") return;
    this.#state = state;
    this.#onState(state);
  }
}
