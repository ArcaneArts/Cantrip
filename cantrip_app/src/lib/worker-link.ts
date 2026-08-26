import { isTauri } from "@tauri-apps/api/core";
import {
  WORKER_LINK_MAX_CREDIT_BYTES,
  WORKER_LINK_MAX_HEADER_BYTES,
  WORKER_LINK_MAX_PAYLOAD_BYTES,
  WORKER_LINK_MAX_TELEMETRY_SAMPLES,
  decodeWorkerLinkFrame,
  workerLinkFrameHeaderSchema,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkChannelErrorCode,
  type WorkerLinkChannelRejectCode,
  type WorkerLinkFrameHeader,
  type WorkerLinkPayloadFormat,
  type WorkerLinkQosLane,
  type WorkerLinkResourceGrant,
  type WorkerLinkRoute,
  type WorkerLinkRouteStatus,
  type WorkerLinkSession,
  type WorkerLinkTelemetrySample,
} from "@cantrip/protocol";

import {
  createWorkerLinkDirectTicket,
  createWorkerLinkPeerSession,
  createWorkerLinkSession,
  deleteDirectAttachment,
  deleteWorkerLinkPeerSession,
  deleteWorkerLinkSession,
  readWorkerLinkPeerMailbox,
  recordDirectAttachmentTelemetry,
  recordWorkerLinkTelemetry,
  renewWorkerLinkSession,
  sendWorkerLinkPeerSignals,
  updateWorkerLinkRoute,
} from "@/lib/api";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import {
  openWorkerLinkLocalCarrier,
  openWorkerLinkRelayCarrier,
  type WorkerLinkCarrier,
} from "@/lib/worker-link-carriers";
import { openWorkerLinkPeerCarrier } from "@/lib/worker-link-peer-carrier";

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const OPEN_TIMEOUT_MS = 10_000;
const RENEW_AHEAD_MS = 30_000;
const MIN_RENEW_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAYS_MS = [0, 250, 1_000, 3_000] as const;
const SCHEDULER_MAX_FRAMES_PER_LANE = 128;
const SCHEDULER_MAX_BYTES_PER_LANE = 4 * 1_024 * 1_024;
const SCHEDULER_BURST_FRAMES = 16;
const SCHEDULER_RETRY_MS = 5;
const TELEMETRY_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_LAST_USED_STATUS_TTL_MS = 30_000;
const ROUTES: readonly WorkerLinkRoute[] = ["local", "lan", "wan", "relay"];
const SCHEDULER_LANES: readonly WorkerLinkQosLane[] = [
  "interactive",
  "interactive",
  "interactive",
  "interactive",
  "interactive",
  "interactive",
  "interactive",
  "interactive",
  "events",
  "events",
  "events",
  "events",
  "realtime",
  "realtime",
  "realtime",
  "realtime",
  "stream",
  "stream",
  "bulk",
];

export type WorkerLinkDataListener = (payload: Uint8Array) => void;
export type WorkerLinkStreamCloseListener = (
  code: WorkerLinkChannelCloseCode,
) => void;
export type WorkerLinkStreamHalfCloseListener = () => void;
export type WorkerLinkStreamErrorListener = (
  code: WorkerLinkChannelErrorCode | WorkerLinkChannelRejectCode,
) => void;
export type WorkerLinkStreamWritableListener = () => void;

export interface WorkerLinkStream {
  readonly channelId: string;
  readonly connectionId: string;
  readonly lane: WorkerLinkQosLane;
  readonly route: WorkerLinkRoute;
  acknowledge(bytes: number): boolean;
  close(code?: WorkerLinkChannelCloseCode): void;
  halfClose(): boolean;
  onClose(listener: WorkerLinkStreamCloseListener): () => void;
  onData(listener: WorkerLinkDataListener): () => void;
  onError(listener: WorkerLinkStreamErrorListener): () => void;
  onHalfClose(listener: WorkerLinkStreamHalfCloseListener): () => void;
  onWritable(listener: WorkerLinkStreamWritableListener): () => void;
  write(payload: Uint8Array, format?: WorkerLinkPayloadFormat): boolean;
}

export interface WorkerLink {
  readonly preferredRoute: WorkerLinkRoute;
  readonly session: WorkerLinkSession;
  readonly workerId: string;
  onRouteChanged(listener: (status: WorkerLinkRouteStatus) => void): () => void;
  openStream(
    grant: WorkerLinkResourceGrant,
    lane: WorkerLinkQosLane,
  ): Promise<WorkerLinkStream>;
  reprobe(): Promise<void>;
}

export interface WorkerLinkReference {
  readonly link: WorkerLink;
  release(): void;
}

export type WorkerLinkConnectionState =
  "idle" | "connecting" | "active" | "degraded" | "reconnecting" | "offline";

export type WorkerLinkStatusFreshness = "active" | "last-used";

export interface WorkerLinkRouteChannelCount {
  readonly channelCount: number;
  readonly route: WorkerLinkRoute;
}

export interface WorkerLinkStatusSnapshot {
  readonly activeChannelCount: number;
  readonly activeLinkCount: number;
  readonly changedAt: string;
  readonly consumerCount: number;
  readonly effectiveRoutes: readonly WorkerLinkRoute[];
  readonly fallbackReason: WorkerLinkRouteStatus["fallbackReason"];
  readonly freshness: WorkerLinkStatusFreshness;
  readonly latencyMs: number | null;
  readonly preferredRoute: WorkerLinkRoute | null;
  readonly routeChannelCounts: readonly WorkerLinkRouteChannelCount[];
  readonly routeGeneration: number | null;
  readonly state: WorkerLinkConnectionState;
  readonly workerId: string;
}

export interface WorkerLinkManagerOptions {
  readonly lastUsedStatusTtlMs?: number;
}

export interface WorkerLinkManagerDependencies {
  createId(): string;
  createSession(
    workerId: string,
    clientInstanceId: string,
  ): Promise<WorkerLinkSession>;
  deleteSession(sessionId: string): Promise<void>;
  getIdentity(): ClientSessionIdentitySnapshot | null;
  localSupported(): boolean;
  now(): number;
  openLocal(session: WorkerLinkSession): Promise<WorkerLinkCarrier>;
  openPeer(
    session: WorkerLinkSession,
    route: "lan" | "wan",
  ): Promise<WorkerLinkCarrier>;
  openRelay(
    session: WorkerLinkSession,
    identity: ClientSessionIdentitySnapshot,
    clientInstanceId: string,
  ): Promise<WorkerLinkCarrier>;
  recordTelemetry(
    sessionId: string,
    routeGeneration: number,
    samples: WorkerLinkTelemetrySample[],
  ): Promise<void>;
  renewSession(sessionId: string): Promise<WorkerLinkSession>;
  setRoute(
    sessionId: string,
    route: WorkerLinkRoute,
  ): Promise<WorkerLinkSession>;
  subscribeIdentity(listener: () => void): () => void;
}

interface PendingWorkerLinkTelemetry {
  routeGeneration: number;
  sample: WorkerLinkTelemetrySample;
}

class WorkerLinkTelemetryReporter {
  #closed = false;
  #flush: Promise<void> | null = null;
  readonly #pending: PendingWorkerLinkTelemetry[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly dependencies: Pick<
      WorkerLinkManagerDependencies,
      "now" | "recordTelemetry"
    >,
  ) {}

  record(
    routeGeneration: number,
    sample: Omit<WorkerLinkTelemetrySample, "occurredAt">,
  ): void {
    if (this.#closed) return;
    if (this.#pending.length >= WORKER_LINK_MAX_TELEMETRY_SAMPLES) {
      this.#pending.shift();
    }
    this.#pending.push({
      routeGeneration,
      sample: {
        occurredAt: new Date(this.dependencies.now()).toISOString(),
        ...sample,
      },
    });
    this.#schedule();
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#flush ?? Promise.resolve();
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.flush();
  }

  flush(): Promise<void> {
    if (this.#flush) return this.#flush;
    const operation = (async () => {
      while (this.#pending.length > 0) {
        const routeGeneration = this.#pending[0]!.routeGeneration;
        const samples: WorkerLinkTelemetrySample[] = [];
        while (
          this.#pending[0]?.routeGeneration === routeGeneration &&
          samples.length < WORKER_LINK_MAX_TELEMETRY_SAMPLES
        ) {
          samples.push(this.#pending.shift()!.sample);
        }
        await this.dependencies
          .recordTelemetry(this.sessionId, routeGeneration, samples)
          .catch(() => undefined);
      }
    })().finally(() => {
      if (this.#flush === operation) this.#flush = null;
      if (!this.#closed && this.#pending.length > 0) this.#schedule();
    });
    this.#flush = operation;
    return operation;
  }

  #schedule(): void {
    if (this.#closed || this.#timer || this.#flush) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, TELEMETRY_FLUSH_INTERVAL_MS);
  }
}

interface ManagedEntry {
  identityKey: string;
  link: ClientWorkerLink;
  references: number;
}

interface ClientWorkerLinkStatus {
  activeChannelCount: number;
  changedAt: string;
  effectiveRoutes: readonly WorkerLinkRoute[];
  fallbackReason: WorkerLinkRouteStatus["fallbackReason"];
  latencyMs: number | null;
  preferredRoute: WorkerLinkRoute | null;
  routeChannelCounts: readonly WorkerLinkRouteChannelCount[];
  routeGeneration: number | null;
  state: WorkerLinkConnectionState;
}

interface ManagedStatusEntry {
  identityKey: string;
  snapshot: WorkerLinkStatusSnapshot;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WorkerLinkManager {
  readonly #entries = new Map<string, ManagedEntry>();
  readonly #opening = new Map<string, Promise<ManagedEntry>>();
  readonly #statusEntries = new Map<string, ManagedStatusEntry>();
  readonly #statusListeners = new Set<() => void>();
  #statusSnapshot: readonly WorkerLinkStatusSnapshot[] = [];
  #closed = false;
  readonly #lastUsedStatusTtlMs: number;
  readonly #unsubscribeIdentity: () => void;

  constructor(
    private readonly dependencies: WorkerLinkManagerDependencies,
    options: WorkerLinkManagerOptions = {},
  ) {
    this.#lastUsedStatusTtlMs = Math.max(
      0,
      options.lastUsedStatusTtlMs ?? DEFAULT_LAST_USED_STATUS_TTL_MS,
    );
    this.#unsubscribeIdentity = dependencies.subscribeIdentity(() => {
      void this.#retireAll("revoked");
    });
  }

  getStatusSnapshot(): readonly WorkerLinkStatusSnapshot[] {
    return this.#statusSnapshot;
  }

  subscribeStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async acquire(workerId: string): Promise<WorkerLinkReference> {
    if (this.#closed) throw new Error("WorkerLink manager is closed.");
    const identity = this.dependencies.getIdentity();
    if (!identity)
      throw new Error("WorkerLink requires an authenticated client session.");
    const identityKey = clientIdentityKey(identity);
    const key = `${identityKey}\0${workerId}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      let opening = this.#opening.get(key);
      if (!opening) {
        opening = this.#openEntry(workerId, identity, identityKey, key);
        this.#opening.set(key, opening);
      }
      try {
        entry = await opening;
      } finally {
        if (this.#opening.get(key) === opening) this.#opening.delete(key);
      }
    }
    entry.references += 1;
    this.#setConsumerCount(key, entry.references);
    let released = false;
    return {
      link: entry.link,
      release: () => {
        if (released) return;
        released = true;
        this.#release(key, entry!);
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeIdentity();
    await this.#retireAll("normal");
    this.#statusListeners.clear();
  }

  #release(key: string, entry: ManagedEntry): void {
    if (this.#entries.get(key) !== entry) return;
    entry.references -= 1;
    if (entry.references > 0) {
      this.#setConsumerCount(key, entry.references);
      return;
    }
    this.#entries.delete(key);
    this.#retainLastUsed(key, "idle");
    void entry.link.retire("normal");
  }

  async #retireAll(code: WorkerLinkChannelCloseCode): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#clearStatuses();
    await Promise.all(entries.map((entry) => entry.link.retire(code)));
  }

  async #openEntry(
    workerId: string,
    identity: ClientSessionIdentitySnapshot,
    identityKey: string,
    key: string,
  ): Promise<ManagedEntry> {
    this.#publishOpening(key, identityKey, workerId);
    let link: ClientWorkerLink | null = null;
    try {
      const clientInstanceId = this.dependencies.createId();
      const session = await this.dependencies.createSession(
        workerId,
        clientInstanceId,
      );
      validateSessionAuthority(session, workerId, clientInstanceId, identity);
      link = new ClientWorkerLink(
        session,
        identity,
        clientInstanceId,
        this.dependencies,
        (status) => this.#publishLinkStatus(key, identityKey, workerId, status),
      );
      const entry = { identityKey, link, references: 0 };
      await link.start();
      if (
        this.#closed ||
        clientIdentityKey(this.dependencies.getIdentity() ?? identity) !==
          identityKey ||
        this.dependencies.getIdentity() === null
      ) {
        throw new Error("WorkerLink client identity changed during setup.");
      }
      this.#entries.set(key, entry);
      return entry;
    } catch (error) {
      await link?.retire("endpoint-disconnected");
      const activeIdentity = this.dependencies.getIdentity();
      if (
        !this.#closed &&
        activeIdentity &&
        clientIdentityKey(activeIdentity) === identityKey
      ) {
        this.#retainLastUsed(key, "offline");
      } else {
        this.#removeStatus(key);
      }
      throw error;
    }
  }

  #publishOpening(key: string, identityKey: string, workerId: string): void {
    this.#setStatus(key, {
      identityKey,
      snapshot: {
        activeChannelCount: 0,
        activeLinkCount: 1,
        changedAt: new Date(this.dependencies.now()).toISOString(),
        consumerCount: 0,
        effectiveRoutes: [],
        fallbackReason: null,
        freshness: "active",
        latencyMs: null,
        preferredRoute: null,
        routeChannelCounts: emptyRouteChannelCounts(),
        routeGeneration: null,
        state: "connecting",
        workerId,
      },
      timer: null,
    });
  }

  #publishLinkStatus(
    key: string,
    identityKey: string,
    workerId: string,
    status: ClientWorkerLinkStatus,
  ): void {
    const identity = this.dependencies.getIdentity();
    if (
      this.#closed ||
      !identity ||
      clientIdentityKey(identity) !== identityKey
    ) {
      return;
    }
    const previous = this.#statusEntries.get(key)?.snapshot;
    this.#setStatus(key, {
      identityKey,
      snapshot: {
        ...status,
        activeLinkCount: 1,
        consumerCount: previous?.consumerCount ?? 0,
        freshness: "active",
        workerId,
      },
      timer: null,
    });
  }

  #setConsumerCount(key: string, consumerCount: number): void {
    const entry = this.#statusEntries.get(key);
    if (!entry || entry.snapshot.freshness !== "active") return;
    this.#setStatus(key, {
      identityKey: entry.identityKey,
      snapshot: { ...entry.snapshot, consumerCount },
      timer: null,
    });
  }

  #retainLastUsed(
    key: string,
    state: Extract<WorkerLinkConnectionState, "idle" | "offline">,
  ): void {
    const entry = this.#statusEntries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const retained: ManagedStatusEntry = {
      identityKey: entry.identityKey,
      snapshot: {
        ...entry.snapshot,
        activeChannelCount: 0,
        activeLinkCount: 0,
        changedAt: new Date(this.dependencies.now()).toISOString(),
        consumerCount: 0,
        freshness: "last-used",
        routeChannelCounts: emptyRouteChannelCounts(),
        state,
      },
      timer: null,
    };
    if (this.#lastUsedStatusTtlMs === 0) {
      this.#statusEntries.delete(key);
      this.#publishStatusSnapshot();
      return;
    }
    retained.timer = setTimeout(() => {
      if (this.#statusEntries.get(key) !== retained) return;
      this.#statusEntries.delete(key);
      this.#publishStatusSnapshot();
    }, this.#lastUsedStatusTtlMs);
    this.#statusEntries.set(key, retained);
    this.#publishStatusSnapshot();
  }

  #setStatus(key: string, entry: ManagedStatusEntry): void {
    const previous = this.#statusEntries.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    this.#statusEntries.set(key, entry);
    this.#publishStatusSnapshot();
  }

  #removeStatus(key: string): void {
    const entry = this.#statusEntries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.#statusEntries.delete(key);
    this.#publishStatusSnapshot();
  }

  #clearStatuses(): void {
    if (this.#statusEntries.size === 0) return;
    for (const entry of this.#statusEntries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.#statusEntries.clear();
    this.#publishStatusSnapshot();
  }

  #publishStatusSnapshot(): void {
    this.#statusSnapshot = [...this.#statusEntries.values()]
      .map((entry) => entry.snapshot)
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
    for (const listener of this.#statusListeners) listener();
  }
}

interface ActiveWorkerLinkCarrier {
  carrier: WorkerLinkCarrier;
  scheduler: WorkerLinkFrameScheduler;
  unsubscribers: Array<() => void>;
}

class WorkerLinkRouteUnavailableError extends Error {}

class ClientWorkerLink implements WorkerLink {
  readonly #activeStreamRoutes = new Map<string, WorkerLinkRoute>();
  readonly #carrierOpenings = new Map<
    WorkerLinkRoute,
    Promise<ActiveWorkerLinkCarrier>
  >();
  readonly #carriers = new Map<WorkerLinkRoute, ActiveWorkerLinkCarrier>();
  #closed = false;
  #connectionState: WorkerLinkConnectionState = "connecting";
  #connecting: Promise<void> | null = null;
  #directProbe: Promise<void> | null = null;
  readonly #routeFailures = new Map<
    WorkerLinkRoute,
    WorkerLinkRouteStatus["fallbackReason"]
  >();
  readonly #routeListeners = new Set<(status: WorkerLinkRouteStatus) => void>();
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  #routeStatus: WorkerLinkRouteStatus;
  #session: WorkerLinkSession;
  readonly #streams = new Map<string, ClientWorkerLinkStream>();
  #telemetry: WorkerLinkTelemetryReporter;
  #statusEnabled = true;

  constructor(
    session: WorkerLinkSession,
    private readonly clientIdentity: ClientSessionIdentitySnapshot,
    private readonly clientInstanceId: string,
    private readonly dependencies: WorkerLinkManagerDependencies,
    private readonly publishStatus: (status: ClientWorkerLinkStatus) => void,
  ) {
    this.#session = session;
    this.#telemetry = new WorkerLinkTelemetryReporter(
      session.sessionId,
      dependencies,
    );
    this.#routeStatus = {
      preferredRoute: session.preferredRoute,
      effectiveRoute: session.preferredRoute,
      routeGeneration: session.routeGeneration,
      latencyMs: null,
      fallbackReason: null,
      changedAt: new Date(dependencies.now()).toISOString(),
    };
  }

  get preferredRoute(): WorkerLinkRoute {
    return this.#routeStatus.preferredRoute;
  }

  get session(): WorkerLinkSession {
    return this.#session;
  }

  get workerId(): string {
    return this.#session.identity.workerId;
  }

  async start(): Promise<void> {
    this.#transition("connecting");
    try {
      await this.#connect();
      this.#recordTelemetry("session-opened", 1, "none");
      this.#scheduleRenewal();
    } catch (error) {
      this.#transition("offline");
      throw error;
    }
  }

  onRouteChanged(
    listener: (status: WorkerLinkRouteStatus) => void,
  ): () => void {
    this.#routeListeners.add(listener);
    listener(this.#routeStatus);
    return () => this.#routeListeners.delete(listener);
  }

  async openStream(
    grant: WorkerLinkResourceGrant,
    lane: WorkerLinkQosLane,
  ): Promise<WorkerLinkStream> {
    if (this.#closed || this.#carriers.size === 0) {
      throw new Error("WorkerLink is not connected.");
    }
    validateGrant(grant, this.#session, lane, this.dependencies.now());
    let unavailable: unknown = null;
    for (const route of this.#availableRoutes()) {
      const active = this.#carriers.get(route);
      if (!active) continue;
      const channelId = this.dependencies.createId();
      let countedActive = false;
      const stream = new ClientWorkerLinkStream(
        channelId,
        this.dependencies.createId(),
        lane,
        route,
        this.#session,
        (header, payload) => {
          const current = this.#carriers.get(route);
          const sent =
            current === active && active.scheduler.enqueue(header, payload);
          if (!sent) {
            this.#recordTelemetry(
              "queue-pressure",
              1,
              "congested",
              lane,
              route,
            );
          }
          return sent;
        },
        (preserveClose) => {
          this.#streams.delete(channelId);
          if (countedActive) {
            countedActive = false;
            if (this.#activeStreamRoutes.delete(channelId)) this.#emitStatus();
          }
          active.scheduler.cancelChannel(channelId, preserveClose);
        },
        (event, value, reason) =>
          this.#recordTelemetry(event, value, reason, lane, route),
      );
      this.#streams.set(channelId, stream);
      try {
        await stream.open(grant);
        if (this.#streams.get(channelId) === stream) {
          countedActive = true;
          this.#activeStreamRoutes.set(channelId, route);
          this.#emitStatus();
        }
        return stream;
      } catch (error) {
        this.#streams.delete(channelId);
        stream.retire("protocol-error");
        if (
          error instanceof WorkerLinkRouteUnavailableError ||
          this.#carriers.get(route) !== active
        ) {
          unavailable = error;
          continue;
        }
        throw error;
      }
    }
    throw (
      unavailable ??
      new WorkerLinkRouteUnavailableError(
        "No WorkerLink carrier accepted the channel.",
      )
    );
  }

  async reprobe(): Promise<void> {
    if (this.#closed) throw new Error("WorkerLink is closed.");
    this.#transition(this.#carriers.size > 0 ? "degraded" : "reconnecting");
    await Promise.allSettled([this.#ensureRelay(), this.#probeDirect()]);
    if (this.#carriers.size === 0) {
      this.#transition("offline");
      throw new Error("WorkerLink reprobe found no usable route.");
    }
    this.#transition("active");
  }

  async retire(code: WorkerLinkChannelCloseCode): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#statusEnabled = false;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
    this.#recordTelemetry("session-closed", 1, code);
    this.#detachAllCarriers(code);
    await this.#telemetry.close();
    await this.dependencies
      .deleteSession(this.#session.sessionId)
      .catch(() => undefined);
    this.#routeListeners.clear();
  }

  async #connect(): Promise<void> {
    if (this.#connecting) return this.#connecting;
    const attempt = this.#connectWithFallback();
    this.#connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.#connecting === attempt) this.#connecting = null;
    }
  }

  async #connectWithFallback(): Promise<void> {
    if (this.#closed) throw new Error("WorkerLink is closed.");
    const attempts: Promise<unknown>[] = [];
    if (this.#session.routePolicy.enabled.includes("relay")) {
      attempts.push(this.#ensureRelay());
    }
    if (this.#session.routePolicy.enabled.some((route) => route !== "relay")) {
      attempts.push(this.#probeDirect());
    }
    if (attempts.length === 0) {
      throw new Error("WorkerLink authority enabled no usable route.");
    }
    try {
      await Promise.any(attempts);
    } catch {
      throw new Error("No WorkerLink route could be established.");
    }
    this.#transition("active");
  }

  #ensureRelay(): Promise<ActiveWorkerLinkCarrier> {
    return this.#ensureCarrier("relay");
  }

  async #probeDirect(): Promise<void> {
    if (this.#directProbe) return this.#directProbe;
    const probe = (async () => {
      for (const route of this.#session.routePolicy.priority) {
        if (route === "relay") break;
        if (!this.#session.routePolicy.enabled.includes(route)) continue;
        if (route === "local" && !this.dependencies.localSupported()) {
          this.#noteRouteFailure(route, "local-unsupported");
          continue;
        }
        if (this.#carriers.has(route)) {
          this.#publishPreferredRoute();
          return;
        }
        try {
          await this.#ensureCarrier(route);
          return;
        } catch {
          this.#noteRouteFailure(route, unavailableReason(route));
        }
      }
      throw new Error("No direct WorkerLink route could be established.");
    })();
    this.#directProbe = probe;
    try {
      await probe;
    } finally {
      if (this.#directProbe === probe) this.#directProbe = null;
    }
  }

  async #ensureCarrier(
    route: WorkerLinkRoute,
  ): Promise<ActiveWorkerLinkCarrier> {
    const existing = this.#carriers.get(route);
    if (existing) return existing;
    const opening = this.#carrierOpenings.get(route);
    if (opening) return opening;
    const session = this.#session;
    const operation = (async () => {
      const carrier =
        route === "local"
          ? await this.dependencies.openLocal(session)
          : route === "relay"
            ? await this.dependencies.openRelay(
                session,
                this.clientIdentity,
                this.clientInstanceId,
              )
            : await this.dependencies.openPeer(session, route);
      if (
        this.#closed ||
        this.#session.sessionId !== session.sessionId ||
        this.#session.routeGeneration !== session.routeGeneration ||
        carrier.route !== route
      ) {
        carrier.close("stale-carrier");
        throw new WorkerLinkRouteUnavailableError(
          "WorkerLink carrier authority changed during setup.",
        );
      }
      return this.#installCarrier(carrier);
    })();
    this.#carrierOpenings.set(route, operation);
    try {
      return await operation;
    } finally {
      if (this.#carrierOpenings.get(route) === operation) {
        this.#carrierOpenings.delete(route);
      }
    }
  }

  #installCarrier(carrier: WorkerLinkCarrier): ActiveWorkerLinkCarrier {
    const route = carrier.route;
    const previous = this.#carriers.get(route);
    if (previous) {
      carrier.close("duplicate-carrier");
      return previous;
    }
    const scheduler = new WorkerLinkFrameScheduler(carrier, (lane) => {
      for (const stream of this.#streams.values()) {
        if (stream.route === route && stream.lane === lane) {
          stream.notifyWritable();
        }
      }
    });
    const active: ActiveWorkerLinkCarrier = {
      carrier,
      scheduler,
      unsubscribers: [],
    };
    active.unsubscribers = [
      carrier.onFrame((frame) => this.#receive(route, active, frame)),
      carrier.onClose(() => {
        if (this.#carriers.get(route) !== active || this.#closed) return;
        this.#detachCarrier(route, "endpoint-disconnected", active, false);
        this.#noteRouteFailure(route, disconnectedReason(route));
        this.#transition(this.#carriers.size > 0 ? "degraded" : "reconnecting");
        void this.#recover();
      }),
    ];
    this.#carriers.set(route, active);
    this.#routeFailures.delete(route);
    this.#publishPreferredRoute();
    this.#recordTelemetry(
      "route-selected",
      1,
      "none",
      null,
      route,
      carrier.latencyMs,
    );
    return active;
  }

  async #recover(): Promise<void> {
    if (this.#connecting || this.#closed) return this.#connecting ?? undefined;
    const recovery = (async () => {
      for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        await delay(
          RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_DELAYS_MS.at(-1)!,
        );
        if (this.#closed) return;
        this.#recordTelemetry(
          "reconnect-attempt",
          1,
          this.#routeStatus.fallbackReason ?? "route-replaced",
        );
        await Promise.allSettled([this.#ensureRelay(), this.#probeDirect()]);
        if (this.#carriers.size > 0) {
          this.#transition("active");
          return;
        }
      }
      try {
        await this.#replaceSession();
        await this.#connectWithFallback();
        this.#recordTelemetry("session-opened", 1, "route-replaced");
        this.#scheduleRenewal();
      } catch {
        if (!this.#closed && this.#carriers.size === 0) {
          this.#transition("offline");
        }
      }
    })();
    this.#connecting = recovery;
    try {
      await recovery;
    } finally {
      if (this.#connecting === recovery) this.#connecting = null;
    }
  }

  async #replaceSession(): Promise<void> {
    const previousSessionId = this.#session.sessionId;
    const replacement = await this.dependencies.createSession(
      this.workerId,
      this.clientInstanceId,
    );
    validateSessionAuthority(
      replacement,
      this.workerId,
      this.clientInstanceId,
      this.clientIdentity,
    );
    this.#detachAllCarriers("route-replaced");
    this.#routeFailures.clear();
    this.#recordTelemetry("session-closed", 1, "endpoint-disconnected");
    await this.#telemetry.close();
    this.#session = replacement;
    this.#telemetry = new WorkerLinkTelemetryReporter(
      replacement.sessionId,
      this.dependencies,
    );
    this.#routeStatus = {
      preferredRoute: replacement.preferredRoute,
      effectiveRoute: replacement.preferredRoute,
      routeGeneration: replacement.routeGeneration,
      latencyMs: null,
      fallbackReason: null,
      changedAt: new Date(this.dependencies.now()).toISOString(),
    };
    if (replacement.sessionId !== previousSessionId) {
      await this.dependencies
        .deleteSession(previousSessionId)
        .catch(() => undefined);
    }
  }

  #receive(
    route: WorkerLinkRoute,
    active: ActiveWorkerLinkCarrier,
    frame: Uint8Array,
  ): void {
    let decoded: ReturnType<typeof decodeWorkerLinkFrame>;
    try {
      decoded = decodeWorkerLinkFrame(frame);
    } catch {
      active.carrier.close("invalid-frame");
      return;
    }
    const { header, payload } = decoded;
    if (
      this.#carriers.get(route) !== active ||
      header.sessionId !== this.#session.sessionId ||
      header.routeGeneration !== this.#session.routeGeneration ||
      header.effectiveRoute !== route
    ) {
      return;
    }
    this.#streams.get(header.channel.channelId)?.receive(header, payload);
  }

  #detachCarrier(
    route: WorkerLinkRoute,
    code: WorkerLinkChannelCloseCode,
    expected = this.#carriers.get(route),
    closeCarrier = true,
  ): void {
    if (!expected || this.#carriers.get(route) !== expected) return;
    this.#carriers.delete(route);
    expected.scheduler.close();
    for (const unsubscribe of expected.unsubscribers) unsubscribe();
    for (const stream of [...this.#streams.values()]) {
      if (stream.route === route) stream.retire(code);
    }
    if (closeCarrier) expected.carrier.close(code);
    this.#publishPreferredRoute();
  }

  #detachAllCarriers(code: WorkerLinkChannelCloseCode): void {
    for (const route of [...this.#carriers.keys()]) {
      this.#detachCarrier(route, code);
    }
    this.#activeStreamRoutes.clear();
    this.#streams.clear();
  }

  #noteRouteFailure(
    route: WorkerLinkRoute,
    reason: WorkerLinkRouteStatus["fallbackReason"],
  ): void {
    this.#routeFailures.set(route, reason);
    this.#publishPreferredRoute();
    if (reason) {
      this.#recordTelemetry("route-fallback", 1, reason, null, route);
    }
  }

  #publishPreferredRoute(): void {
    const route = this.#availableRoutes()[0];
    if (!route) {
      this.#emitStatus();
      return;
    }
    const fallbackReason = this.#fallbackFor(route);
    const carrier = this.#carriers.get(route)!.carrier;
    const previous = this.#routeStatus;
    this.#routeStatus = {
      preferredRoute: route,
      effectiveRoute: route,
      routeGeneration: this.#session.routeGeneration,
      latencyMs: carrier.latencyMs,
      fallbackReason,
      changedAt:
        previous.effectiveRoute === route &&
        previous.fallbackReason === fallbackReason
          ? previous.changedAt
          : new Date(this.dependencies.now()).toISOString(),
    };
    if (
      previous.effectiveRoute !== route ||
      previous.fallbackReason !== fallbackReason ||
      previous.routeGeneration !== this.#session.routeGeneration
    ) {
      for (const listener of this.#routeListeners) listener(this.#routeStatus);
    }
    this.#emitStatus();
  }

  #fallbackFor(
    effectiveRoute: WorkerLinkRoute,
  ): WorkerLinkRouteStatus["fallbackReason"] {
    if (
      effectiveRoute === "relay" &&
      this.#session.routePolicy.enabled.length === 1
    ) {
      return "policy-relay-only";
    }
    const effectiveIndex =
      this.#session.routePolicy.priority.indexOf(effectiveRoute);
    let reason: WorkerLinkRouteStatus["fallbackReason"] = null;
    for (const route of this.#session.routePolicy.priority.slice(
      0,
      effectiveIndex,
    )) {
      reason = this.#routeFailures.get(route) ?? reason;
    }
    return reason;
  }

  #availableRoutes(): WorkerLinkRoute[] {
    return this.#session.routePolicy.priority.filter((route) =>
      this.#carriers.has(route),
    );
  }

  #scheduleRenewal(): void {
    if (this.#closed) return;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    const delayMs = Math.max(
      MIN_RENEW_DELAY_MS,
      Date.parse(this.#session.lease.expiresAt) -
        this.dependencies.now() -
        RENEW_AHEAD_MS,
    );
    this.#renewTimer = setTimeout(() => {
      this.#renewTimer = null;
      const expectedSession = this.#session;
      void this.dependencies
        .renewSession(expectedSession.sessionId)
        .then((session) => {
          if (this.#closed) return;
          if (
            session.sessionId !== expectedSession.sessionId ||
            session.routeGeneration !== expectedSession.routeGeneration ||
            JSON.stringify(session.identity) !==
              JSON.stringify(expectedSession.identity)
          ) {
            this.#detachAllCarriers("route-replaced");
            void this.#recover();
            return;
          }
          this.#session = session;
          this.#emitStatus();
          this.#scheduleRenewal();
        })
        .catch(() => {
          this.#detachAllCarriers("endpoint-disconnected");
          void this.#recover();
        });
    }, delayMs);
  }

  #transition(state: WorkerLinkConnectionState): void {
    this.#connectionState = state;
    this.#emitStatus();
  }

  #emitStatus(): void {
    if (!this.#statusEnabled) return;
    const routeCounts = new Map<WorkerLinkRoute, number>();
    for (const route of this.#activeStreamRoutes.values()) {
      routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
    }
    const preferred = this.#availableRoutes()[0] ?? null;
    const effectiveRoutes =
      routeCounts.size > 0
        ? this.#session.routePolicy.priority.filter((route) =>
            routeCounts.has(route),
          )
        : preferred
          ? [preferred]
          : [];
    this.publishStatus({
      activeChannelCount: this.#activeStreamRoutes.size,
      changedAt: this.#routeStatus.changedAt,
      effectiveRoutes,
      fallbackReason: this.#routeStatus.fallbackReason,
      latencyMs: preferred
        ? (this.#carriers.get(preferred)?.carrier.latencyMs ?? null)
        : null,
      preferredRoute: preferred,
      routeChannelCounts: routeChannelCounts(routeCounts),
      routeGeneration: this.#session.routeGeneration,
      state: this.#connectionState,
    });
  }

  #recordTelemetry(
    event: WorkerLinkTelemetrySample["event"],
    value: number,
    reason: WorkerLinkTelemetrySample["reason"],
    lane: WorkerLinkQosLane | null = null,
    route: WorkerLinkRoute | null = this.preferredRoute,
    latencyMs: number | null = null,
  ): void {
    this.#telemetry.record(this.#session.routeGeneration, {
      event,
      route,
      lane,
      value,
      latencyMs,
      reason,
    });
  }
}

interface ScheduledWorkerLinkFrame {
  bytes: number;
  header: WorkerLinkFrameHeader;
  payload: Uint8Array;
}

class WorkerLinkFrameScheduler {
  readonly #bytes = new Map<WorkerLinkQosLane, number>();
  #closed = false;
  #laneIndex = 0;
  readonly #queues = new Map<WorkerLinkQosLane, ScheduledWorkerLinkFrame[]>();
  #scheduled = false;
  readonly #saturated = new Set<WorkerLinkQosLane>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly carrier: WorkerLinkCarrier,
    private readonly available: (lane: WorkerLinkQosLane) => void,
  ) {
    for (const lane of new Set(SCHEDULER_LANES)) {
      this.#queues.set(lane, []);
      this.#bytes.set(lane, 0);
    }
  }

  enqueue(header: WorkerLinkFrameHeader, payload: Uint8Array): boolean {
    if (this.#closed) return false;
    const queue = this.#queues.get(header.lane);
    if (!queue) return false;
    const frameBytes = WORKER_LINK_MAX_HEADER_BYTES + payload.byteLength;
    const laneBytes = this.#bytes.get(header.lane) ?? 0;
    if (
      queue.length >= SCHEDULER_MAX_FRAMES_PER_LANE ||
      laneBytes + frameBytes > SCHEDULER_MAX_BYTES_PER_LANE
    ) {
      this.#saturated.add(header.lane);
      return false;
    }
    queue.push({
      bytes: frameBytes,
      header: workerLinkFrameHeaderSchema.parse(header),
      payload: Uint8Array.from(payload),
    });
    this.#bytes.set(header.lane, laneBytes + frameBytes);
    this.#schedule();
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const queue of this.#queues.values()) queue.length = 0;
    this.#bytes.clear();
    this.#saturated.clear();
  }

  cancelChannel(channelId: string, preserveClose: boolean): void {
    if (preserveClose) return;
    for (const [lane, queue] of this.#queues) {
      let removedBytes = 0;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const frame = queue[index]!;
        if (frame.header.channel.channelId === channelId) {
          removedBytes += frame.bytes;
          queue.splice(index, 1);
        }
      }
      if (removedBytes > 0) {
        this.#bytes.set(
          lane,
          Math.max(0, (this.#bytes.get(lane) ?? 0) - removedBytes),
        );
      }
    }
  }

  #schedule(delayMs = 0): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    if (delayMs === 0) {
      queueMicrotask(() => this.#drain());
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#drain();
    }, delayMs);
  }

  #drain(): void {
    this.#scheduled = false;
    if (this.#closed) return;
    let sent = 0;
    while (sent < SCHEDULER_BURST_FRAMES) {
      const next = this.#next();
      if (!next) return;
      if (!this.carrier.send(next.header, next.payload)) {
        this.#schedule(SCHEDULER_RETRY_MS);
        return;
      }
      const queue = this.#queues.get(next.header.lane)!;
      queue.shift();
      this.#bytes.set(
        next.header.lane,
        Math.max(0, (this.#bytes.get(next.header.lane) ?? 0) - next.bytes),
      );
      if (this.#saturated.delete(next.header.lane)) {
        this.available(next.header.lane);
      }
      sent += 1;
    }
    if (this.#hasQueuedFrames()) this.#schedule(1);
  }

  #next(): ScheduledWorkerLinkFrame | null {
    for (let checked = 0; checked < SCHEDULER_LANES.length; checked += 1) {
      const lane = SCHEDULER_LANES[this.#laneIndex]!;
      this.#laneIndex = (this.#laneIndex + 1) % SCHEDULER_LANES.length;
      const frame = this.#queues.get(lane)?.[0];
      if (frame) return frame;
    }
    return null;
  }

  #hasQueuedFrames(): boolean {
    for (const queue of this.#queues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }
}

class ClientWorkerLinkStream implements WorkerLinkStream {
  #accepted = false;
  #canHalfClose = false;
  #canRead = false;
  #canWrite = false;
  #closeListeners = new Set<WorkerLinkStreamCloseListener>();
  #closed = false;
  #creditBytes = 0;
  #dataListeners = new Set<WorkerLinkDataListener>();
  #errorListeners = new Set<WorkerLinkStreamErrorListener>();
  #halfCloseListeners = new Set<WorkerLinkStreamHalfCloseListener>();
  #inboundCreditLimit = 0;
  #inboundSequence = -1;
  #inboundUncreditedBytes = 0;
  #openReject: ((error: Error) => void) | null = null;
  #openResolve: (() => void) | null = null;
  #outboundSequence = 0;
  #rejectionReported = false;
  #writableListeners = new Set<WorkerLinkStreamWritableListener>();

  constructor(
    readonly channelId: string,
    readonly connectionId: string,
    readonly lane: WorkerLinkQosLane,
    readonly route: WorkerLinkRoute,
    private readonly session: WorkerLinkSession,
    private readonly sendFrame: (
      header: WorkerLinkFrameHeader,
      payload: Uint8Array,
    ) => boolean,
    private readonly onRetired: (preserveClose: boolean) => void,
    private readonly recordTelemetry: (
      event: WorkerLinkTelemetrySample["event"],
      value: number,
      reason: WorkerLinkTelemetrySample["reason"],
    ) => void,
  ) {}

  open(grant: WorkerLinkResourceGrant): Promise<void> {
    this.#canRead = grant.binding.operations.includes("stream:read");
    this.#canWrite = grant.binding.operations.includes("stream:write");
    this.#canHalfClose = grant.binding.operations.includes("stream:half-close");
    const opened = new Promise<void>((resolve, reject) => {
      this.#openResolve = resolve;
      this.#openReject = reject;
    });
    if (
      !this.sendFrame(
        this.#header({
          kind: "open",
          openNonce: crypto.randomUUID(),
          channelKind: "reliable-stream",
          grant,
          initialCreditBytes: INITIAL_CREDIT_BYTES,
        }),
        EMPTY_PAYLOAD,
      )
    ) {
      this.#rejectOpen(
        new WorkerLinkRouteUnavailableError(
          "WorkerLink carrier rejected the channel open.",
        ),
      );
    }
    const timeout = setTimeout(
      () => this.#rejectOpen("WorkerLink channel open timed out."),
      OPEN_TIMEOUT_MS,
    );
    return opened.finally(() => clearTimeout(timeout));
  }

  write(payload: Uint8Array, format: WorkerLinkPayloadFormat = "raw"): boolean {
    if (
      !this.#accepted ||
      this.#closed ||
      !this.#canWrite ||
      payload.byteLength === 0 ||
      payload.byteLength > WORKER_LINK_MAX_PAYLOAD_BYTES ||
      payload.byteLength > this.#creditBytes
    ) {
      return false;
    }
    const sent = this.#send(
      {
        kind: "data",
        direction: "client-to-worker",
        payloadFormat: format,
      },
      payload,
    );
    if (sent) {
      this.#creditBytes -= payload.byteLength;
      this.recordTelemetry("bytes-sent", payload.byteLength, "none");
    }
    return sent;
  }

  acknowledge(bytes: number): boolean {
    if (
      !this.#accepted ||
      this.#closed ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > this.#inboundUncreditedBytes
    ) {
      return false;
    }
    const sent = this.#send({
      kind: "credit",
      direction: "worker-to-client",
      bytes,
    });
    if (sent) this.#inboundUncreditedBytes -= bytes;
    return sent;
  }

  halfClose(): boolean {
    return this.#accepted && this.#canHalfClose
      ? this.#send({ kind: "half-close", direction: "client-to-worker" })
      : false;
  }

  close(code: WorkerLinkChannelCloseCode = "normal"): void {
    if (this.#closed) return;
    const preserveClose = this.#accepted && this.#send({ kind: "close", code });
    this.retire(code, preserveClose);
  }

  onClose(listener: WorkerLinkStreamCloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onData(listener: WorkerLinkDataListener): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onError(listener: WorkerLinkStreamErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  onHalfClose(listener: WorkerLinkStreamHalfCloseListener): () => void {
    this.#halfCloseListeners.add(listener);
    return () => this.#halfCloseListeners.delete(listener);
  }

  onWritable(listener: WorkerLinkStreamWritableListener): () => void {
    this.#writableListeners.add(listener);
    if (this.#accepted && !this.#closed && this.#creditBytes > 0) listener();
    return () => this.#writableListeners.delete(listener);
  }

  notifyWritable(): void {
    if (!this.#accepted || this.#closed || this.#creditBytes <= 0) return;
    for (const listener of this.#writableListeners) listener();
  }

  receive(header: WorkerLinkFrameHeader, payload: Uint8Array): void {
    if (
      this.#closed ||
      header.channel.channelId !== this.channelId ||
      header.channel.connectionId !== this.connectionId ||
      header.lane !== this.lane
    ) {
      return;
    }
    if (header.sequence <= this.#inboundSequence) return;
    if (header.sequence !== this.#inboundSequence + 1) {
      this.retire("protocol-error");
      return;
    }
    this.#inboundSequence = header.sequence;
    if (!this.#accepted) {
      if (header.kind === "accept") {
        this.#accepted = true;
        this.#creditBytes = header.initialCreditBytes;
        this.#inboundCreditLimit = header.initialCreditBytes;
        this.recordTelemetry("channel-opened", 1, "none");
        this.#openResolve?.();
        this.#clearOpenCallbacks();
      } else if (header.kind === "reject") {
        for (const listener of this.#errorListeners) listener(header.code);
        this.#rejectionReported = true;
        this.recordTelemetry("channel-rejected", 1, header.code);
        this.#rejectOpen(`WorkerLink channel was rejected: ${header.code}.`);
      } else {
        this.retire("protocol-error");
      }
      return;
    }
    switch (header.kind) {
      case "data":
        if (
          header.direction !== "worker-to-client" ||
          !this.#canRead ||
          payload.byteLength === 0
        ) {
          this.retire("protocol-error");
          return;
        }
        if (
          this.#inboundUncreditedBytes + payload.byteLength >
          this.#inboundCreditLimit
        ) {
          this.retire("protocol-error");
          return;
        }
        this.#inboundUncreditedBytes += payload.byteLength;
        this.recordTelemetry("bytes-received", payload.byteLength, "none");
        for (const listener of this.#dataListeners) listener(payload);
        return;
      case "credit":
        if (header.direction !== "client-to-worker") {
          this.retire("protocol-error");
          return;
        }
        this.#creditBytes = Math.min(
          WORKER_LINK_MAX_CREDIT_BYTES,
          this.#creditBytes + header.bytes,
        );
        for (const listener of this.#writableListeners) listener();
        return;
      case "close":
        this.retire(header.code);
        return;
      case "error":
        for (const listener of this.#errorListeners) listener(header.code);
        this.retire("protocol-error");
        return;
      case "half-close":
        if (header.direction !== "worker-to-client") {
          this.retire("protocol-error");
          return;
        }
        for (const listener of this.#halfCloseListeners) listener();
        return;
      case "accept":
      case "reject":
      case "open":
        this.retire("protocol-error");
    }
  }

  retire(code: WorkerLinkChannelCloseCode, preserveClose = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#openReject?.(new Error(`WorkerLink channel closed: ${code}.`));
    this.#clearOpenCallbacks();
    if (this.#accepted) {
      this.recordTelemetry(
        code === "revoked" ? "channel-revoked" : "channel-closed",
        1,
        code,
      );
    } else if (!this.#rejectionReported) {
      this.#rejectionReported = true;
      this.recordTelemetry("channel-rejected", 1, code);
    }
    this.onRetired(preserveClose);
    for (const listener of this.#closeListeners) listener(code);
    this.#closeListeners.clear();
    this.#dataListeners.clear();
    this.#errorListeners.clear();
    this.#halfCloseListeners.clear();
    this.#writableListeners.clear();
  }

  #send(
    detail:
      | {
          kind: "data";
          direction: "client-to-worker";
          payloadFormat: WorkerLinkPayloadFormat;
        }
      | { kind: "credit"; direction: "worker-to-client"; bytes: number }
      | { kind: "half-close"; direction: "client-to-worker" }
      | { kind: "close"; code: WorkerLinkChannelCloseCode },
    payload: Uint8Array = EMPTY_PAYLOAD,
  ): boolean {
    const sequence = this.#outboundSequence + 1;
    const sent = this.sendFrame(this.#header({ ...detail, sequence }), payload);
    if (sent) this.#outboundSequence = sequence;
    return sent;
  }

  #header(
    detail:
      | Omit<
          Extract<WorkerLinkFrameHeader, { kind: "open" }>,
          keyof CommonHeader
        >
      | (Omit<
          Extract<WorkerLinkFrameHeader, { kind: "data" }>,
          keyof CommonHeader
        > & {
          sequence: number;
        })
      | (Omit<
          Extract<WorkerLinkFrameHeader, { kind: "credit" }>,
          keyof CommonHeader
        > & {
          sequence: number;
        })
      | (Omit<
          Extract<WorkerLinkFrameHeader, { kind: "half-close" }>,
          keyof CommonHeader
        > & {
          sequence: number;
        })
      | (Omit<
          Extract<WorkerLinkFrameHeader, { kind: "close" }>,
          keyof CommonHeader
        > & {
          sequence: number;
        }),
  ): WorkerLinkFrameHeader {
    return {
      protocolVersion: 1,
      sessionId: this.session.sessionId,
      routeGeneration: this.session.routeGeneration,
      effectiveRoute: this.route,
      channel: {
        channelId: this.channelId,
        connectionId: this.connectionId,
      },
      lane: this.lane,
      sequence: "sequence" in detail ? detail.sequence : 0,
      ...detail,
    } as WorkerLinkFrameHeader;
  }

  #rejectOpen(error: string | Error): void {
    this.#openReject?.(typeof error === "string" ? new Error(error) : error);
    this.#clearOpenCallbacks();
    this.retire("protocol-error");
  }

  #clearOpenCallbacks(): void {
    this.#openResolve = null;
    this.#openReject = null;
  }
}

type CommonHeader = Pick<
  WorkerLinkFrameHeader,
  | "protocolVersion"
  | "sessionId"
  | "routeGeneration"
  | "effectiveRoute"
  | "channel"
  | "lane"
  | "sequence"
>;

function validateGrant(
  grant: WorkerLinkResourceGrant,
  session: WorkerLinkSession,
  lane: WorkerLinkQosLane,
  now: number,
): void {
  const binding = grant.binding;
  if (
    binding.sessionId !== session.sessionId ||
    JSON.stringify(binding.identity) !== JSON.stringify(session.identity) ||
    !binding.lanes.includes(lane) ||
    !binding.operations.includes("stream:open") ||
    Date.parse(binding.lease.expiresAt) <= now
  ) {
    throw new Error("WorkerLink grant does not authorize this stream.");
  }
}

function validateSessionAuthority(
  session: WorkerLinkSession,
  workerId: string,
  clientInstanceId: string,
  identity: ClientSessionIdentitySnapshot,
): void {
  if (
    session.identity.serverId !== identity.serverId ||
    session.identity.ownerId !== identity.userId ||
    session.identity.workerId !== workerId ||
    session.identity.clientInstanceId !== clientInstanceId
  ) {
    throw new Error(
      "WorkerLink authority returned a mismatched session identity.",
    );
  }
  if (
    !session.routePolicy.enabled.includes(session.preferredRoute) ||
    session.routePolicy.priority.some(
      (route, index, routes) => routes.indexOf(route) !== index,
    ) ||
    session.routePolicy.enabled.some(
      (route) => !session.routePolicy.priority.includes(route),
    )
  ) {
    throw new Error("WorkerLink authority returned an invalid route policy.");
  }
}

function clientIdentityKey(identity: ClientSessionIdentitySnapshot): string {
  return JSON.stringify([
    identity.accountId,
    identity.connectionId,
    identity.generation,
    identity.incarnationId,
    identity.serverId,
    identity.serverUrl,
    identity.userId,
  ]);
}

function emptyRouteChannelCounts(): readonly WorkerLinkRouteChannelCount[] {
  return routeChannelCounts(new Map());
}

function routeChannelCounts(
  counts: ReadonlyMap<WorkerLinkRoute, number>,
): readonly WorkerLinkRouteChannelCount[] {
  return ROUTES.map((route) => ({
    channelCount: counts.get(route) ?? 0,
    route,
  }));
}

function unavailableReason(
  route: Exclude<WorkerLinkRoute, "relay">,
): NonNullable<WorkerLinkRouteStatus["fallbackReason"]> {
  return route === "local"
    ? "local-unavailable"
    : route === "lan"
      ? "lan-unavailable"
      : "wan-unavailable";
}

function disconnectedReason(
  route: WorkerLinkRoute,
): NonNullable<WorkerLinkRouteStatus["fallbackReason"]> {
  return route === "local"
    ? "local-disconnected"
    : route === "lan"
      ? "lan-disconnected"
      : route === "wan"
        ? "wan-disconnected"
        : "relay-disconnected";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaultDependencies: WorkerLinkManagerDependencies = {
  createId: () => crypto.randomUUID(),
  createSession: createWorkerLinkSession,
  deleteSession: deleteWorkerLinkSession,
  getIdentity: getClientSessionIdentitySnapshot,
  localSupported: isTauri,
  now: Date.now,
  openLocal: (session) =>
    openWorkerLinkLocalCarrier({
      createTicket: createWorkerLinkDirectTicket,
      createWebSocket: (url) => new WebSocket(url),
      recordActivity: (capabilityId) =>
        recordDirectAttachmentTelemetry(capabilityId, {
          bytesFromLocal: 0,
          bytesToLocal: 0,
          connectionsClosed: 0,
          connectionsOpened: 0,
        }),
      releaseCapability: deleteDirectAttachment,
      session,
    }),
  openPeer: (session, route) =>
    openWorkerLinkPeerCarrier({
      createPeerSession: createWorkerLinkPeerSession,
      deletePeerSession: deleteWorkerLinkPeerSession,
      readMailbox: readWorkerLinkPeerMailbox,
      route,
      sendSignals: sendWorkerLinkPeerSignals,
      session,
    }),
  openRelay: (session, identity, clientInstanceId) =>
    openWorkerLinkRelayCarrier({
      browserOrigin: globalThis.location?.origin ?? "http://127.0.0.1",
      clientInstanceId,
      createWebSocket: (url) => new WebSocket(url),
      serverUrl: identity.serverUrl ?? "",
      session,
    }),
  renewSession: renewWorkerLinkSession,
  recordTelemetry: recordWorkerLinkTelemetry,
  setRoute: updateWorkerLinkRoute,
  subscribeIdentity: (listener) =>
    onClientSessionIdentityChanged(() => listener()),
};

export const workerLinkManager = new WorkerLinkManager(defaultDependencies);
