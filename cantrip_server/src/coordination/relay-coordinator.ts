import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import {
  workerLinkSessionSchema,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";

import { serverLogger } from "../logger.js";

const DEFAULT_MESSAGE_TTL_MS = 60_000;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const MAX_COORDINATION_MESSAGE_BYTES = 12 * 1_024 * 1_024;

export interface WorkerPresenceClaim {
  connectionId: string;
  expiresAt: number;
  instanceId: string;
  ownerId: string;
  workerId: string;
}

export interface WorkerLinkSessionClaim {
  authorityInstanceId: string;
  expiresAt: number;
  session: WorkerLinkSession;
}

interface CoordinationPayloadBase {
  targetInstanceId?: string;
}

export type RelayCoordinationPayload =
  | (CoordinationPayloadBase & {
      kind: "worker-presence";
      action: "online" | "offline";
      presence: WorkerPresenceClaim;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-disconnect";
      workerId: string;
      connectionId: string;
      code: number;
      reason: string;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-command-request";
      workerId: string;
      ownerId: string;
      requestId: string;
      command: unknown;
      timeoutMs: number;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-command-event";
      requestId: string;
      event: unknown;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-command-response";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-frame";
      direction: "to-worker" | "from-worker";
      ownerId: string;
      workerId: string;
      transport: "surface" | "tunnel" | "worker-link";
      header: unknown;
      payloadBase64: string;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-notification";
      ownerId: string;
      workerId: string;
      notification: unknown;
    })
  | (CoordinationPayloadBase & {
      kind: "live-publication";
      publication: unknown;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-link-operation-request";
      requestId: string;
      operation: unknown;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-link-operation-response";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-link-revoke";
      scope: unknown;
    })
  | (CoordinationPayloadBase & {
      kind: "worker-link-relay-revoke";
      scope: unknown;
    });

export type RelayCoordinationMessage = RelayCoordinationPayload & {
  createdAt: number;
  expiresAt: number;
  messageId: string;
  sourceInstanceId: string;
};

export type RelayCoordinationListener = (
  message: RelayCoordinationMessage,
) => Promise<void> | void;

export interface RelayCoordinatorStats {
  cachedWorkers: number;
  instanceCount: number;
  maximumInstances: number;
  receivedMessages: number;
  rejectedMessages: number;
  sentMessages: number;
  shared: boolean;
}

export interface RelayCoordinator {
  readonly instanceId: string;
  readonly presenceTtlMs: number;
  claimWorker(
    input: Omit<WorkerPresenceClaim, "expiresAt" | "instanceId">,
  ): Promise<WorkerPresenceClaim | null>;
  claimWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<WorkerLinkSessionClaim | null>;
  close(): Promise<void>;
  cachedWorker(workerId: string): WorkerPresenceClaim | null;
  findWorker(workerId: string): Promise<WorkerPresenceClaim | null>;
  findWorkerLinkSession(
    sessionId: string,
  ): Promise<WorkerLinkSessionClaim | null>;
  health(): Promise<boolean>;
  publish(payload: RelayCoordinationPayload, ttlMs?: number): Promise<void>;
  refreshWorker(workerId: string, connectionId: string): Promise<boolean>;
  refreshWorkerLinkSession(claim: WorkerLinkSessionClaim): Promise<boolean>;
  releaseWorker(workerId: string, connectionId: string): Promise<boolean>;
  releaseWorkerLinkSession(
    sessionId: string,
    authorityInstanceId: string,
  ): Promise<boolean>;
  start(): Promise<void>;
  stats(): RelayCoordinatorStats;
  subscribe(listener: RelayCoordinationListener): () => void;
}

function validString(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function parsePresence(value: unknown): WorkerPresenceClaim | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !validString(Reflect.get(value, "connectionId")) ||
    !validString(Reflect.get(value, "instanceId")) ||
    !validString(Reflect.get(value, "ownerId")) ||
    !validString(Reflect.get(value, "workerId")) ||
    typeof Reflect.get(value, "expiresAt") !== "number"
  ) {
    return null;
  }
  return value as WorkerPresenceClaim;
}

function parseWorkerLinkSessionClaim(
  value: unknown,
): WorkerLinkSessionClaim | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !validString(Reflect.get(value, "authorityInstanceId")) ||
    typeof Reflect.get(value, "expiresAt") !== "number"
  ) {
    return null;
  }
  const session = workerLinkSessionSchema.safeParse(
    Reflect.get(value, "session"),
  );
  if (!session.success) return null;
  const claim = value as WorkerLinkSessionClaim;
  if (
    claim.expiresAt !== Date.parse(session.data.lease.expiresAt) ||
    claim.expiresAt <= Date.now()
  ) {
    return null;
  }
  return { ...claim, session: session.data };
}

function parseMessage(value: unknown): RelayCoordinationMessage | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !validString(Reflect.get(value, "kind"), 100) ||
    !validString(Reflect.get(value, "messageId"), 200) ||
    !validString(Reflect.get(value, "sourceInstanceId"), 512) ||
    typeof Reflect.get(value, "createdAt") !== "number" ||
    typeof Reflect.get(value, "expiresAt") !== "number"
  ) {
    return null;
  }
  return value as RelayCoordinationMessage;
}

abstract class BaseRelayCoordinator implements RelayCoordinator {
  readonly #listeners = new Set<RelayCoordinationListener>();
  readonly #workerCache = new Map<string, WorkerPresenceClaim>();
  #receivedMessages = 0;
  #rejectedMessages = 0;
  #sentMessages = 0;

  constructor(
    readonly instanceId: string,
    readonly presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
    readonly shared = true,
    readonly maximumInstances = 1,
  ) {}

  protected instanceCount = 1;

  abstract claimWorker(
    input: Omit<WorkerPresenceClaim, "expiresAt" | "instanceId">,
  ): Promise<WorkerPresenceClaim | null>;
  abstract claimWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<WorkerLinkSessionClaim | null>;
  abstract close(): Promise<void>;
  abstract findWorker(workerId: string): Promise<WorkerPresenceClaim | null>;
  abstract findWorkerLinkSession(
    sessionId: string,
  ): Promise<WorkerLinkSessionClaim | null>;
  abstract health(): Promise<boolean>;
  abstract refreshWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean>;
  abstract refreshWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<boolean>;
  abstract releaseWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean>;
  abstract releaseWorkerLinkSession(
    sessionId: string,
    authorityInstanceId: string,
  ): Promise<boolean>;
  abstract start(): Promise<void>;
  protected abstract send(message: RelayCoordinationMessage): Promise<void>;

  cachedWorker(workerId: string): WorkerPresenceClaim | null {
    const presence = this.#workerCache.get(workerId);
    if (!presence) return null;
    if (presence.expiresAt <= Date.now()) {
      this.#workerCache.delete(workerId);
      return null;
    }
    return presence;
  }

  async publish(
    payload: RelayCoordinationPayload,
    ttlMs = DEFAULT_MESSAGE_TTL_MS,
  ): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60_000) {
      throw new Error(
        "Coordination message TTL is outside the supported range.",
      );
    }
    const now = Date.now();
    const message = {
      ...payload,
      createdAt: now,
      expiresAt: now + ttlMs,
      messageId: randomUUID(),
      sourceInstanceId: this.instanceId,
    } as RelayCoordinationMessage;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_COORDINATION_MESSAGE_BYTES) {
      throw new Error("Coordination message exceeds the relay size limit.");
    }
    this.#sentMessages += 1;
    await this.send(message);
  }

  stats(): RelayCoordinatorStats {
    for (const workerId of this.#workerCache.keys())
      this.cachedWorker(workerId);
    return {
      cachedWorkers: this.#workerCache.size,
      instanceCount: this.instanceCount,
      maximumInstances: this.maximumInstances,
      receivedMessages: this.#receivedMessages,
      rejectedMessages: this.#rejectedMessages,
      sentMessages: this.#sentMessages,
      shared: this.shared,
    };
  }

  subscribe(listener: RelayCoordinationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  protected cachePresence(presence: WorkerPresenceClaim): void {
    this.#workerCache.set(presence.workerId, presence);
  }

  protected removeCachedPresence(workerId: string, connectionId: string): void {
    const current = this.#workerCache.get(workerId);
    if (current?.connectionId === connectionId)
      this.#workerCache.delete(workerId);
  }

  protected async receive(raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message || message.expiresAt <= Date.now()) {
      this.#rejectedMessages += 1;
      return;
    }
    if (message.sourceInstanceId === this.instanceId) return;
    if (
      message.targetInstanceId &&
      message.targetInstanceId !== this.instanceId
    ) {
      return;
    }
    if (message.kind === "worker-presence") {
      const presence = parsePresence(message.presence);
      if (!presence) {
        this.#rejectedMessages += 1;
        return;
      }
      if (message.action === "online") this.cachePresence(presence);
      else this.removeCachedPresence(presence.workerId, presence.connectionId);
    }
    this.#receivedMessages += 1;
    for (const listener of this.#listeners) {
      try {
        await listener(message);
      } catch {
        this.#rejectedMessages += 1;
      }
    }
  }
}

export interface InMemoryRelayCoordinatorBackend {
  coordinators: Set<InMemoryRelayCoordinator>;
  workerLinkSessions: Map<string, WorkerLinkSessionClaim>;
  workers: Map<string, WorkerPresenceClaim>;
}

export function createInMemoryRelayCoordinatorBackend(): InMemoryRelayCoordinatorBackend {
  return {
    coordinators: new Set(),
    workerLinkSessions: new Map(),
    workers: new Map(),
  };
}

export class InMemoryRelayCoordinator extends BaseRelayCoordinator {
  #started = false;

  constructor(
    instanceId: string,
    readonly backend: InMemoryRelayCoordinatorBackend,
    presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
    maximumInstances = 100,
  ) {
    super(instanceId, presenceTtlMs, true, maximumInstances);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.backend.coordinators.add(this);
    this.#refreshInstanceCount();
  }

  async claimWorker(
    input: Omit<WorkerPresenceClaim, "expiresAt" | "instanceId">,
  ): Promise<WorkerPresenceClaim | null> {
    const previous = await this.findWorker(input.workerId);
    const presence: WorkerPresenceClaim = {
      ...input,
      expiresAt: Date.now() + this.presenceTtlMs,
      instanceId: this.instanceId,
    };
    this.backend.workers.set(input.workerId, presence);
    this.cachePresence(presence);
    await this.publish({ kind: "worker-presence", action: "online", presence });
    return previous;
  }

  async claimWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<WorkerLinkSessionClaim | null> {
    const parsed = parseWorkerLinkSessionClaim(claim);
    if (!parsed) throw new Error("WorkerLink session claim is invalid.");
    const previous = await this.findWorkerLinkSession(parsed.session.sessionId);
    if (previous?.authorityInstanceId !== undefined) return previous;
    this.backend.workerLinkSessions.set(parsed.session.sessionId, parsed);
    return previous;
  }

  async refreshWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean> {
    const current = await this.findWorker(workerId);
    if (
      !current ||
      current.connectionId !== connectionId ||
      current.instanceId !== this.instanceId
    ) {
      return false;
    }
    const presence = { ...current, expiresAt: Date.now() + this.presenceTtlMs };
    this.backend.workers.set(workerId, presence);
    this.cachePresence(presence);
    await this.publish({ kind: "worker-presence", action: "online", presence });
    return true;
  }

  async releaseWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean> {
    const current = await this.findWorker(workerId);
    if (
      !current ||
      current.connectionId !== connectionId ||
      current.instanceId !== this.instanceId
    ) {
      return false;
    }
    this.backend.workers.delete(workerId);
    this.removeCachedPresence(workerId, connectionId);
    await this.publish({
      kind: "worker-presence",
      action: "offline",
      presence: current,
    });
    return true;
  }

  async findWorker(workerId: string): Promise<WorkerPresenceClaim | null> {
    const presence = this.backend.workers.get(workerId) ?? null;
    if (presence && presence.expiresAt <= Date.now()) {
      this.backend.workers.delete(workerId);
      return null;
    }
    if (presence) this.cachePresence(presence);
    return presence;
  }

  async findWorkerLinkSession(
    sessionId: string,
  ): Promise<WorkerLinkSessionClaim | null> {
    const claim = this.backend.workerLinkSessions.get(sessionId) ?? null;
    if (claim && claim.expiresAt <= Date.now()) {
      this.backend.workerLinkSessions.delete(sessionId);
      return null;
    }
    return claim;
  }

  async refreshWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<boolean> {
    const parsed = parseWorkerLinkSessionClaim(claim);
    if (!parsed) return false;
    const current = await this.findWorkerLinkSession(parsed.session.sessionId);
    if (current?.authorityInstanceId !== parsed.authorityInstanceId) {
      return false;
    }
    this.backend.workerLinkSessions.set(parsed.session.sessionId, parsed);
    return true;
  }

  async releaseWorkerLinkSession(
    sessionId: string,
    authorityInstanceId: string,
  ): Promise<boolean> {
    const current = await this.findWorkerLinkSession(sessionId);
    if (current?.authorityInstanceId !== authorityInstanceId) return false;
    this.backend.workerLinkSessions.delete(sessionId);
    return true;
  }

  async health(): Promise<boolean> {
    this.#refreshInstanceCount();
    return this.#started && this.instanceCount <= this.maximumInstances;
  }

  async close(): Promise<void> {
    this.backend.coordinators.delete(this);
    this.#refreshInstanceCount();
    this.#started = false;
  }

  protected async send(message: RelayCoordinationMessage): Promise<void> {
    await Promise.all(
      [...this.backend.coordinators]
        .filter((coordinator) => coordinator !== this)
        .map((coordinator) => coordinator.receive(message)),
    );
  }

  #refreshInstanceCount(): void {
    for (const coordinator of this.backend.coordinators) {
      coordinator.instanceCount = this.backend.coordinators.size;
    }
  }
}

export interface RedisRelayCoordinatorOptions {
  instanceId: string;
  keyPrefix?: string;
  maximumInstances?: number;
  presenceTtlMs?: number;
  url: string;
}

export class RedisRelayCoordinator extends BaseRelayCoordinator {
  readonly #channel: string;
  readonly #client;
  readonly #keyPrefix: string;
  readonly #subscriber;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  constructor(options: RedisRelayCoordinatorOptions) {
    super(
      options.instanceId,
      options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
      true,
      options.maximumInstances ?? 1,
    );
    this.#keyPrefix = options.keyPrefix ?? "cantrip:relay:v1";
    this.#channel = `${this.#keyPrefix}:messages`;
    this.#client = createClient({ url: options.url });
    this.#subscriber = this.#client.duplicate();
    this.#client.on("error", () => {
      serverLogger.rateLimited(
        "coordination-redis-client-error",
        "error",
        "Redis relay coordination client reported an error",
        {
          event: "coordination.connection.error",
          subsystem: "relay-coordination",
          operation: "redis-client",
          reasonCode: "redis-client-error",
          status: "degraded",
        },
      );
    });
    this.#subscriber.on("error", () => {
      serverLogger.rateLimited(
        "coordination-redis-subscriber-error",
        "error",
        "Redis relay coordination subscriber reported an error",
        {
          event: "coordination.subscription.error",
          subsystem: "relay-coordination",
          operation: "redis-subscribe",
          reasonCode: "redis-subscriber-error",
          status: "degraded",
        },
      );
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const startedAtMs = Date.now();
    serverLogger.event("info", "Redis relay coordination startup began", {
      event: "coordination.lifecycle.started",
      subsystem: "relay-coordination",
      operation: "start",
      status: "starting",
    });
    await this.#client.connect();
    try {
      await this.#subscriber.connect();
      await this.#subscriber.subscribe(this.#channel, (raw) => {
        if (Buffer.byteLength(raw) > MAX_COORDINATION_MESSAGE_BYTES) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        void this.receive(parsed);
      });
      for await (const batch of this.#client.scanIterator({
        MATCH: `${this.#keyPrefix}:worker:*`,
        COUNT: 200,
      })) {
        for (const key of Array.isArray(batch) ? batch : [batch]) {
          const raw = await this.#client.get(key);
          if (!raw) continue;
          try {
            const presence = parsePresence(JSON.parse(raw));
            if (presence && presence.expiresAt > Date.now()) {
              this.cachePresence(presence);
            }
          } catch {
            // Ignore malformed or obsolete coordination keys.
          }
        }
      }
      await this.#refreshInstance();
      await this.#refreshInstanceCount();
      this.#heartbeatTimer = setInterval(
        () => void this.#refreshInstance().catch(() => undefined),
        Math.max(1_000, Math.floor(this.presenceTtlMs / 3)),
      );
      this.#heartbeatTimer.unref();
      this.#started = true;
      serverLogger.event("info", "Redis relay coordination is ready", {
        event: "coordination.lifecycle.completed",
        subsystem: "relay-coordination",
        operation: "start",
        status: "ready",
        durationMs: Date.now() - startedAtMs,
        counts: {
          instances: this.instanceCount,
          workers: this.stats().cachedWorkers,
        },
      });
    } catch (error) {
      if (this.#subscriber.isOpen) await this.#subscriber.disconnect();
      if (this.#client.isOpen) await this.#client.disconnect();
      serverLogger.event("error", "Redis relay coordination failed to start", {
        event: "coordination.lifecycle.failed",
        subsystem: "relay-coordination",
        operation: "start",
        status: "failed",
        reasonCode: "redis-startup-failed",
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  async claimWorker(
    input: Omit<WorkerPresenceClaim, "expiresAt" | "instanceId">,
  ): Promise<WorkerPresenceClaim | null> {
    const previous = await this.findWorker(input.workerId);
    const presence: WorkerPresenceClaim = {
      ...input,
      expiresAt: Date.now() + this.presenceTtlMs,
      instanceId: this.instanceId,
    };
    await this.#client.set(
      this.#workerKey(input.workerId),
      JSON.stringify(presence),
      {
        PX: this.presenceTtlMs,
      },
    );
    this.cachePresence(presence);
    await this.publish({ kind: "worker-presence", action: "online", presence });
    serverLogger.event("info", "Worker relay ownership claimed", {
      event: "coordination.worker.claimed",
      subsystem: "relay-coordination",
      operation: "claim-worker",
      status: "claimed",
      workerId: input.workerId,
      replacedInstance: previous?.instanceId !== undefined,
    });
    return previous;
  }

  async claimWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<WorkerLinkSessionClaim | null> {
    const parsed = parseWorkerLinkSessionClaim(claim);
    if (!parsed) throw new Error("WorkerLink session claim is invalid.");
    const previous = await this.findWorkerLinkSession(parsed.session.sessionId);
    if (previous?.authorityInstanceId !== undefined) return previous;
    const claimed = await this.#client.set(
      this.#workerLinkSessionKey(parsed.session.sessionId),
      JSON.stringify(parsed),
      { NX: true, PX: Math.max(1, parsed.expiresAt - Date.now()) },
    );
    return claimed === "OK"
      ? null
      : this.findWorkerLinkSession(parsed.session.sessionId);
  }

  async refreshWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean> {
    const key = this.#workerKey(workerId);
    const current = await this.#client.get(key);
    if (!current) return false;
    let presence: WorkerPresenceClaim | null = null;
    try {
      presence = parsePresence(JSON.parse(current));
    } catch {
      return false;
    }
    if (
      !presence ||
      presence.connectionId !== connectionId ||
      presence.instanceId !== this.instanceId
    ) {
      return false;
    }
    const refreshed = {
      ...presence,
      expiresAt: Date.now() + this.presenceTtlMs,
    };
    const result = await this.#client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end",
      {
        keys: [key],
        arguments: [
          current,
          JSON.stringify(refreshed),
          String(this.presenceTtlMs),
        ],
      },
    );
    if (Number(result) !== 1) return false;
    this.cachePresence(refreshed);
    await this.publish({
      kind: "worker-presence",
      action: "online",
      presence: refreshed,
    });
    serverLogger.event("info", "Worker relay ownership released", {
      event: "coordination.worker.released",
      subsystem: "relay-coordination",
      operation: "release-worker",
      status: "released",
      workerId,
    });
    return true;
  }

  async releaseWorker(
    workerId: string,
    connectionId: string,
  ): Promise<boolean> {
    const key = this.#workerKey(workerId);
    const current = await this.#client.get(key);
    if (!current) return false;
    let presence: WorkerPresenceClaim | null = null;
    try {
      presence = parsePresence(JSON.parse(current));
    } catch {
      return false;
    }
    if (
      !presence ||
      presence.connectionId !== connectionId ||
      presence.instanceId !== this.instanceId
    ) {
      return false;
    }
    const result = await this.#client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [current] },
    );
    if (Number(result) !== 1) return false;
    this.removeCachedPresence(workerId, connectionId);
    await this.publish({
      kind: "worker-presence",
      action: "offline",
      presence,
    });
    return true;
  }

  async findWorker(workerId: string): Promise<WorkerPresenceClaim | null> {
    const cached = this.cachedWorker(workerId);
    if (cached) return cached;
    const raw = await this.#client.get(this.#workerKey(workerId));
    if (!raw) return null;
    let presence: WorkerPresenceClaim | null = null;
    try {
      presence = parsePresence(JSON.parse(raw));
    } catch {
      return null;
    }
    if (!presence || presence.expiresAt <= Date.now()) return null;
    this.cachePresence(presence);
    return presence;
  }

  async findWorkerLinkSession(
    sessionId: string,
  ): Promise<WorkerLinkSessionClaim | null> {
    const raw = await this.#client.get(this.#workerLinkSessionKey(sessionId));
    if (!raw) return null;
    try {
      return parseWorkerLinkSessionClaim(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async refreshWorkerLinkSession(
    claim: WorkerLinkSessionClaim,
  ): Promise<boolean> {
    const parsed = parseWorkerLinkSessionClaim(claim);
    if (!parsed) return false;
    const key = this.#workerLinkSessionKey(parsed.session.sessionId);
    const currentRaw = await this.#client.get(key);
    if (!currentRaw) return false;
    let current: WorkerLinkSessionClaim | null = null;
    try {
      current = parseWorkerLinkSessionClaim(JSON.parse(currentRaw));
    } catch {
      return false;
    }
    if (current?.authorityInstanceId !== parsed.authorityInstanceId) {
      return false;
    }
    const result = await this.#client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end",
      {
        keys: [key],
        arguments: [
          currentRaw,
          JSON.stringify(parsed),
          String(Math.max(1, parsed.expiresAt - Date.now())),
        ],
      },
    );
    return Number(result) === 1;
  }

  async releaseWorkerLinkSession(
    sessionId: string,
    authorityInstanceId: string,
  ): Promise<boolean> {
    const key = this.#workerLinkSessionKey(sessionId);
    const currentRaw = await this.#client.get(key);
    if (!currentRaw) return false;
    let current: WorkerLinkSessionClaim | null = null;
    try {
      current = parseWorkerLinkSessionClaim(JSON.parse(currentRaw));
    } catch {
      return false;
    }
    if (current?.authorityInstanceId !== authorityInstanceId) return false;
    const result = await this.#client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [currentRaw] },
    );
    return Number(result) === 1;
  }

  async health(): Promise<boolean> {
    if (!this.#client.isReady) {
      serverLogger.rateLimited(
        "coordination-health-not-ready",
        "warn",
        "Redis relay coordination is not ready",
        {
          event: "coordination.health.failed",
          subsystem: "relay-coordination",
          operation: "health",
          reasonCode: "redis-not-ready",
          status: "unhealthy",
        },
      );
      return false;
    }
    if ((await this.#client.ping()) !== "PONG") return false;
    await this.#refreshInstanceCount();
    const healthy = this.instanceCount <= this.maximumInstances;
    if (!healthy) {
      serverLogger.rateLimited(
        "coordination-health-instance-limit",
        "error",
        "Relay coordination instance limit exceeded",
        {
          event: "coordination.health.failed",
          subsystem: "relay-coordination",
          operation: "health",
          reasonCode: "instance-limit-exceeded",
          status: "unhealthy",
          counts: {
            instances: this.instanceCount,
            maximumInstances: this.maximumInstances,
          },
        },
      );
    }
    return healthy;
  }

  async close(): Promise<void> {
    const startedAtMs = Date.now();
    serverLogger.event("info", "Redis relay coordination shutdown began", {
      event: "coordination.shutdown.started",
      subsystem: "relay-coordination",
      operation: "close",
      status: "stopping",
    });
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    if (this.#client.isReady) await this.#client.del(this.#instanceKey());
    if (this.#subscriber.isOpen) await this.#subscriber.quit();
    if (this.#client.isOpen) await this.#client.quit();
    this.#started = false;
    serverLogger.event("info", "Redis relay coordination stopped", {
      event: "coordination.shutdown.completed",
      subsystem: "relay-coordination",
      operation: "close",
      status: "stopped",
      durationMs: Date.now() - startedAtMs,
    });
  }

  protected async send(message: RelayCoordinationMessage): Promise<void> {
    if (!this.#client.isReady)
      throw new Error("Redis coordination is unavailable.");
    await this.#client.publish(this.#channel, JSON.stringify(message));
  }

  async #refreshInstance(): Promise<void> {
    await this.#client.set(this.#instanceKey(), String(Date.now()), {
      PX: this.presenceTtlMs,
    });
  }

  async #refreshInstanceCount(): Promise<void> {
    let count = 0;
    for await (const batch of this.#client.scanIterator({
      MATCH: `${this.#keyPrefix}:instance:*`,
      COUNT: 100,
    })) {
      count += Array.isArray(batch) ? batch.length : 1;
    }
    this.instanceCount = count;
  }

  #instanceKey(): string {
    return `${this.#keyPrefix}:instance:${encodeURIComponent(this.instanceId)}`;
  }

  #workerKey(workerId: string): string {
    return `${this.#keyPrefix}:worker:${encodeURIComponent(workerId)}`;
  }

  #workerLinkSessionKey(sessionId: string): string {
    return `${this.#keyPrefix}:worker-link:${encodeURIComponent(sessionId)}`;
  }
}
