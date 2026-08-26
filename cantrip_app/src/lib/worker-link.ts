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
  type WorkerLinkRouteStatus,
  type WorkerLinkSession,
  type WorkerLinkTelemetrySample,
} from "@cantrip/protocol";

import {
  createWorkerLinkDirectTicket,
  createWorkerLinkSession,
  deleteDirectAttachment,
  deleteWorkerLinkSession,
  recordDirectAttachmentTelemetry,
  recordWorkerLinkTelemetry,
  renewWorkerLinkSession,
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
  readonly preferredRoute: "local" | "relay";
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
    route: "local" | "relay",
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

export class WorkerLinkManager {
  readonly #entries = new Map<string, ManagedEntry>();
  readonly #opening = new Map<string, Promise<ManagedEntry>>();
  #closed = false;
  readonly #unsubscribeIdentity: () => void;

  constructor(private readonly dependencies: WorkerLinkManagerDependencies) {
    this.#unsubscribeIdentity = dependencies.subscribeIdentity(() => {
      void this.#retireAll("revoked");
    });
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
  }

  #release(key: string, entry: ManagedEntry): void {
    if (this.#entries.get(key) !== entry) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.#entries.delete(key);
    void entry.link.retire("normal");
  }

  async #retireAll(code: WorkerLinkChannelCloseCode): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.link.retire(code)));
  }

  async #openEntry(
    workerId: string,
    identity: ClientSessionIdentitySnapshot,
    identityKey: string,
    key: string,
  ): Promise<ManagedEntry> {
    const clientInstanceId = this.dependencies.createId();
    const session = await this.dependencies.createSession(
      workerId,
      clientInstanceId,
    );
    validateSessionAuthority(session, workerId, clientInstanceId, identity);
    const link = new ClientWorkerLink(
      session,
      identity,
      clientInstanceId,
      this.dependencies,
    );
    const entry = { identityKey, link, references: 0 };
    try {
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
      await link.retire("endpoint-disconnected");
      throw error;
    }
  }
}

class ClientWorkerLink implements WorkerLink {
  #carrier: WorkerLinkCarrier | null = null;
  #closed = false;
  #connecting: Promise<void> | null = null;
  readonly #routeListeners = new Set<(status: WorkerLinkRouteStatus) => void>();
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  #routeStatus: WorkerLinkRouteStatus;
  #scheduler: WorkerLinkFrameScheduler | null = null;
  #session: WorkerLinkSession;
  readonly #streams = new Map<string, ClientWorkerLinkStream>();
  #telemetry: WorkerLinkTelemetryReporter;
  #unsubscribeCarrier: Array<() => void> = [];

  constructor(
    session: WorkerLinkSession,
    private readonly clientIdentity: ClientSessionIdentitySnapshot,
    private readonly clientInstanceId: string,
    private readonly dependencies: WorkerLinkManagerDependencies,
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

  get preferredRoute(): "local" | "relay" {
    return operationalRoute(this.#session.preferredRoute);
  }

  get session(): WorkerLinkSession {
    return this.#session;
  }

  get workerId(): string {
    return this.#session.identity.workerId;
  }

  async start(): Promise<void> {
    await this.#connect();
    this.#recordTelemetry("session-opened", 1, "none");
    this.#scheduleRenewal();
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
    if (this.#closed || !this.#carrier || !this.#scheduler) {
      throw new Error("WorkerLink is not connected.");
    }
    validateGrant(grant, this.#session, lane, this.dependencies.now());
    const channelId = this.dependencies.createId();
    const stream = new ClientWorkerLinkStream(
      channelId,
      this.dependencies.createId(),
      lane,
      this.#session,
      (header, payload) => {
        const sent = this.#scheduler?.enqueue(header, payload) ?? false;
        if (!sent) {
          this.#recordTelemetry("queue-pressure", 1, "congested", lane);
        }
        return sent;
      },
      (preserveClose) => {
        this.#streams.delete(channelId);
        this.#scheduler?.cancelChannel(channelId, preserveClose);
      },
      (event, value, reason) =>
        this.#recordTelemetry(event, value, reason, lane),
    );
    this.#streams.set(channelId, stream);
    try {
      await stream.open(grant);
      return stream;
    } catch (error) {
      this.#streams.delete(channelId);
      stream.retire("protocol-error");
      throw error;
    }
  }

  reprobe(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("WorkerLink is closed."));
    return this.#connect();
  }

  async retire(code: WorkerLinkChannelCloseCode): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
    this.#recordTelemetry("session-closed", 1, code);
    this.#detachCarrier(code);
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
    this.#detachCarrier("route-replaced");
    let fallbackReason: WorkerLinkRouteStatus["fallbackReason"] = null;
    if (
      this.dependencies.localSupported() &&
      this.#session.routePolicy.enabled.includes("local")
    ) {
      try {
        await this.#selectRoute("local");
        const local = await this.dependencies.openLocal(this.#session);
        this.#installCarrier(local, null);
        return;
      } catch {
        fallbackReason = "local-unavailable";
      }
    } else {
      fallbackReason = "local-unsupported";
    }
    await this.#selectRoute("relay");
    const relay = await this.dependencies.openRelay(
      this.#session,
      this.clientIdentity,
      this.clientInstanceId,
    );
    this.#installCarrier(relay, fallbackReason);
  }

  async #selectRoute(route: "local" | "relay"): Promise<void> {
    if (this.#session.preferredRoute !== route) {
      this.#session = await this.dependencies.setRoute(
        this.#session.sessionId,
        route,
      );
    }
  }

  #installCarrier(
    carrier: WorkerLinkCarrier,
    fallbackReason: WorkerLinkRouteStatus["fallbackReason"],
  ): void {
    if (this.#closed) {
      carrier.close("WorkerLink is closed");
      return;
    }
    this.#carrier = carrier;
    this.#scheduler = new WorkerLinkFrameScheduler(carrier, (lane) => {
      for (const stream of this.#streams.values()) {
        if (stream.lane === lane) stream.notifyWritable();
      }
    });
    this.#unsubscribeCarrier = [
      carrier.onFrame((frame) => this.#receive(frame)),
      carrier.onClose(() => {
        if (this.#carrier !== carrier || this.#closed) return;
        this.#detachCarrier("endpoint-disconnected");
        void this.#reconnect();
      }),
    ];
    this.#publishRoute(carrier.route, carrier.latencyMs, fallbackReason);
    this.#recordTelemetry(
      "route-selected",
      1,
      "none",
      null,
      carrier.route,
      carrier.latencyMs,
    );
    if (fallbackReason) {
      this.#recordTelemetry(
        "route-fallback",
        1,
        fallbackReason,
        null,
        carrier.route,
        carrier.latencyMs,
      );
    }
  }

  async #reconnect(): Promise<void> {
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      await delay(RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_DELAYS_MS.at(-1)!);
      if (this.#closed || this.#carrier) return;
      this.#recordTelemetry("reconnect-attempt", 1, "local-disconnected");
      try {
        await this.#connect();
        return;
      } catch {
        // The next bounded retry restarts at LOCAL.
      }
    }
    if (this.#closed || this.#carrier) return;
    try {
      await this.#replaceSession();
      await this.#connect();
      this.#recordTelemetry("session-opened", 1, "local-disconnected");
      this.#scheduleRenewal();
    } catch {
      // An explicit reprobe or feature reconnect may try again later.
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
    this.#recordTelemetry("session-closed", 1, "endpoint-disconnected");
    await this.#telemetry.close();
    this.#session = replacement;
    this.#telemetry = new WorkerLinkTelemetryReporter(
      replacement.sessionId,
      this.dependencies,
    );
    if (replacement.sessionId !== previousSessionId) {
      await this.dependencies
        .deleteSession(previousSessionId)
        .catch(() => undefined);
    }
  }

  #receive(frame: Uint8Array): void {
    let decoded: ReturnType<typeof decodeWorkerLinkFrame>;
    try {
      decoded = decodeWorkerLinkFrame(frame);
    } catch {
      this.#carrier?.close("invalid-frame");
      return;
    }
    const { header, payload } = decoded;
    if (
      header.sessionId !== this.#session.sessionId ||
      header.routeGeneration !== this.#session.routeGeneration ||
      header.effectiveRoute !== this.#carrier?.route
    ) {
      return;
    }
    this.#streams.get(header.channel.channelId)?.receive(header, payload);
  }

  #detachCarrier(code: WorkerLinkChannelCloseCode): void {
    const carrier = this.#carrier;
    this.#scheduler?.close();
    this.#scheduler = null;
    for (const unsubscribe of this.#unsubscribeCarrier) unsubscribe();
    this.#unsubscribeCarrier = [];
    for (const stream of [...this.#streams.values()]) stream.retire(code);
    this.#streams.clear();
    this.#carrier = null;
    carrier?.close(code);
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
      void this.dependencies
        .renewSession(this.#session.sessionId)
        .then((session) => {
          if (this.#closed) return;
          this.#session = session;
          this.#scheduleRenewal();
        })
        .catch(() => this.#carrier?.close("session-renewal-failed"));
    }, delayMs);
  }

  #publishRoute(
    route: "local" | "relay",
    latencyMs: number | null,
    fallbackReason: WorkerLinkRouteStatus["fallbackReason"],
  ): void {
    this.#routeStatus = {
      preferredRoute: this.#session.preferredRoute,
      effectiveRoute: route,
      routeGeneration: this.#session.routeGeneration,
      latencyMs,
      fallbackReason,
      changedAt: new Date(this.dependencies.now()).toISOString(),
    };
    for (const listener of this.#routeListeners) listener(this.#routeStatus);
  }

  #recordTelemetry(
    event: WorkerLinkTelemetrySample["event"],
    value: number,
    reason: WorkerLinkTelemetrySample["reason"],
    lane: WorkerLinkQosLane | null = null,
    route: "local" | "relay" | null = this.#carrier?.route ?? null,
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
      this.#rejectOpen("WorkerLink carrier rejected the channel open.");
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
      effectiveRoute: operationalRoute(this.session.preferredRoute),
      channel: {
        channelId: this.channelId,
        connectionId: this.connectionId,
      },
      lane: this.lane,
      sequence: "sequence" in detail ? detail.sequence : 0,
      ...detail,
    } as WorkerLinkFrameHeader;
  }

  #rejectOpen(message: string): void {
    this.#openReject?.(new Error(message));
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
  operationalRoute(session.preferredRoute);
  if (
    session.routePolicy.enabled.some(
      (route) => route !== "local" && route !== "relay",
    )
  ) {
    throw new Error("WorkerLink authority enabled a deferred route.");
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

function operationalRoute(
  route: WorkerLinkSession["preferredRoute"],
): "local" | "relay" {
  if (route !== "local" && route !== "relay") {
    throw new Error("WorkerLink LAN/WAN routes are not operational.");
  }
  return route;
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
