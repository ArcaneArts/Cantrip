import { networkInterfaces } from "node:os";

import {
  WORKER_LINK_PEER_CONTROL_CHANNEL,
  classifyWorkerLinkPeerAddress,
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  filterWorkerLinkPeerSdp,
  parseWorkerLinkPeerCandidate,
  workerLinkPeerCandidateAllowed,
  workerLinkPeerCandidateSchema,
  workerLinkPeerHandshakeSchema,
  workerLinkPeerInterfaceAllowed,
  workerLinkPeerInterfaceIsVpn,
  workerLinkPeerLaneChannelLabel,
  workerLinkQosLaneSchema,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerCandidate,
  type WorkerLinkPeerCandidateRouteContext,
  type WorkerLinkPeerConfiguration,
  type WorkerLinkPeerHandshake,
  type WorkerLinkPeerSession,
  type WorkerLinkPeerSignal,
  type WorkerLinkQosLane,
} from "@cantrip/protocol/worker-link";
import { RTCPeerConnection, type RTCDataChannel } from "werift";

import type { WorkerLinkFrameResponder } from "./worker-link-gateway.js";
import type {
  WorkerLinkPeerTransport,
  WorkerLinkPeerTransportFactory,
} from "./worker-link-peer-gateway.js";

const LANES = workerLinkQosLaneSchema.options;

export interface WorkerLinkWebRtcTransportFactoryOptions {
  createPeerConnection?: (
    configuration: ConstructorParameters<typeof RTCPeerConnection>[0],
  ) => RTCPeerConnection;
  disconnectResponder(respond: WorkerLinkFrameResponder): Promise<number>;
  handleFrame(
    header: WorkerLinkFrameHeader,
    payload: Uint8Array,
    respond: WorkerLinkFrameResponder,
  ): Promise<boolean>;
}

interface InterfaceBinding extends WorkerLinkPeerCandidateRouteContext {
  allowed: boolean;
  name: string;
}

interface LaneRateState {
  bytes: number;
  windowStartedAt: number;
}

export function createWorkerLinkWebRtcTransportFactory(
  gateway: WorkerLinkWebRtcTransportFactoryOptions,
): WorkerLinkPeerTransportFactory {
  return {
    open: (input) => new WorkerLinkWebRtcTransport(input, gateway),
  };
}

class WorkerLinkWebRtcTransport implements WorkerLinkPeerTransport {
  #authenticated = false;
  #closed = false;
  #connectedReported = false;
  readonly #configuration: WorkerLinkPeerConfiguration;
  #control: RTCDataChannel | null = null;
  readonly #gateway: WorkerLinkWebRtcTransportFactoryOptions;
  readonly #interfaces: ReadonlyMap<string, InterfaceBinding>;
  readonly #lanes = new Map<WorkerLinkQosLane, RTCDataChannel>();
  #offerAccepted = false;
  readonly #peer: RTCPeerConnection;
  readonly #peerSession: WorkerLinkPeerSession;
  readonly #rate = new Map<WorkerLinkQosLane, LaneRateState>();
  readonly #respond: WorkerLinkFrameResponder;
  readonly #transportInput: Parameters<
    WorkerLinkPeerTransportFactory["open"]
  >[0];

  constructor(
    input: Parameters<WorkerLinkPeerTransportFactory["open"]>[0],
    gateway: WorkerLinkWebRtcTransportFactoryOptions,
  ) {
    this.#transportInput = input;
    this.#gateway = gateway;
    this.#peerSession = input.peerSession;
    this.#configuration = input.configuration;
    this.#interfaces = interfaceBindings(input.configuration);
    this.#respond = (header, payload) => this.#send(header, payload);
    const createPeerConnection =
      gateway.createPeerConnection ??
      ((configuration: ConstructorParameters<typeof RTCPeerConnection>[0]) =>
        new RTCPeerConnection(configuration));
    this.#peer = createPeerConnection({
      iceServers:
        this.#peerSession.route === "wan" &&
        this.#configuration.stunUrls.length > 0
          ? [{ urls: this.#configuration.stunUrls }]
          : [],
      iceTransportPolicy: "all",
      iceUseIpv4: true,
      iceUseIpv6: true,
      iceUseTcp: false,
      iceUseLinkLocalAddress: this.#peerSession.route === "lan",
      iceFilterCandidatePair: (pair) =>
        this.#candidateAllowed(candidateFromPair(pair.localCandidate)) &&
        this.#candidateAllowed(candidateFromPair(pair.remoteCandidate), false),
    });
    this.#peer.onIceCandidate.subscribe((candidate) => {
      if (this.#closed) return;
      if (!candidate) {
        input.advertiseCandidates([], true);
        return;
      }
      const parsed = workerLinkPeerCandidateSchema.parse({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        usernameFragment: candidate.usernameFragment ?? null,
      });
      if (this.#candidateAllowed(parsed)) {
        input.advertiseCandidates([parsed], false);
      }
    });
    this.#peer.onDataChannel.subscribe((channel) => this.#bindChannel(channel));
    this.#peer.connectionStateChange.subscribe((state) => {
      if (["failed", "disconnected", "closed"].includes(state)) {
        void this.close(`peer-${state}`);
      }
    });
  }

  async handleSignal(signal: WorkerLinkPeerSignal): Promise<void> {
    if (this.#closed) return;
    try {
      if (signal.type === "offer") {
        if (this.#offerAccepted) {
          throw new Error("Peer offer was replayed.");
        }
        const filtered = filterWorkerLinkPeerSdp(
          signal.sdp,
          this.#peerSession.route,
        );
        if (filtered.removedCandidates > 0) {
          throw new Error("Peer offer contained a disallowed ICE candidate.");
        }
        await this.#peer.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        });
        const answer = await this.#peer.createAnswer();
        const local = await this.#peer.setLocalDescription(answer);
        const localSdp = local.toSdp().sdp;
        const filteredAnswer = filterWorkerLinkPeerSdp(
          localSdp,
          this.#peerSession.route,
          (address, candidate) =>
            this.#interfaces.get(normalizeAddress(address)) ??
            (candidate.relatedAddress
              ? this.#interfaces.get(normalizeAddress(candidate.relatedAddress))
              : undefined) ??
            {},
        );
        this.#transportInput.emitSignal({
          type: "answer",
          sdp: filteredAnswer.sdp,
        });
        this.#offerAccepted = true;
        return;
      }
      if (signal.type === "candidate") {
        if (!this.#offerAccepted) {
          throw new Error("Peer candidate preceded its offer.");
        }
        if (!this.#candidateAllowed(signal.candidate, false)) {
          throw new Error("Peer signal contained a disallowed ICE candidate.");
        }
        await this.#peer.addIceCandidate(signal.candidate);
        return;
      }
      if (signal.type === "end-of-candidates") {
        if (!this.#offerAccepted) {
          throw new Error("Peer candidate completion preceded its offer.");
        }
        await this.#peer.addIceCandidate(null);
        return;
      }
      if (signal.type === "answer") {
        throw new Error("A WorkerLink client cannot send an answer.");
      }
      if (signal.type === "transport-state") {
        if (signal.state === "connected") {
          throw new Error(
            "A WorkerLink client cannot assert transport readiness.",
          );
        }
        await this.close(`client-${signal.state}`);
      }
    } catch (error) {
      this.#transportInput.reportInvalidHandshake();
      await this.close("invalid-peer-signal");
      throw error;
    }
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#control?.close();
    for (const channel of this.#lanes.values()) channel.close();
    await this.#peer.close();
    await this.#gateway.disconnectResponder(this.#respond);
    this.#transportInput.emitSignal({
      type: "transport-state",
      state: "closed",
      message: reason.slice(0, 2_048),
    });
  }

  #bindChannel(channel: RTCDataChannel): void {
    if (channel.label === WORKER_LINK_PEER_CONTROL_CHANNEL) {
      if (this.#control) {
        this.#rejectChannel(channel);
        return;
      }
      this.#control = channel;
      channel.onMessage.subscribe((message) => this.#handleHandshake(message));
      channel.stateChanged.subscribe(() => this.#maybeConnected());
      this.#maybeConnected();
      return;
    }
    const lane = LANES.find(
      (candidate) =>
        workerLinkPeerLaneChannelLabel(candidate) === channel.label,
    );
    if (!lane || this.#lanes.has(lane)) {
      this.#rejectChannel(channel);
      return;
    }
    this.#lanes.set(lane, channel);
    channel.onMessage.subscribe((message) => {
      void this.#handleFrame(lane, message);
    });
    channel.stateChanged.subscribe(() => this.#maybeConnected());
    this.#maybeConnected();
  }

  #handleHandshake(message: string | Buffer): void {
    try {
      if (this.#authenticated) {
        throw new Error("Peer handshake was replayed.");
      }
      if (typeof message !== "string") {
        throw new Error("Peer handshake must be textual JSON.");
      }
      const handshake = workerLinkPeerHandshakeSchema.parse(
        JSON.parse(message),
      );
      if (
        handshake.role !== "client" ||
        !handshakeMatches(handshake, this.#peerSession)
      ) {
        throw new Error("Peer handshake authority did not match.");
      }
      this.#authenticated = true;
      this.#control?.send(
        JSON.stringify({
          ...handshake,
          role: "worker",
        } satisfies WorkerLinkPeerHandshake),
      );
      this.#maybeConnected();
    } catch {
      this.#transportInput.reportInvalidHandshake();
      void this.close("invalid-peer-handshake");
    }
  }

  async #handleFrame(
    lane: WorkerLinkQosLane,
    message: string | Buffer,
  ): Promise<void> {
    try {
      if (!this.#authenticated || typeof message === "string") {
        throw new Error("Peer frame arrived before authentication.");
      }
      const frame = decodeWorkerLinkFrame(new Uint8Array(message));
      if (
        frame.header.sessionId !== this.#peerSession.sessionId ||
        frame.header.routeGeneration !== this.#peerSession.routeGeneration ||
        frame.header.effectiveRoute !== this.#peerSession.route ||
        frame.header.lane !== lane
      ) {
        throw new Error("Peer frame authority is stale.");
      }
      await this.#gateway.handleFrame(
        frame.header,
        frame.payload,
        this.#respond,
      );
    } catch {
      this.#transportInput.reportInvalidHandshake();
      await this.close("invalid-peer-frame");
    }
  }

  #send(header: WorkerLinkFrameHeader, payload: Uint8Array): boolean {
    if (
      this.#closed ||
      !this.#authenticated ||
      header.sessionId !== this.#peerSession.sessionId ||
      header.routeGeneration !== this.#peerSession.routeGeneration ||
      header.effectiveRoute !== this.#peerSession.route
    ) {
      return false;
    }
    const channel = this.#lanes.get(header.lane);
    const limits = this.#configuration.laneLimits[header.lane];
    const frame = encodeWorkerLinkFrame(header, payload);
    if (
      !channel ||
      channel.readyState !== "open" ||
      channel.bufferedAmount + frame.byteLength > limits.maxQueuedBytes ||
      !this.#consumeRate(
        header.lane,
        frame.byteLength,
        limits.maxBytesPerSecond,
      )
    ) {
      return false;
    }
    try {
      channel.send(Buffer.from(frame));
      return true;
    } catch {
      void this.close("peer-send-failed");
      return false;
    }
  }

  #candidateAllowed(candidate: WorkerLinkPeerCandidate, local = true): boolean {
    const parsed = parseWorkerLinkPeerCandidate(candidate.candidate);
    if (!parsed) return false;
    const context: WorkerLinkPeerCandidateRouteContext & {
      allowed?: boolean;
    } = local
      ? (this.#interfaces.get(normalizeAddress(parsed.address)) ??
        (parsed.relatedAddress
          ? this.#interfaces.get(normalizeAddress(parsed.relatedAddress))
          : undefined) ??
        {})
      : unclassifiedRemoteCandidateContext(
          parsed.address,
          this.#peerSession.route,
        );
    if (local && context.allowed === false) return false;
    return workerLinkPeerCandidateAllowed(
      candidate,
      this.#peerSession.route,
      context,
    );
  }

  #maybeConnected(): void {
    if (
      this.#closed ||
      this.#connectedReported ||
      !this.#authenticated ||
      this.#control?.readyState !== "open" ||
      LANES.some((lane) => this.#lanes.get(lane)?.readyState !== "open")
    ) {
      return;
    }
    this.#connectedReported = true;
    this.#transportInput.emitSignal({
      type: "transport-state",
      state: "connected",
      message: null,
    });
  }

  #consumeRate(
    lane: WorkerLinkQosLane,
    bytes: number,
    maximum: number,
  ): boolean {
    const now = performance.now();
    const current = this.#rate.get(lane);
    const state =
      !current || now - current.windowStartedAt >= 1_000
        ? { bytes: 0, windowStartedAt: now }
        : current;
    if (state.bytes + bytes > maximum) return false;
    state.bytes += bytes;
    this.#rate.set(lane, state);
    return true;
  }

  #rejectChannel(channel: RTCDataChannel): void {
    this.#transportInput.reportInvalidHandshake();
    channel.close();
  }
}

function interfaceBindings(
  configuration: WorkerLinkPeerConfiguration,
): ReadonlyMap<string, InterfaceBinding> {
  const bindings = new Map<string, InterfaceBinding>();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses) continue;
    const vpn = workerLinkPeerInterfaceIsVpn(name);
    const vpnLanAllowed = configuration.vpnPolicy.lanAllowlist.some(
      (rule) => rule.toLowerCase() === name.toLowerCase(),
    );
    const allowed = workerLinkPeerInterfaceAllowed(name, configuration);
    for (const address of addresses) {
      bindings.set(normalizeAddress(address.address), {
        allowed,
        name,
        vpn,
        vpnLanAllowed,
      });
    }
  }
  return bindings;
}

function candidateFromPair(candidate: {
  component: number;
  foundation: string;
  host: string;
  port: number;
  priority: number;
  relatedAddress?: string;
  relatedPort?: number;
  transport: string;
  type: string;
}): WorkerLinkPeerCandidate {
  return workerLinkPeerCandidateSchema.parse({
    candidate: `candidate:${candidate.foundation} ${candidate.component} ${candidate.transport} ${candidate.priority} ${candidate.host} ${candidate.port} typ ${candidate.type}${candidate.relatedAddress ? ` raddr ${candidate.relatedAddress} rport ${candidate.relatedPort ?? 0}` : ""}`,
    sdpMid: null,
    sdpMLineIndex: null,
    usernameFragment: null,
  });
}

function handshakeMatches(
  handshake: WorkerLinkPeerHandshake,
  peer: WorkerLinkPeerSession,
): boolean {
  return (
    handshake.peerSessionId === peer.peerSessionId &&
    handshake.sessionId === peer.sessionId &&
    handshake.routeGeneration === peer.routeGeneration &&
    handshake.route === peer.route &&
    JSON.stringify(handshake.identity) === JSON.stringify(peer.identity)
  );
}

function normalizeAddress(address: string): string {
  return address.toLowerCase().split("%", 1)[0]!;
}

function unclassifiedRemoteCandidateContext(
  address: string,
  route: WorkerLinkPeerSession["route"],
): WorkerLinkPeerCandidateRouteContext {
  const kind = classifyWorkerLinkPeerAddress(address);
  // A browser does not disclose the source interface name. Keep private and
  // mDNS host candidates eligible as possible VPN endpoints only in the WAN
  // round; the worker's own side of every ICE pair remains interface-classified.
  return route === "wan" && ["private", "mdns"].includes(kind)
    ? { vpn: true }
    : {};
}
