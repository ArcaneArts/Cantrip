import {
  WORKER_LINK_PEER_CONTROL_CHANNEL,
  classifyWorkerLinkPeerAddress,
  decodeWorkerLinkFrame,
  filterWorkerLinkPeerSdp,
  parseWorkerLinkPeerCandidate,
  workerLinkPeerCandidateAllowed,
  workerLinkPeerCandidateSchema,
  workerLinkPeerHandshakeSchema,
  workerLinkPeerLaneChannelLabel,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkQosLaneSchema,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerCandidate,
  type WorkerLinkPeerHandshake,
  type WorkerLinkPeerMailbox,
  type WorkerLinkPeerMailboxReadRequest,
  type WorkerLinkPeerRoute,
  type WorkerLinkPeerSessionDescriptor,
  type WorkerLinkPeerSignal,
  type WorkerLinkPeerSignalEnvelope,
  type WorkerLinkQosLane,
  type WorkerLinkSession,
  type ValidatedWorkerLinkFrame,
} from "@cantrip/protocol/worker-link";

import type {
  WorkerLinkCarrier,
  WorkerLinkCarrierCloseListener,
  WorkerLinkCarrierFrameListener,
} from "./worker-link-carriers";
import { workerLinkFrameBufferSource } from "./worker-link-carriers";

const MAILBOX_POLL_MS = 40;
const LANES = workerLinkQosLaneSchema.options;

export interface WorkerLinkPeerCarrierOptions {
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createPeerSession(
    sessionId: string,
    routeGeneration: number,
    route: WorkerLinkPeerRoute,
  ): Promise<WorkerLinkPeerSessionDescriptor>;
  deletePeerSession(sessionId: string, peerSessionId: string): Promise<void>;
  readMailbox(
    sessionId: string,
    peerSessionId: string,
    input: WorkerLinkPeerMailboxReadRequest,
  ): Promise<WorkerLinkPeerMailbox>;
  route: WorkerLinkPeerRoute;
  sendSignals(
    sessionId: string,
    peerSessionId: string,
    signals: WorkerLinkPeerSignalEnvelope[],
  ): Promise<void>;
  session: WorkerLinkSession;
}

interface LaneRateState {
  bytes: number;
  windowStartedAt: number;
}

export async function openWorkerLinkPeerCarrier(
  options: WorkerLinkPeerCarrierOptions,
): Promise<WorkerLinkCarrier> {
  const descriptor = workerLinkPeerSessionDescriptorSchema.parse(
    await options.createPeerSession(
      options.session.sessionId,
      options.session.routeGeneration,
      options.route,
    ),
  );
  validateDescriptor(options.session, options.route, descriptor);
  const carrier = new WebRtcWorkerLinkCarrier(options, descriptor);
  try {
    await carrier.start();
    return carrier;
  } catch (error) {
    carrier.close("peer-negotiation-failed");
    throw error;
  }
}

class WebRtcWorkerLinkCarrier implements WorkerLinkCarrier {
  readonly #challenge = randomChallenge();
  readonly #closeListeners = new Set<WorkerLinkCarrierCloseListener>();
  #closed = false;
  readonly #configuration: WorkerLinkPeerSessionDescriptor["configuration"];
  readonly #control: RTCDataChannel;
  readonly #descriptor: WorkerLinkPeerSessionDescriptor;
  readonly #frameListeners = new Set<WorkerLinkCarrierFrameListener>();
  #handshakeAccepted = false;
  readonly #lanes = new Map<WorkerLinkQosLane, RTCDataChannel>();
  #latencyMs: number | null = null;
  #lastAdvertisementSequence: number | null = null;
  #lastSignalSequence: number | null = null;
  readonly #options: WorkerLinkPeerCarrierOptions;
  readonly #peer: RTCPeerConnection;
  #offerSent = false;
  #pendingIceSignals: WorkerLinkPeerSignal[] = [];
  #answerAccepted = false;
  readonly #rate = new Map<WorkerLinkQosLane, LaneRateState>();
  #readyReject!: (error: Error) => void;
  #readyResolve!: () => void;
  readonly #ready: Promise<void>;
  readonly #route: WorkerLinkPeerRoute;
  #signalSequence = 0;
  #signalTail: Promise<void> = Promise.resolve();
  #startedAt = performance.now();

  constructor(
    options: WorkerLinkPeerCarrierOptions,
    descriptor: WorkerLinkPeerSessionDescriptor,
  ) {
    this.#options = options;
    this.#descriptor = descriptor;
    this.#configuration = descriptor.configuration;
    this.#route = options.route;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const createPeerConnection =
      options.createPeerConnection ??
      ((configuration: RTCConfiguration) =>
        new RTCPeerConnection(configuration));
    this.#peer = createPeerConnection({
      iceServers:
        this.#route === "wan" && this.#configuration.stunUrls.length > 0
          ? [{ urls: this.#configuration.stunUrls }]
          : [],
      iceTransportPolicy: "all",
    });
    this.#control = this.#peer.createDataChannel(
      WORKER_LINK_PEER_CONTROL_CHANNEL,
      { ordered: true },
    );
    this.#bindControl();
    for (const lane of LANES) {
      const channel = this.#peer.createDataChannel(
        workerLinkPeerLaneChannelLabel(lane),
        lane === "realtime"
          ? { ordered: false, maxRetransmits: 0 }
          : { ordered: true },
      );
      this.#lanes.set(lane, channel);
      this.#bindLane(lane, channel);
    }
    this.#peer.onicecandidate = (event) => {
      if (this.#closed) return;
      try {
        const signal: WorkerLinkPeerSignal = event.candidate
          ? {
              type: "candidate",
              candidate: workerLinkPeerCandidateSchema.parse({
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              }),
            }
          : { type: "end-of-candidates" };
        if (
          signal.type === "candidate" &&
          !browserCandidateAllowed(signal.candidate, this.#route)
        ) {
          return;
        }
        if (!this.#offerSent) this.#pendingIceSignals.push(signal);
        else {
          void this.#sendSignal(signal).catch((error) =>
            this.#fail(errorMessage(error)),
          );
        }
      } catch (error) {
        this.#fail(errorMessage(error));
      }
    };
    this.#peer.onconnectionstatechange = () => {
      if (
        ["failed", "disconnected", "closed"].includes(
          this.#peer.connectionState,
        )
      ) {
        this.#fail(`WebRTC peer connection ${this.#peer.connectionState}.`);
      }
    };
  }

  get latencyMs(): number | null {
    return this.#closed ? null : this.#latencyMs;
  }

  get route(): WorkerLinkPeerRoute {
    return this.#route;
  }

  async start(): Promise<void> {
    const timeout = setTimeout(
      () => this.#fail("WorkerLink peer negotiation timed out."),
      this.#configuration.negotiationTimeoutMs,
    );
    try {
      const offer = await this.#peer.createOffer();
      await this.#peer.setLocalDescription(offer);
      const localSdp = this.#peer.localDescription?.sdp ?? offer.sdp ?? "";
      const filtered = filterWorkerLinkPeerSdp(
        localSdp,
        this.#route,
        (address) => unclassifiedCandidateContext(address, this.#route),
      );
      await this.#sendSignal({ type: "offer", sdp: filtered.sdp });
      this.#offerSent = true;
      for (const signal of this.#pendingIceSignals.splice(0)) {
        await this.#sendSignal(signal);
      }
      void this.#pollMailbox();
      await this.#ready;
      await this.#validateSelectedRoute();
      this.#latencyMs = Math.max(0, performance.now() - this.#startedAt);
    } finally {
      clearTimeout(timeout);
    }
  }

  send(frame: ValidatedWorkerLinkFrame): boolean {
    const { bytes, header } = frame;
    if (
      this.#closed ||
      !this.#handshakeAccepted ||
      header.sessionId !== this.#descriptor.peerSession.sessionId ||
      header.routeGeneration !== this.#descriptor.peerSession.routeGeneration ||
      header.effectiveRoute !== this.#route
    ) {
      return false;
    }
    const channel = this.#lanes.get(header.lane);
    const limits = this.#configuration.laneLimits[header.lane];
    if (
      !channel ||
      channel.readyState !== "open" ||
      channel.bufferedAmount + bytes.byteLength > limits.maxQueuedBytes ||
      !this.#consumeRate(
        header.lane,
        bytes.byteLength,
        limits.maxBytesPerSecond,
      )
    ) {
      return false;
    }
    try {
      channel.send(workerLinkFrameBufferSource(frame));
      return true;
    } catch {
      this.#fail("WorkerLink peer send failed.");
      return false;
    }
  }

  onClose(listener: WorkerLinkCarrierCloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onFrame(listener: WorkerLinkCarrierFrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  close(reason = "peer-carrier-closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#readyReject(new Error(reason));
    this.#control.close();
    for (const channel of this.#lanes.values()) channel.close();
    this.#peer.close();
    void this.#options
      .deletePeerSession(
        this.#descriptor.peerSession.sessionId,
        this.#descriptor.peerSession.peerSessionId,
      )
      .catch(() => undefined);
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
    this.#frameListeners.clear();
  }

  #bindControl(): void {
    this.#control.onopen = () => {
      if (this.#closed) return;
      this.#control.send(JSON.stringify(this.#handshake("client")));
    };
    this.#control.onmessage = (event) => {
      try {
        if (this.#handshakeAccepted) {
          throw new Error("WorkerLink peer handshake was replayed.");
        }
        const handshake = workerLinkPeerHandshakeSchema.parse(
          JSON.parse(String(event.data)),
        );
        if (
          handshake.role !== "worker" ||
          handshake.challenge !== this.#challenge ||
          !handshakeMatches(handshake, this.#descriptor)
        ) {
          throw new Error("WorkerLink peer identity did not match authority.");
        }
        this.#handshakeAccepted = true;
        this.#maybeReady();
      } catch (error) {
        this.#fail(errorMessage(error));
      }
    };
    this.#control.onclose = () => this.#fail("Peer control channel closed.");
    this.#control.onerror = () => this.#fail("Peer control channel failed.");
  }

  #bindLane(lane: WorkerLinkQosLane, channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.#maybeReady();
    channel.onclose = () => this.#fail(`Peer ${lane} channel closed.`);
    channel.onerror = () => this.#fail(`Peer ${lane} channel failed.`);
    channel.onmessage = (event) => {
      void messageBytes(event.data)
        .then((bytes) => {
          if (!bytes || this.#closed || !this.#handshakeAccepted) return;
          try {
            const frame = decodeWorkerLinkFrame(bytes);
            const peer = this.#descriptor.peerSession;
            if (
              frame.header.sessionId !== peer.sessionId ||
              frame.header.routeGeneration !== peer.routeGeneration ||
              frame.header.effectiveRoute !== peer.route ||
              frame.header.lane !== lane
            ) {
              throw new Error("WorkerLink peer frame authority is stale.");
            }
            for (const listener of this.#frameListeners) listener(bytes);
          } catch (error) {
            this.#fail(errorMessage(error));
          }
        })
        .catch((error) => this.#fail(errorMessage(error)));
    };
  }

  async #pollMailbox(): Promise<void> {
    while (!this.#closed && !this.#handshakeAccepted) {
      try {
        const mailbox = await this.#options.readMailbox(
          this.#descriptor.peerSession.sessionId,
          this.#descriptor.peerSession.peerSessionId,
          {
            afterSignalSequence: this.#lastSignalSequence,
            afterAdvertisementSequence: this.#lastAdvertisementSequence,
          },
        );
        await this.#handleMailbox(mailbox);
      } catch (error) {
        this.#fail(errorMessage(error));
        return;
      }
      if (!this.#handshakeAccepted) await delay(MAILBOX_POLL_MS);
    }
  }

  async #handleMailbox(mailbox: WorkerLinkPeerMailbox): Promise<void> {
    const peer = this.#descriptor.peerSession;
    if (
      mailbox.peerSessionId !== peer.peerSessionId ||
      mailbox.sessionId !== peer.sessionId ||
      mailbox.routeGeneration !== peer.routeGeneration ||
      mailbox.route !== peer.route
    ) {
      throw new Error("WorkerLink peer mailbox authority is stale.");
    }
    for (const envelope of mailbox.signals) {
      if (envelope.sender !== "worker") {
        throw new Error("WorkerLink peer mailbox sender is invalid.");
      }
      await this.#handleWorkerSignal(envelope.signal);
      this.#lastSignalSequence = envelope.signalSequence;
    }
    for (const advertisement of mailbox.candidateAdvertisements) {
      for (const candidate of advertisement.candidates) {
        if (!browserCandidateAllowed(candidate, this.#route)) {
          throw new Error("WorkerLink peer candidate violated route policy.");
        }
        await this.#peer.addIceCandidate(candidate);
      }
      if (advertisement.complete) await this.#peer.addIceCandidate(null);
      this.#lastAdvertisementSequence = advertisement.advertisementSequence;
    }
  }

  async #handleWorkerSignal(signal: WorkerLinkPeerSignal): Promise<void> {
    if (signal.type === "answer") {
      if (this.#answerAccepted) {
        throw new Error("WorkerLink peer answer was replayed.");
      }
      const filtered = filterWorkerLinkPeerSdp(
        signal.sdp,
        this.#route,
        (address) => unclassifiedCandidateContext(address, this.#route),
      );
      if (filtered.removedCandidates > 0) {
        throw new Error("WorkerLink peer answer violated route policy.");
      }
      await this.#peer.setRemoteDescription({
        type: "answer",
        sdp: signal.sdp,
      });
      this.#answerAccepted = true;
    } else if (signal.type === "candidate") {
      if (!this.#answerAccepted) {
        throw new Error("WorkerLink peer candidate preceded its answer.");
      }
      if (!browserCandidateAllowed(signal.candidate, this.#route)) {
        throw new Error("WorkerLink peer candidate violated route policy.");
      }
      await this.#peer.addIceCandidate(signal.candidate);
    } else if (signal.type === "end-of-candidates") {
      if (!this.#answerAccepted) {
        throw new Error(
          "WorkerLink peer candidate completion preceded its answer.",
        );
      }
      await this.#peer.addIceCandidate(null);
    } else if (signal.type === "offer") {
      throw new Error("WorkerLink worker cannot send an offer.");
    } else if (
      signal.type === "transport-state" &&
      signal.state !== "connected"
    ) {
      throw new Error(
        signal.message ?? `Worker peer transport ${signal.state}.`,
      );
    }
  }

  #sendSignal(signal: WorkerLinkPeerSignal): Promise<void> {
    const sequence = this.#signalSequence;
    this.#signalSequence += 1;
    const peer = this.#descriptor.peerSession;
    const operation = this.#signalTail.then(() =>
      this.#options.sendSignals(peer.sessionId, peer.peerSessionId, [
        {
          peerSessionId: peer.peerSessionId,
          sessionId: peer.sessionId,
          routeGeneration: peer.routeGeneration,
          route: peer.route,
          sender: "client",
          signalSequence: sequence,
          signal,
        },
      ]),
    );
    this.#signalTail = operation.catch(() => undefined);
    return operation;
  }

  #handshake(role: "client" | "worker"): WorkerLinkPeerHandshake {
    const peer = this.#descriptor.peerSession;
    return workerLinkPeerHandshakeSchema.parse({
      type: "worker-link-peer-handshake",
      protocolVersion: 1,
      role,
      peerSessionId: peer.peerSessionId,
      sessionId: peer.sessionId,
      routeGeneration: peer.routeGeneration,
      route: peer.route,
      identity: peer.identity,
      challenge: this.#challenge,
    });
  }

  #maybeReady(): void {
    if (
      this.#closed ||
      !this.#handshakeAccepted ||
      this.#control.readyState !== "open" ||
      [...this.#lanes.values()].some((channel) => channel.readyState !== "open")
    ) {
      return;
    }
    this.#readyResolve();
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

  async #validateSelectedRoute(): Promise<void> {
    try {
      const report = await this.#peer.getStats();
      const entries = new Map<string, RTCStats & Record<string, unknown>>();
      report.forEach((value) =>
        entries.set(value.id, value as RTCStats & Record<string, unknown>),
      );
      const transport = [...entries.values()].find(
        (entry) => entry.type === "transport",
      );
      const selectedId = transport?.selectedCandidatePairId;
      const pair =
        (typeof selectedId === "string" ? entries.get(selectedId) : null) ??
        [...entries.values()].find(
          (entry) =>
            entry.type === "candidate-pair" &&
            entry.state === "succeeded" &&
            (entry.nominated === true || entry.selected === true),
        );
      if (!pair) return;
      for (const id of [pair.localCandidateId, pair.remoteCandidateId]) {
        const candidate = typeof id === "string" ? entries.get(id) : null;
        if (!candidate) continue;
        const address = candidate.address ?? candidate.ip;
        const type = candidate.candidateType;
        if (typeof address !== "string" || typeof type !== "string") continue;
        const synthetic = workerLinkPeerCandidateSchema.parse({
          candidate: `candidate:stats 1 udp 1 ${address} 1 typ ${type}`,
          sdpMid: null,
          sdpMLineIndex: null,
          usernameFragment: null,
        });
        if (!browserCandidateAllowed(synthetic, this.#route)) {
          throw new Error("Selected ICE route violated WorkerLink policy.");
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /violated WorkerLink policy/u.test(error.message)
      ) {
        throw error;
      }
      // Some browser/WebView implementations omit candidate-pair stats. The
      // DTLS-bound authority handshake and worker-side pair filter still fence it.
    }
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.close(reason);
  }
}

function validateDescriptor(
  session: WorkerLinkSession,
  route: WorkerLinkPeerRoute,
  descriptor: WorkerLinkPeerSessionDescriptor,
): void {
  const peer = descriptor.peerSession;
  if (
    peer.sessionId !== session.sessionId ||
    peer.routeGeneration !== session.routeGeneration ||
    peer.route !== route ||
    JSON.stringify(peer.identity) !== JSON.stringify(session.identity) ||
    Date.parse(peer.lease.expiresAt) <= Date.now() ||
    descriptor.configuration.relayOnly ||
    !descriptor.configuration.directRoutes[route]
  ) {
    throw new Error("WorkerLink peer descriptor did not match authority.");
  }
}

function handshakeMatches(
  handshake: WorkerLinkPeerHandshake,
  descriptor: WorkerLinkPeerSessionDescriptor,
): boolean {
  const peer = descriptor.peerSession;
  return (
    handshake.peerSessionId === peer.peerSessionId &&
    handshake.sessionId === peer.sessionId &&
    handshake.routeGeneration === peer.routeGeneration &&
    handshake.route === peer.route &&
    JSON.stringify(handshake.identity) === JSON.stringify(peer.identity)
  );
}

async function messageBytes(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

function randomChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function browserCandidateAllowed(
  candidate: WorkerLinkPeerCandidate,
  route: WorkerLinkPeerRoute,
): boolean {
  const parsed = parseWorkerLinkPeerCandidate(candidate.candidate);
  return (
    parsed !== null &&
    workerLinkPeerCandidateAllowed(
      candidate,
      route,
      unclassifiedCandidateContext(parsed.address, route),
    )
  );
}

function unclassifiedCandidateContext(
  address: string,
  route: WorkerLinkPeerRoute,
): { vpn?: boolean } {
  const kind = classifyWorkerLinkPeerAddress(address);
  // Browser ICE APIs intentionally omit interface names. Private and mDNS
  // host candidates therefore remain possible VPN candidates in the WAN
  // round; the worker still enforces its named local-interface policy and the
  // selected DTLS peer remains bound to server-issued authority.
  return route === "wan" && ["private", "mdns"].includes(kind)
    ? { vpn: true }
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
