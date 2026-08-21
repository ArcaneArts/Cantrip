import type {
  ServiceLogLevel,
  ServiceLogRecord,
  WorkerCommand,
  WorkerNotification,
} from "@cantrip/protocol";

const MAX_STREAMS = 32;
const MAX_BATCH_RECORDS = 200;
const MAX_PENDING_BYTES = 256 * 1_024;
const BATCH_DELAY_MS = 75;
const RETRY_DELAY_MS = 1_000;

const LEVEL_WEIGHT: Record<ServiceLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

type StartCommand = Extract<
  WorkerCommand,
  { type: "diagnostics.logs.stream.start" }
>;

interface StreamState {
  expiresAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  leaseTimer: ReturnType<typeof setTimeout>;
  latestCursor: number;
  minimumLevel: ServiceLogLevel;
  pending: Map<number, { bytes: number; record: ServiceLogRecord }>;
  pendingBytes: number;
  subscriptionId: string;
  truncated: boolean;
}

export interface WorkerLogStreamDependencies {
  emit(notification: WorkerNotification): boolean;
  read(input: {
    afterCursor: number;
    limit: number;
    minimumLevel: ServiceLogLevel;
  }): {
    records: ServiceLogRecord[];
    nextCursor: number;
    oldestCursor: number | null;
    latestCursor: number;
    truncated: boolean;
  };
  subscribe(listener: (record: ServiceLogRecord) => void): () => void;
}

export class WorkerLogStreamManager {
  readonly #dependencies: WorkerLogStreamDependencies;
  readonly #streams = new Map<string, StreamState>();
  readonly #unsubscribe: () => void;

  constructor(dependencies: WorkerLogStreamDependencies) {
    this.#dependencies = dependencies;
    this.#unsubscribe = dependencies.subscribe((record) =>
      this.#observe(record),
    );
  }

  start(command: StartCommand): { accepted: true; latestCursor: number } {
    if (
      !this.#streams.has(command.subscriptionId) &&
      this.#streams.size >= MAX_STREAMS
    ) {
      throw new Error("The worker log stream limit has been reached.");
    }
    this.stop(command.subscriptionId);
    const initial = this.#dependencies.read({
      afterCursor: command.afterCursor,
      limit: 500,
      minimumLevel: command.minimumLevel,
    });
    const leaseTimer = setTimeout(
      () => this.stop(command.subscriptionId),
      command.leaseMs,
    );
    leaseTimer.unref();
    const stream: StreamState = {
      expiresAt: Date.now() + command.leaseMs,
      flushTimer: null,
      leaseTimer,
      latestCursor: initial.nextCursor,
      minimumLevel: command.minimumLevel,
      pending: new Map(),
      pendingBytes: 0,
      subscriptionId: command.subscriptionId,
      truncated: initial.truncated,
    };
    this.#streams.set(command.subscriptionId, stream);
    for (const record of initial.records) this.#append(stream, record);
    if (
      initial.records.length > 0 ||
      initial.truncated ||
      initial.nextCursor > command.afterCursor
    ) {
      this.#schedule(stream, 0);
    }
    return { accepted: true, latestCursor: initial.latestCursor };
  }

  renew(subscriptionId: string, leaseMs: number): { accepted: boolean } {
    const stream = this.#streams.get(subscriptionId);
    if (!stream) return { accepted: false };
    clearTimeout(stream.leaseTimer);
    stream.expiresAt = Date.now() + leaseMs;
    stream.leaseTimer = setTimeout(() => this.stop(subscriptionId), leaseMs);
    stream.leaseTimer.unref();
    return { accepted: true };
  }

  stop(subscriptionId: string): { stopped: boolean } {
    const stream = this.#streams.get(subscriptionId);
    if (!stream) return { stopped: false };
    if (stream.flushTimer) clearTimeout(stream.flushTimer);
    clearTimeout(stream.leaseTimer);
    this.#streams.delete(subscriptionId);
    return { stopped: true };
  }

  close(): void {
    this.#unsubscribe();
    for (const subscriptionId of [...this.#streams.keys()]) {
      this.stop(subscriptionId);
    }
  }

  #observe(record: ServiceLogRecord): void {
    for (const stream of this.#streams.values()) {
      if (Date.now() >= stream.expiresAt) {
        this.stop(stream.subscriptionId);
        continue;
      }
      stream.latestCursor = Math.max(stream.latestCursor, record.cursor);
      if (LEVEL_WEIGHT[record.level] >= LEVEL_WEIGHT[stream.minimumLevel]) {
        this.#append(stream, record);
      }
      this.#schedule(stream, BATCH_DELAY_MS);
    }
  }

  #append(stream: StreamState, record: ServiceLogRecord): void {
    if (stream.pending.has(record.cursor)) return;
    const bytes = Buffer.byteLength(JSON.stringify(record));
    stream.pending.set(record.cursor, { bytes, record });
    stream.pendingBytes += bytes;
    while (
      stream.pending.size > MAX_BATCH_RECORDS ||
      stream.pendingBytes > MAX_PENDING_BYTES
    ) {
      const oldestCursor = stream.pending.keys().next().value;
      if (oldestCursor === undefined) break;
      const removed = stream.pending.get(oldestCursor);
      stream.pending.delete(oldestCursor);
      stream.pendingBytes -= removed?.bytes ?? 0;
      stream.truncated = true;
    }
  }

  #schedule(stream: StreamState, delayMs: number): void {
    if (stream.flushTimer) return;
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = null;
      this.#flush(stream);
    }, delayMs);
    stream.flushTimer.unref();
  }

  #flush(stream: StreamState): void {
    if (this.#streams.get(stream.subscriptionId) !== stream) return;
    if (Date.now() >= stream.expiresAt) {
      this.stop(stream.subscriptionId);
      return;
    }
    const snapshot = this.#dependencies.read({
      afterCursor: stream.latestCursor,
      limit: 1,
      minimumLevel: stream.minimumLevel,
    });
    const records = [...stream.pending.values()]
      .map(({ record }) => record)
      .sort((left, right) => left.cursor - right.cursor);
    const delivered = this.#dependencies.emit({
      type: "diagnostics.logs.observed",
      subscriptionId: stream.subscriptionId,
      records,
      nextCursor: stream.latestCursor,
      oldestCursor: snapshot.oldestCursor,
      latestCursor: snapshot.latestCursor,
      truncated: stream.truncated || snapshot.truncated,
    });
    if (!delivered) {
      this.#schedule(stream, RETRY_DELAY_MS);
      return;
    }
    stream.pending.clear();
    stream.pendingBytes = 0;
    stream.truncated = false;
  }
}
