import { randomUUID } from "node:crypto";

import {
  ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES,
  ACCOUNT_LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS,
  ACCOUNT_LIVE_TRAFFIC_WINDOW_SECONDS,
  type AccountLiveTraffic,
  type AccountLiveTrafficSample,
} from "@cantrip/protocol/resource-usage";

import type {
  AccountUsageMeasurement,
  AccountUsageRecorder,
} from "./bandwidth-meter.js";

export const ACCOUNT_LIVE_TRAFFIC_ROUTE = "/api/account/live-traffic";
export const LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS =
  ACCOUNT_LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS;
export const LIVE_TRAFFIC_WINDOW_SECONDS = ACCOUNT_LIVE_TRAFFIC_WINDOW_SECONDS;
const SAMPLE_INTERVAL_MS = LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS * 1_000;

const DEFAULT_MAX_OWNERS = 2_048;
const DEFAULT_OWNER_RETENTION_SECONDS = 600;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const WEBSOCKET_CHANNELS = new Set<AccountUsageMeasurement["channel"]>([
  "client-live-websocket",
  "worker-control-websocket",
]);

interface TrafficBucket {
  downloadBytes: number;
  httpRequests: number;
  revision: number;
  uploadBytes: number;
  websocketDownload: number;
  websocketUpload: number;
}

interface OwnerTraffic {
  buckets: Map<number, TrafficBucket>;
  lastAccessSecond: number;
  lastPrunedSampleIndex: number;
  revision: number;
}

export interface LiveTrafficMeterOptions {
  epoch?: string;
  instanceId: string;
  maxOwners?: number;
  now?: () => number;
  ownerRetentionSeconds?: number;
}

export interface LiveTrafficSnapshotQuery {
  after?: string;
  epoch?: string;
}

function emptyBucket(): TrafficBucket {
  return {
    downloadBytes: 0,
    httpRequests: 0,
    revision: 0,
    uploadBytes: 0,
    websocketDownload: 0,
    websocketUpload: 0,
  };
}

function safeCounter(
  value: bigint | number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "bigint") {
    if (value <= 0n) return value === 0n ? 0 : -1;
    return value > BigInt(MAX_COUNTER) ? MAX_COUNTER : Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) return -1;
  return value;
}

function addCounter(current: number, increment: number): number {
  return Math.min(MAX_COUNTER, current + increment);
}

function cursorValue(sampleIndex: number, revision: number): string {
  return `${sampleIndex}:${revision}`;
}

function parseCursor(
  cursor: string,
): { revision: number; sampleIndex: number } | null {
  const match = /^(\d+):(\d+)$/u.exec(cursor);
  if (!match) return null;
  const sampleIndex = Number(match[1]);
  const revision = Number(match[2]);
  return Number.isSafeInteger(sampleIndex) &&
    Number.isSafeInteger(revision) &&
    sampleIndex >= 0 &&
    revision >= 0
    ? { revision, sampleIndex }
    : null;
}

export function isAccountLiveTrafficRoute(route: string): boolean {
  return route === ACCOUNT_LIVE_TRAFFIC_ROUTE;
}

/**
 * Bounded, process-local quarter-second traffic history. The meter observes only
 * application payload measurements that already cross a Cantrip server
 * boundary; direct client-to-worker traffic is intentionally absent.
 */
export class LiveTrafficMeter implements AccountUsageRecorder {
  readonly epoch: string;
  readonly instanceId: string;
  readonly #maxOwners: number;
  readonly #now: () => number;
  readonly #owners = new Map<string, OwnerTraffic>();
  readonly #ownerRetentionSeconds: number;
  #lastEvictionSecond = -1;

  constructor(options: LiveTrafficMeterOptions) {
    this.epoch = options.epoch ?? randomUUID();
    this.instanceId = options.instanceId.trim();
    this.#maxOwners = options.maxOwners ?? DEFAULT_MAX_OWNERS;
    this.#now = options.now ?? Date.now;
    this.#ownerRetentionSeconds =
      options.ownerRetentionSeconds ?? DEFAULT_OWNER_RETENTION_SECONDS;
    if (
      !this.instanceId ||
      this.instanceId.length > 100 ||
      !Number.isSafeInteger(this.#maxOwners) ||
      this.#maxOwners < 1 ||
      !Number.isSafeInteger(this.#ownerRetentionSeconds) ||
      this.#ownerRetentionSeconds < LIVE_TRAFFIC_WINDOW_SECONDS
    ) {
      throw new Error("Live traffic meter options are invalid.");
    }
  }

  record(measurement: AccountUsageMeasurement): boolean {
    const ownerId = measurement.ownerId.trim();
    const bytes = safeCounter(measurement.bytes, 0);
    const operations = safeCounter(measurement.operationCount, 1);
    if (
      !ownerId ||
      ownerId.length > 200 ||
      bytes < 0 ||
      operations < 0 ||
      (measurement.direction !== "ingress" &&
        measurement.direction !== "egress")
    ) {
      return false;
    }
    if (bytes === 0 && operations === 0) return true;
    const sampleIndex = this.#currentSampleIndex();
    const owner = this.#owner(ownerId, sampleIndex);
    const bucket = this.#bucket(owner, sampleIndex);
    owner.revision = addCounter(owner.revision, 1);
    bucket.revision = owner.revision;
    if (measurement.direction === "ingress") {
      bucket.uploadBytes = addCounter(bucket.uploadBytes, bytes);
      if (WEBSOCKET_CHANNELS.has(measurement.channel)) {
        bucket.websocketUpload = addCounter(bucket.websocketUpload, operations);
      }
    } else if (measurement.direction === "egress") {
      bucket.downloadBytes = addCounter(bucket.downloadBytes, bytes);
      if (WEBSOCKET_CHANNELS.has(measurement.channel)) {
        bucket.websocketDownload = addCounter(
          bucket.websocketDownload,
          operations,
        );
      }
    }
    return true;
  }

  recordHttpRequest(ownerId: string, route: string): boolean {
    const normalizedOwnerId = ownerId.trim();
    if (
      !normalizedOwnerId ||
      normalizedOwnerId.length > 200 ||
      isAccountLiveTrafficRoute(route)
    ) {
      return false;
    }
    const sampleIndex = this.#currentSampleIndex();
    const owner = this.#owner(normalizedOwnerId, sampleIndex);
    const bucket = this.#bucket(owner, sampleIndex);
    owner.revision = addCounter(owner.revision, 1);
    bucket.revision = owner.revision;
    bucket.httpRequests = addCounter(bucket.httpRequests, 1);
    return true;
  }

  snapshot(
    ownerId: string,
    query: LiveTrafficSnapshotQuery = {},
  ): AccountLiveTraffic {
    const now = this.#nowMilliseconds();
    const sampleIndex = Math.floor(now / SAMPLE_INTERVAL_MS);
    const owner = this.#owner(ownerId.trim(), sampleIndex);
    const windowStart = sampleIndex - ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES + 1;
    const requestedCursor = query.after ? parseCursor(query.after) : null;
    let reset = Boolean(query.epoch && query.epoch !== this.epoch);
    if (
      query.after &&
      (!requestedCursor ||
        requestedCursor.sampleIndex < windowStart - 1 ||
        requestedCursor.sampleIndex > sampleIndex ||
        requestedCursor.revision > owner.revision)
    ) {
      reset = true;
    }
    const incremental = Boolean(
      query.after && query.epoch === this.epoch && requestedCursor && !reset,
    );
    const startSampleIndex = incremental
      ? Math.max(windowStart, requestedCursor!.sampleIndex)
      : windowStart;
    const samples: AccountLiveTrafficSample[] = [];
    for (let index = startSampleIndex; index <= sampleIndex; index += 1) {
      const bucket = owner.buckets.get(index);
      if (
        incremental &&
        index === requestedCursor!.sampleIndex &&
        (bucket?.revision ?? 0) <= requestedCursor!.revision
      ) {
        continue;
      }
      samples.push(this.#sample(index, bucket));
    }
    const current = this.#sample(sampleIndex, owner.buckets.get(sampleIndex));
    return {
      schemaVersion: 1,
      epoch: this.epoch,
      cursor: cursorValue(sampleIndex, owner.revision),
      instanceId: this.instanceId,
      scope: "current-server-instance",
      sampleIntervalSeconds: LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS,
      windowSeconds: LIVE_TRAFFIC_WINDOW_SECONDS,
      generatedAt: new Date(now).toISOString(),
      reset,
      current,
      samples,
      measurement: {
        basis: "application-payload",
        directTrafficIncluded: false,
        transportOverheadIncluded: false,
      },
    };
  }

  ownerCount(): number {
    this.#evict(Math.floor(this.#nowMilliseconds() / 1_000));
    return this.#owners.size;
  }

  #bucket(owner: OwnerTraffic, sampleIndex: number): TrafficBucket {
    // Prune once per sample, rather than scanning the longer window per message.
    if (owner.lastPrunedSampleIndex !== sampleIndex) {
      const minimum = sampleIndex - ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES + 1;
      for (const index of owner.buckets.keys()) {
        if (index < minimum || index > sampleIndex) owner.buckets.delete(index);
      }
      owner.lastPrunedSampleIndex = sampleIndex;
    }
    let bucket = owner.buckets.get(sampleIndex);
    if (!bucket) {
      bucket = emptyBucket();
      owner.buckets.set(sampleIndex, bucket);
    }
    return bucket;
  }

  #currentSampleIndex(): number {
    return Math.floor(this.#nowMilliseconds() / SAMPLE_INTERVAL_MS);
  }

  #nowMilliseconds(): number {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("Live traffic clock returned an invalid value.");
    }
    return now;
  }

  #evict(second: number): void {
    if (this.#lastEvictionSecond === second) return;
    this.#lastEvictionSecond = second;
    const staleBefore = second - this.#ownerRetentionSeconds;
    for (const [ownerId, owner] of this.#owners) {
      if (owner.lastAccessSecond < staleBefore) this.#owners.delete(ownerId);
    }
  }

  #owner(ownerId: string, sampleIndex: number): OwnerTraffic {
    const second = Math.floor(
      sampleIndex * LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS,
    );
    if (!ownerId || ownerId.length > 200) {
      throw new Error("Live traffic owner is invalid.");
    }
    this.#evict(second);
    const existing = this.#owners.get(ownerId);
    if (existing) {
      existing.lastAccessSecond = second;
      return existing;
    }
    if (this.#owners.size >= this.#maxOwners) {
      let oldestId: string | null = null;
      let oldestSecond = Number.POSITIVE_INFINITY;
      for (const [candidateId, candidate] of this.#owners) {
        if (candidate.lastAccessSecond < oldestSecond) {
          oldestId = candidateId;
          oldestSecond = candidate.lastAccessSecond;
        }
      }
      if (oldestId) this.#owners.delete(oldestId);
    }
    const created: OwnerTraffic = {
      buckets: new Map(),
      lastAccessSecond: second,
      lastPrunedSampleIndex: -1,
      revision: 0,
    };
    this.#owners.set(ownerId, created);
    return created;
  }

  #sample(
    sampleIndex: number,
    bucket: TrafficBucket | undefined,
  ): AccountLiveTrafficSample {
    const value = bucket ?? emptyBucket();
    return {
      timestamp: new Date(sampleIndex * SAMPLE_INTERVAL_MS).toISOString(),
      uploadBytes: value.uploadBytes,
      downloadBytes: value.downloadBytes,
      httpRequests: value.httpRequests,
      websocketMessages: {
        upload: value.websocketUpload,
        download: value.websocketDownload,
        total: addCounter(value.websocketUpload, value.websocketDownload),
      },
    };
  }
}
