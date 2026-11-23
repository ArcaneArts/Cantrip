import {
  WORKER_LINK_MAX_PEER_SIGNALS,
  WORKER_LINK_MAX_PEER_SIGNALING_BYTES,
  workerLinkPeerCandidateAdvertisementSchema,
  workerLinkPeerCoordinatorCommandSchema,
  workerLinkPeerSignalEnvelopeSchema,
  type WorkerLinkPeerCandidate,
  type WorkerLinkPeerConfiguration,
  type WorkerLinkPeerCoordinatorCommand,
  type WorkerLinkPeerSession,
  type WorkerLinkPeerSignal,
  type WorkerLinkPeerSignalEnvelope,
} from "@cantrip/protocol/worker-link";
import type { WorkerNotification } from "@cantrip/protocol";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const HANDSHAKE_WINDOW_MS = 60_000;

export interface WorkerLinkPeerTransport {
  close(reason: string): Promise<void> | void;
  handleSignal(signal: WorkerLinkPeerSignal): Promise<void> | void;
}

export interface WorkerLinkPeerTransportFactory {
  open(input: {
    advertiseCandidates(
      candidates: WorkerLinkPeerCandidate[],
      complete: boolean,
    ): boolean;
    configuration: WorkerLinkPeerConfiguration;
    emitSignal(signal: WorkerLinkPeerSignal): boolean;
    peerSession: WorkerLinkPeerSession;
    reportInvalidHandshake(): boolean;
  }): Promise<WorkerLinkPeerTransport> | WorkerLinkPeerTransport;
}

export interface WorkerLinkPeerGatewayOptions {
  authorize(peerSession: WorkerLinkPeerSession): boolean;
  emit(notification: WorkerNotification): boolean;
  now?: () => number;
  sweepIntervalMs?: number;
}

interface PeerState {
  advertisementSequence: number;
  configuration: WorkerLinkPeerConfiguration;
  invalidHandshakeTimestamps: number[];
  lastClientSignalSequence: number;
  nextWorkerSignalSequence: number;
  opening: Promise<void> | null;
  peerSession: WorkerLinkPeerSession;
  pendingSignals: WorkerLinkPeerSignal[];
  pendingSignalBytes: number;
  transport: WorkerLinkPeerTransport | null;
}

export interface WorkerLinkPeerGatewayStats {
  invalidHandshakes: number;
  peerSessions: number;
  pendingSignals: number;
}

export class WorkerLinkPeerGateway {
  #closed = false;
  #factory: WorkerLinkPeerTransportFactory | null = null;
  readonly #now: () => number;
  readonly #peers = new Map<string, PeerState>();
  readonly #sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(private readonly options: WorkerLinkPeerGatewayOptions) {
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs =
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#sweepTimer =
      sweepIntervalMs > 0
        ? setInterval(() => void this.sweepExpired(), sweepIntervalMs)
        : null;
    this.#sweepTimer?.unref();
  }

  registerTransportFactory(
    factory: WorkerLinkPeerTransportFactory,
  ): () => void {
    this.#assertOpen();
    if (this.#factory) {
      throw new Error("A WorkerLink peer transport factory is already active.");
    }
    this.#factory = factory;
    for (const state of this.#peers.values()) {
      void this.#ensureTransport(state).catch(() =>
        this.#retire(state, "transport-open-failed"),
      );
    }
    return () => {
      if (this.#factory !== factory) return;
      this.#factory = null;
      for (const state of this.#peers.values()) {
        const transport = state.transport;
        state.transport = null;
        void Promise.resolve(transport?.close("transport-unavailable")).catch(
          () => undefined,
        );
      }
    };
  }

  async handleCoordinatorCommand(
    input: WorkerLinkPeerCoordinatorCommand,
  ): Promise<{ accepted: true }> {
    this.#assertOpen();
    const command = workerLinkPeerCoordinatorCommandSchema.parse(input);
    switch (command.type) {
      case "worker-link.peer.install":
        await this.#install(command.peerSession, command.configuration);
        return { accepted: true };
      case "worker-link.peer.signal":
        await this.#acceptClientSignal(command.envelope);
        return { accepted: true };
      case "worker-link.peer.renew":
        this.#renew(command.peerSessionId, command.sessionId, command.lease);
        return { accepted: true };
      case "worker-link.peer.revoke":
        await this.#remove(
          command.peerSessionId,
          command.sessionId,
          command.revocation.reason,
        );
        return { accepted: true };
    }
  }

  async revokeSession(
    sessionId: string,
    reason = "session-revoked",
  ): Promise<number> {
    const matches = [...this.#peers.values()].filter(
      (state) => state.peerSession.sessionId === sessionId,
    );
    await Promise.all(matches.map((state) => this.#retire(state, reason)));
    return matches.length;
  }

  async replaceRouteGeneration(
    sessionId: string,
    routeGeneration: number,
  ): Promise<number> {
    const stale = [...this.#peers.values()].filter(
      (state) =>
        state.peerSession.sessionId === sessionId &&
        state.peerSession.routeGeneration !== routeGeneration,
    );
    await Promise.all(
      stale.map((state) => this.#retire(state, "route-replaced")),
    );
    return stale.length;
  }

  async sweepExpired(): Promise<number> {
    const now = this.#now();
    const expired = [...this.#peers.values()].filter(
      (state) =>
        Date.parse(state.peerSession.lease.expiresAt) <= now ||
        !this.options.authorize(state.peerSession),
    );
    await Promise.all(
      expired.map((state) => this.#retire(state, "lease-expired")),
    );
    return expired.length;
  }

  stats(): WorkerLinkPeerGatewayStats {
    let invalidHandshakes = 0;
    let pendingSignals = 0;
    const cutoff = this.#now() - HANDSHAKE_WINDOW_MS;
    for (const state of this.#peers.values()) {
      invalidHandshakes += state.invalidHandshakeTimestamps.filter(
        (timestamp) => timestamp > cutoff,
      ).length;
      pendingSignals += state.pendingSignals.length;
    }
    return {
      invalidHandshakes,
      peerSessions: this.#peers.size,
      pendingSignals,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    const states = [...this.#peers.values()];
    this.#peers.clear();
    await Promise.all(
      states.map((state) =>
        Promise.resolve(state.transport?.close("worker-shutdown")).catch(
          () => undefined,
        ),
      ),
    );
    this.#factory = null;
  }

  async #install(
    peerSession: WorkerLinkPeerSession,
    configuration: WorkerLinkPeerConfiguration,
  ): Promise<void> {
    if (
      configuration.relayOnly ||
      !configuration.directRoutes[peerSession.route]
    ) {
      throw new Error("The WorkerLink peer route is disabled by policy.");
    }
    if (
      Date.parse(peerSession.lease.expiresAt) <= this.#now() ||
      !this.options.authorize(peerSession)
    ) {
      throw new Error("The WorkerLink peer session is not authorized.");
    }
    const existing = this.#peers.get(peerSession.peerSessionId);
    if (existing) {
      if (
        canonical(existing.peerSession) !== canonical(peerSession) ||
        canonical(existing.configuration) !== canonical(configuration)
      ) {
        throw new Error(
          "WorkerLink peer installation conflicts with existing state.",
        );
      }
      return;
    }
    const peers = [...this.#peers.values()];
    if (peers.length >= configuration.maxPeerSessionsPerWorker) {
      throw new Error("The WorkerLink worker peer-session limit was reached.");
    }
    if (
      peers.filter(
        (state) =>
          state.peerSession.identity.clientInstanceId ===
          peerSession.identity.clientInstanceId,
      ).length >= configuration.maxPeerSessionsPerClient
    ) {
      throw new Error("The WorkerLink client peer-session limit was reached.");
    }
    if (
      peers.some(
        (state) =>
          state.peerSession.sessionId === peerSession.sessionId &&
          state.peerSession.routeGeneration === peerSession.routeGeneration &&
          state.peerSession.route === peerSession.route,
      )
    ) {
      throw new Error("The WorkerLink peer round is already installed.");
    }
    const state: PeerState = {
      advertisementSequence: 0,
      configuration,
      invalidHandshakeTimestamps: [],
      lastClientSignalSequence: -1,
      nextWorkerSignalSequence: 0,
      opening: null,
      peerSession,
      pendingSignals: [],
      pendingSignalBytes: 0,
      transport: null,
    };
    this.#peers.set(peerSession.peerSessionId, state);
    try {
      await this.#ensureTransport(state);
    } catch (error) {
      if (this.#peers.get(peerSession.peerSessionId) === state) {
        this.#peers.delete(peerSession.peerSessionId);
      }
      throw error;
    }
  }

  async #acceptClientSignal(
    input: WorkerLinkPeerSignalEnvelope,
  ): Promise<void> {
    const envelope = workerLinkPeerSignalEnvelopeSchema.parse(input);
    if (envelope.sender !== "client") {
      throw new Error("WorkerLink peer commands must be client-authored.");
    }
    const state = this.#peers.get(envelope.peerSessionId);
    if (
      !state ||
      envelope.sessionId !== state.peerSession.sessionId ||
      envelope.routeGeneration !== state.peerSession.routeGeneration ||
      envelope.route !== state.peerSession.route ||
      !this.options.authorize(state.peerSession)
    ) {
      throw new Error("WorkerLink peer signal authority is stale.");
    }
    if (envelope.signalSequence !== state.lastClientSignalSequence + 1) {
      throw new Error("WorkerLink peer signal sequence is invalid.");
    }
    if (envelope.signalSequence >= WORKER_LINK_MAX_PEER_SIGNALS) {
      await this.#retire(state, "peer-signal-limit");
      throw new Error("WorkerLink peer signal limit was reached.");
    }
    if (!state.transport) {
      const signalBytes = new TextEncoder().encode(
        JSON.stringify(envelope.signal),
      ).byteLength;
      if (
        state.pendingSignals.length >= WORKER_LINK_MAX_PEER_SIGNALS ||
        state.pendingSignalBytes + signalBytes >
          WORKER_LINK_MAX_PEER_SIGNALING_BYTES
      ) {
        throw new Error("WorkerLink pending peer-signal capacity was reached.");
      }
      state.pendingSignals.push(envelope.signal);
      state.pendingSignalBytes += signalBytes;
      state.lastClientSignalSequence = envelope.signalSequence;
      return;
    }
    await state.transport.handleSignal(envelope.signal);
    state.lastClientSignalSequence = envelope.signalSequence;
  }

  #renew(
    peerSessionId: string,
    sessionId: string,
    lease: WorkerLinkPeerSession["lease"],
  ): void {
    const state = this.#peers.get(peerSessionId);
    if (!state || state.peerSession.sessionId !== sessionId) {
      throw new Error("WorkerLink peer session is not installed.");
    }
    if (
      lease.issuedAt !== state.peerSession.lease.issuedAt ||
      lease.absoluteExpiresAt !== state.peerSession.lease.absoluteExpiresAt ||
      Date.parse(lease.expiresAt) <= this.#now() ||
      Date.parse(lease.expiresAt) > Date.parse(lease.absoluteExpiresAt)
    ) {
      throw new Error("WorkerLink peer lease renewal is invalid.");
    }
    const renewed = { ...state.peerSession, lease };
    if (!this.options.authorize(renewed)) {
      throw new Error("WorkerLink peer lease renewal is not authorized.");
    }
    state.peerSession = renewed;
  }

  async #ensureTransport(state: PeerState): Promise<void> {
    if (
      state.transport ||
      state.opening ||
      this.#peers.get(state.peerSession.peerSessionId) !== state ||
      !this.#factory
    ) {
      return state.opening ?? Promise.resolve();
    }
    const factory = this.#factory;
    const opening = Promise.resolve(
      factory.open({
        advertiseCandidates: (candidates, complete) =>
          this.#advertiseCandidates(state, candidates, complete),
        configuration: state.configuration,
        emitSignal: (signal) => this.#emitSignal(state, signal),
        peerSession: state.peerSession,
        reportInvalidHandshake: () => this.#reportInvalidHandshake(state),
      }),
    ).then(async (transport) => {
      if (
        this.#closed ||
        this.#peers.get(state.peerSession.peerSessionId) !== state ||
        this.#factory !== factory
      ) {
        await transport.close("peer-session-replaced");
        return;
      }
      state.transport = transport;
      const pending = state.pendingSignals.splice(0);
      state.pendingSignalBytes = 0;
      for (const signal of pending) await transport.handleSignal(signal);
    });
    state.opening = opening;
    try {
      await opening;
    } finally {
      if (state.opening === opening) state.opening = null;
    }
  }

  #emitSignal(state: PeerState, signal: WorkerLinkPeerSignal): boolean {
    if (this.#peers.get(state.peerSession.peerSessionId) !== state)
      return false;
    const envelope = workerLinkPeerSignalEnvelopeSchema.parse({
      peerSessionId: state.peerSession.peerSessionId,
      sessionId: state.peerSession.sessionId,
      routeGeneration: state.peerSession.routeGeneration,
      route: state.peerSession.route,
      sender: "worker",
      signalSequence: state.nextWorkerSignalSequence,
      signal,
    });
    const emitted = this.options.emit({
      type: "worker-link.peer.signal",
      envelope,
    });
    if (emitted) state.nextWorkerSignalSequence += 1;
    return emitted;
  }

  #advertiseCandidates(
    state: PeerState,
    candidates: WorkerLinkPeerCandidate[],
    complete: boolean,
  ): boolean {
    if (this.#peers.get(state.peerSession.peerSessionId) !== state)
      return false;
    const advertisement = workerLinkPeerCandidateAdvertisementSchema.parse({
      peerSessionId: state.peerSession.peerSessionId,
      sessionId: state.peerSession.sessionId,
      routeGeneration: state.peerSession.routeGeneration,
      route: state.peerSession.route,
      advertisementSequence: state.advertisementSequence,
      candidates,
      complete,
    });
    const emitted = this.options.emit({
      type: "worker-link.peer.candidates",
      advertisement,
    });
    if (emitted) state.advertisementSequence += 1;
    return emitted;
  }

  #reportInvalidHandshake(state: PeerState): boolean {
    if (this.#peers.get(state.peerSession.peerSessionId) !== state)
      return false;
    const now = this.#now();
    state.invalidHandshakeTimestamps = state.invalidHandshakeTimestamps.filter(
      (timestamp) => timestamp > now - HANDSHAKE_WINDOW_MS,
    );
    state.invalidHandshakeTimestamps.push(now);
    if (
      state.invalidHandshakeTimestamps.length <=
      state.configuration.invalidHandshakeRatePerMinute
    ) {
      return true;
    }
    void this.#retire(state, "invalid-handshake-rate-limit");
    return false;
  }

  async #remove(
    peerSessionId: string,
    sessionId: string,
    reason: string,
  ): Promise<boolean> {
    const state = this.#peers.get(peerSessionId);
    if (!state || state.peerSession.sessionId !== sessionId) return false;
    await this.#retire(state, reason);
    return true;
  }

  async #retire(state: PeerState, reason: string): Promise<void> {
    if (this.#peers.get(state.peerSession.peerSessionId) !== state) return;
    this.#peers.delete(state.peerSession.peerSessionId);
    state.pendingSignals = [];
    state.pendingSignalBytes = 0;
    const transport = state.transport;
    state.transport = null;
    await Promise.resolve(transport?.close(reason)).catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WorkerLink peer gateway is closed.");
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}
