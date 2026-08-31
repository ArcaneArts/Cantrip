import { randomUUID } from "node:crypto";

import type { ServiceLogger } from "@cantrip/logging";
import type {
  AccountBandwidthChannel,
  AccountBandwidthDirection,
} from "@cantrip/protocol/resource-usage";

import type {
  AccountBandwidthFlushBatch,
  AccountBandwidthFlushEntry,
  AccountBandwidthFlushResult,
} from "../db/account-resource-usage.js";

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_FLUSH_THRESHOLD_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_ENTRIES = 4_096;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const BANDWIDTH_CHANNELS = new Set<AccountBandwidthChannel>([
  "http",
  "client-live-websocket",
  "worker-control-websocket",
  "worker-log-stream",
  "terminal-relay",
  "remote-surface-relay",
  "tunnel-relay",
  "attachment-transfer",
  "code-relay",
  "project-share-relay",
  "other",
]);
const BANDWIDTH_DIRECTIONS = new Set<AccountBandwidthDirection>([
  "ingress",
  "egress",
]);

export interface AccountUsageMeasurement {
  bytes: bigint | number;
  channel: AccountBandwidthChannel;
  direction: AccountBandwidthDirection;
  operationCount?: bigint | number;
  ownerId: string;
  /** False for usage-observer traffic that must not trigger another refresh. */
  notifyChange?: boolean;
}

export interface AccountUsageRecorder {
  record(measurement: AccountUsageMeasurement): boolean;
}

export interface AccountBandwidthFlushSink {
  flushBandwidthBatch(
    batch: AccountBandwidthFlushBatch,
  ): Promise<AccountBandwidthFlushResult>;
}

export interface AccountUsageMeterOptions {
  flushIntervalMs?: number;
  flushThresholdBytes?: number;
  maxBufferedEntries?: number;
  meterId?: string;
  now?: () => Date;
  onFlushed?(ownerIds: string[]): void;
  onMeasurement?(measurement: AccountUsageMeasurement): void;
}

export interface AccountUsageMeterStats {
  bufferedBytes: bigint;
  bufferedEntries: number;
  droppedBytes: bigint;
  droppedMeasurements: bigint;
  flushCount: number;
  flushFailureCount: number;
  lastFlushDurationMs: number | null;
  lastFlushedAt: string | null;
  pendingSequence: bigint | null;
}

interface BufferedEntry extends AccountBandwidthFlushEntry {
  key: string;
  notifyMeasurements: bigint;
}

interface PendingFlush {
  batch: AccountBandwidthFlushBatch;
  entries: BufferedEntry[];
}

function nonnegativeBigint(
  value: bigint | number | undefined,
  fallback: bigint,
): bigint | null {
  if (value === undefined) return fallback;
  if (typeof value === "bigint") {
    return value >= 0n && value <= MAX_POSTGRES_BIGINT ? value : null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function utcHour(date: Date): Date {
  const value = date.getTime();
  return new Date(Math.floor(value / 3_600_000) * 3_600_000);
}

function entryKey(
  ownerId: string,
  bucketStart: Date,
  channel: AccountBandwidthChannel,
  direction: AccountBandwidthDirection,
): string {
  return `${ownerId}\u0000${bucketStart.toISOString()}\u0000${channel}\u0000${direction}`;
}

/**
 * Bounded, retry-safe application payload meter. Recording is synchronous and
 * never performs database I/O; durable additive writes happen in batches.
 */
export class AccountUsageMeter implements AccountUsageRecorder {
  readonly #buffer = new Map<string, BufferedEntry>();
  readonly #flushIntervalMs: number;
  readonly #flushThresholdBytes: bigint;
  readonly #maxBufferedEntries: number;
  readonly #meterId: string;
  readonly #now: () => Date;
  readonly #onFlushed?: AccountUsageMeterOptions["onFlushed"];
  readonly #onMeasurement?: AccountUsageMeterOptions["onMeasurement"];
  readonly #timer: ReturnType<typeof setInterval>;
  #bufferedBytes = 0n;
  #closed = false;
  #droppedBytes = 0n;
  #droppedMeasurements = 0n;
  #flushCount = 0;
  #flushFailureCount = 0;
  #flushPromise: Promise<boolean> | null = null;
  #flushScheduled = false;
  #lastFlushDurationMs: number | null = null;
  #lastFlushedAt: string | null = null;
  #pending: PendingFlush | null = null;
  #sequence = 0n;

  constructor(
    private readonly sink: AccountBandwidthFlushSink,
    private readonly logger: ServiceLogger,
    options: AccountUsageMeterOptions = {},
  ) {
    this.#flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#flushThresholdBytes = BigInt(
      options.flushThresholdBytes ?? DEFAULT_FLUSH_THRESHOLD_BYTES,
    );
    this.#maxBufferedEntries =
      options.maxBufferedEntries ?? DEFAULT_MAX_BUFFERED_ENTRIES;
    this.#meterId = options.meterId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#onFlushed = options.onFlushed;
    this.#onMeasurement = options.onMeasurement;
    if (
      !Number.isSafeInteger(this.#flushIntervalMs) ||
      this.#flushIntervalMs < 1 ||
      this.#flushThresholdBytes < 1n ||
      !Number.isSafeInteger(this.#maxBufferedEntries) ||
      this.#maxBufferedEntries < 1 ||
      !this.#meterId.trim()
    ) {
      throw new Error("Account usage meter options are invalid.");
    }
    this.#timer = setInterval(() => void this.flush(), this.#flushIntervalMs);
    this.#timer.unref();
  }

  record(measurement: AccountUsageMeasurement): boolean {
    if (this.#closed) return false;
    const ownerId = measurement.ownerId.trim();
    const bytes = nonnegativeBigint(measurement.bytes, 0n);
    const operationCount = nonnegativeBigint(measurement.operationCount, 1n);
    const now = this.#now();
    if (
      !ownerId ||
      ownerId.length > 200 ||
      bytes === null ||
      operationCount === null ||
      !BANDWIDTH_CHANNELS.has(measurement.channel) ||
      !BANDWIDTH_DIRECTIONS.has(measurement.direction) ||
      !Number.isFinite(now.getTime())
    ) {
      return false;
    }
    if (bytes === 0n && operationCount === 0n) return true;

    try {
      this.#onMeasurement?.({
        ownerId,
        bytes,
        operationCount,
        channel: measurement.channel,
        direction: measurement.direction,
        notifyChange: measurement.notifyChange,
      });
    } catch {
      this.logger.rateLimited(
        "account-usage-meter-observer-failed",
        "warn",
        "Account bandwidth observer rejected a measurement",
        {
          event: "account-usage.observer.failed",
          subsystem: "account-usage",
          operation: "observe-bandwidth",
          reasonCode: "observer-failed",
          status: "degraded",
        },
      );
    }

    const bucketStart = utcHour(now);
    const key = entryKey(
      ownerId,
      bucketStart,
      measurement.channel,
      measurement.direction,
    );
    const current = this.#buffer.get(key);
    if (!current && this.#buffer.size >= this.#maxBufferedEntries) {
      this.#droppedBytes += bytes;
      this.#droppedMeasurements += 1n;
      this.logger.rateLimited(
        "account-usage-meter-buffer-full",
        "error",
        "Account usage meter dropped a measurement",
        {
          event: "account-usage.meter.dropped",
          subsystem: "account-usage",
          operation: "record-bandwidth",
          reasonCode: "buffer-capacity-reached",
          status: "degraded",
          bufferedEntries: this.#buffer.size,
        },
      );
      return false;
    }
    if (current) {
      if (
        current.bytes + bytes > MAX_POSTGRES_BIGINT ||
        current.operationCount + operationCount > MAX_POSTGRES_BIGINT
      ) {
        this.#droppedBytes += bytes;
        this.#droppedMeasurements += 1n;
        return false;
      }
      current.bytes += bytes;
      current.operationCount += operationCount;
      if (measurement.notifyChange !== false) current.notifyMeasurements += 1n;
    } else {
      this.#buffer.set(key, {
        key,
        ownerId,
        bucketStart,
        channel: measurement.channel,
        direction: measurement.direction,
        bytes,
        operationCount,
        notifyMeasurements: measurement.notifyChange === false ? 0n : 1n,
      });
    }
    this.#bufferedBytes += bytes;
    if (this.#bufferedBytes >= this.#flushThresholdBytes) {
      this.#scheduleFlush();
    }
    return true;
  }

  flush(): Promise<boolean> {
    if (this.#flushPromise) return this.#flushPromise;
    if (!this.#pending && this.#buffer.size === 0) return Promise.resolve(true);
    this.#flushPromise = this.#flush().finally(() => {
      this.#flushPromise = null;
      if (!this.#closed && this.#bufferedBytes >= this.#flushThresholdBytes) {
        this.#scheduleFlush();
      }
    });
    return this.#flushPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    if (!(await this.flush()) && this.#pending) await this.flush();
  }

  stats(): AccountUsageMeterStats {
    return {
      bufferedBytes: this.#bufferedBytes,
      bufferedEntries: this.#buffer.size,
      droppedBytes: this.#droppedBytes,
      droppedMeasurements: this.#droppedMeasurements,
      flushCount: this.#flushCount,
      flushFailureCount: this.#flushFailureCount,
      lastFlushDurationMs: this.#lastFlushDurationMs,
      lastFlushedAt: this.#lastFlushedAt,
      pendingSequence: this.#pending?.batch.sequence ?? null,
    };
  }

  async #flush(): Promise<boolean> {
    if (!this.#pending) {
      this.#sequence += 1n;
      const flushedAt = this.#now();
      const entries = [...this.#buffer.values()].map((entry) => ({ ...entry }));
      this.#pending = {
        entries,
        batch: {
          meterId: this.#meterId,
          sequence: this.#sequence,
          flushedAt,
          entries: entries.map(
            ({
              key: _key,
              notifyMeasurements: _notifyMeasurements,
              ...entry
            }) => entry,
          ),
        },
      };
    }
    const pending = this.#pending;
    const startedAt = Date.now();
    try {
      const result = await this.sink.flushBandwidthBatch(pending.batch);
      for (const flushed of pending.entries) {
        const current = this.#buffer.get(flushed.key);
        if (!current) continue;
        current.bytes -= flushed.bytes;
        current.operationCount -= flushed.operationCount;
        current.notifyMeasurements -= flushed.notifyMeasurements;
        this.#bufferedBytes -= flushed.bytes;
        if (
          current.bytes === 0n &&
          current.operationCount === 0n &&
          current.notifyMeasurements === 0n
        ) {
          this.#buffer.delete(flushed.key);
        }
      }
      this.#pending = null;
      this.#flushCount += 1;
      this.#lastFlushDurationMs = Date.now() - startedAt;
      this.#lastFlushedAt = this.#now().toISOString();
      const notifyingOwnerIds = new Set(
        pending.entries
          .filter((entry) => entry.notifyMeasurements > 0n)
          .map((entry) => entry.ownerId),
      );
      const changedOwnerIds = result.ownerIds.filter((ownerId) =>
        notifyingOwnerIds.has(ownerId),
      );
      if (changedOwnerIds.length > 0 && this.#onFlushed) {
        try {
          this.#onFlushed(changedOwnerIds);
        } catch (error) {
          this.logger.event("warn", "Usage live invalidation callback failed", {
            event: "account-usage.live-invalidation.failed",
            subsystem: "account-usage",
            operation: "publish-usage-change",
            reasonCode: "callback-failed",
            status: "degraded",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      this.logger.event("debug", "Account bandwidth usage flushed", {
        event: "account-usage.bandwidth-flush.completed",
        subsystem: "account-usage",
        operation: "flush-bandwidth",
        status: result.applied ? "completed" : "idempotent-replay",
        durationMs: this.#lastFlushDurationMs,
        counts: {
          entries: pending.entries.length,
          owners: result.ownerIds.length,
        },
      });
      return true;
    } catch (error) {
      this.#flushFailureCount += 1;
      this.#lastFlushDurationMs = Date.now() - startedAt;
      this.logger.rateLimited(
        "account-usage-bandwidth-flush-failed",
        "error",
        "Account bandwidth usage flush failed",
        {
          event: "account-usage.bandwidth-flush.failed",
          subsystem: "account-usage",
          operation: "flush-bandwidth",
          reasonCode: "database-write-failed",
          status: "retrying",
          durationMs: this.#lastFlushDurationMs,
          error,
        },
      );
      return false;
    }
  }

  #scheduleFlush(): void {
    if (this.#closed || this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      void this.flush();
    });
  }
}
