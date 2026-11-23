import {
  decodeRemoteSurfaceFrame,
  remoteSurfaceWebRtcSignalSchema,
  type RemoteSurfaceChannel,
  type RemoteSurfaceFrameHeader,
  type RemoteSurfaceWebRtcConfiguration,
  type RemoteSurfaceWebRtcSignal,
} from "@cantrip/protocol";
import { RTCPeerConnection, type RTCDataChannel } from "werift";

import { workerLogger } from "../logger.js";

const CONTROL_CHANNEL = "cantrip-control-v1";
const VISUAL_CHANNEL = "cantrip-visual-v1";
const MAX_BUFFERED_BYTES = 4 * 1_024 * 1_024;

export type WebRtcSendResult = "sent" | "dropped" | "unavailable";

export interface WorkerWebRtcAttachmentOptions {
  attachmentId: string;
  configuration: RemoteSurfaceWebRtcConfiguration;
  emitSignal(signal: RemoteSurfaceWebRtcSignal): void;
  onFrame(header: RemoteSurfaceFrameHeader, payload: Uint8Array): void;
  surfaceId: string;
}

function candidateSignal(candidate: {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}): RemoteSurfaceWebRtcSignal {
  return remoteSurfaceWebRtcSignalSchema.parse({
    type: "candidate",
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  });
}

export class WorkerWebRtcAttachment {
  readonly #attachmentId: string;
  readonly #emitSignal: (signal: RemoteSurfaceWebRtcSignal) => void;
  readonly #onFrame: (
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ) => void;
  readonly #peer: RTCPeerConnection;
  readonly #surfaceId: string;
  #answerSent = false;
  #closed = false;
  #connectedLogged = false;
  #control: RTCDataChannel | null = null;
  #pendingCandidates: RemoteSurfaceWebRtcSignal[] = [];
  #visual: RTCDataChannel | null = null;

  constructor(options: WorkerWebRtcAttachmentOptions) {
    this.#attachmentId = options.attachmentId;
    this.#emitSignal = options.emitSignal;
    this.#onFrame = options.onFrame;
    this.#surfaceId = options.surfaceId;
    this.#peer = new RTCPeerConnection({
      iceServers: options.configuration.iceServers,
      iceTransportPolicy: options.configuration.iceTransportPolicy,
    });
    workerLogger.event("debug", "Remote Surface WebRTC negotiation started", {
      event: "surface.webrtc.negotiating",
      subsystem: "remote-surface",
      operation: "connect-webrtc",
      status: "started",
      surfaceId: this.#surfaceId,
      attachmentId: this.#attachmentId,
    });

    this.#peer.onIceCandidate.subscribe((candidate) => {
      const signal = candidate
        ? candidateSignal(candidate.toJSON())
        : remoteSurfaceWebRtcSignalSchema.parse({
            type: "end-of-candidates",
          });
      if (this.#answerSent) this.#emitSignal(signal);
      else this.#pendingCandidates.push(signal);
    });
    this.#peer.onDataChannel.subscribe((channel) => this.bindChannel(channel));
    this.#peer.connectionStateChange.subscribe((state) => {
      if (state === "failed") this.fail("WebRTC peer connection failed.");
      else if (state === "closed" && !this.#closed) this.fail(null, "closed");
    });
  }

  get connected(): boolean {
    return (
      !this.#closed &&
      this.#control?.readyState === "open" &&
      this.#visual?.readyState === "open"
    );
  }

  async handleSignal(payload: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const signal = remoteSurfaceWebRtcSignalSchema.parse(
      JSON.parse(new TextDecoder().decode(payload)),
    );
    if (signal.type === "offer") {
      await this.#peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await this.#peer.createAnswer();
      const localDescription = await this.#peer.setLocalDescription(answer);
      this.#emitSignal(
        remoteSurfaceWebRtcSignalSchema.parse({
          type: "answer",
          sdp: localDescription.toSdp().sdp,
        }),
      );
      this.#answerSent = true;
      for (const pending of this.#pendingCandidates) this.#emitSignal(pending);
      this.#pendingCandidates = [];
      return;
    }
    if (signal.type === "candidate") {
      await this.#peer.addIceCandidate({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
        usernameFragment: signal.usernameFragment,
      });
      return;
    }
    if (signal.type === "end-of-candidates") {
      await this.#peer.addIceCandidate(null);
      return;
    }
    if (signal.type === "transport-state" && signal.state !== "connected") {
      await this.close(false);
    }
  }

  send(channel: RemoteSurfaceChannel, frame: Uint8Array): WebRtcSendResult {
    if (!this.connected) return "unavailable";
    const disposable = channel === "frame" || channel === "cursor";
    const target = disposable ? this.#visual : this.#control;
    if (!target || target.readyState !== "open") return "unavailable";
    if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (disposable) this.logDroppedFrame(channel, "backpressure");
      return disposable ? "dropped" : "unavailable";
    }
    try {
      target.send(Buffer.from(frame));
      return "sent";
    } catch {
      if (disposable) this.logDroppedFrame(channel, "send-failed");
      return disposable ? "dropped" : "unavailable";
    }
  }

  async close(notify = true): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#control?.close();
    this.#visual?.close();
    await this.#peer.close();
    workerLogger.event("info", "Remote Surface WebRTC transport closed", {
      event: "surface.webrtc.closed",
      subsystem: "remote-surface",
      operation: "connect-webrtc",
      status: "completed",
      surfaceId: this.#surfaceId,
      attachmentId: this.#attachmentId,
    });
    if (notify) {
      this.#emitSignal({
        type: "transport-state",
        state: "closed",
        message: null,
      });
    }
  }

  private bindChannel(channel: RTCDataChannel): void {
    if (channel.label === CONTROL_CHANNEL) this.#control = channel;
    else if (channel.label === VISUAL_CHANNEL) this.#visual = channel;
    else {
      channel.close();
      return;
    }
    channel.onMessage.subscribe((message) => {
      try {
        const bytes =
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);
        const frame = decodeRemoteSurfaceFrame(bytes);
        if (
          frame.header.surfaceId !== this.#surfaceId ||
          frame.header.attachmentId !== this.#attachmentId
        ) {
          return;
        }
        this.#onFrame(frame.header, frame.payload);
      } catch {
        // Invalid client data is ignored without affecting the WebSocket fallback.
      }
    });
    channel.stateChanged.subscribe(() => this.notifyConnected());
    this.notifyConnected();
  }

  private notifyConnected(): void {
    if (!this.connected) return;
    if (!this.#connectedLogged) {
      this.#connectedLogged = true;
      workerLogger.event("info", "Remote Surface WebRTC transport connected", {
        event: "surface.webrtc.connected",
        subsystem: "remote-surface",
        operation: "connect-webrtc",
        status: "completed",
        surfaceId: this.#surfaceId,
        attachmentId: this.#attachmentId,
      });
    }
    this.#emitSignal({
      type: "transport-state",
      state: "connected",
      message: null,
    });
  }

  private fail(
    message: string | null,
    state: "failed" | "closed" = "failed",
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    workerLogger.event(
      state === "failed" ? "warn" : "info",
      "Remote Surface WebRTC transport ended",
      {
        event:
          state === "failed"
            ? "surface.webrtc.failed"
            : "surface.webrtc.closed",
        subsystem: "remote-surface",
        operation: "connect-webrtc",
        reasonCode:
          state === "failed" ? "transport-failed" : "transport-closed",
        status: state === "failed" ? "degraded" : "completed",
        surfaceId: this.#surfaceId,
        attachmentId: this.#attachmentId,
      },
    );
    this.#emitSignal({ type: "transport-state", state, message });
    this.#control?.close();
    this.#visual?.close();
    void this.#peer.close();
  }

  private logDroppedFrame(
    channel: RemoteSurfaceChannel,
    reasonCode: string,
  ): void {
    workerLogger.sampled(
      `surface-webrtc-frame-dropped:${this.#surfaceId}:${this.#attachmentId}:${reasonCode}`,
      100,
      "trace",
      "Remote Surface WebRTC frame dropped",
      {
        event: "surface.webrtc.frame-dropped",
        subsystem: "remote-surface",
        operation: "send-frame",
        reasonCode,
        status: "dropped",
        surfaceId: this.#surfaceId,
        attachmentId: this.#attachmentId,
        channel,
      },
    );
  }
}
