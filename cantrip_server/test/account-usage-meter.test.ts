import { createServiceLogEmitter } from "@cantrip/logging";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountUsageMeter,
  type AccountBandwidthFlushSink,
} from "../src/account-usage/bandwidth-meter.js";
import type { AccountBandwidthFlushBatch } from "../src/db/account-resource-usage.js";

const logger = createServiceLogEmitter("account-usage-meter-test", {
  output: () => undefined,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountUsageMeter", () => {
  it("flushes on the one-minute default cadence", async () => {
    vi.useFakeTimers();
    const batches: AccountBandwidthFlushBatch[] = [];
    const meter = new AccountUsageMeter(
      {
        async flushBandwidthBatch(batch) {
          batches.push(batch);
          return { applied: true, ownerIds: ["owner-1"] };
        },
      },
      logger,
    );
    meter.record({
      ownerId: "owner-1",
      direction: "ingress",
      channel: "http",
      bytes: 1,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    await meter.close();
  });

  it("aggregates directions and channels into one retry-safe batch", async () => {
    const batches: AccountBandwidthFlushBatch[] = [];
    const sink: AccountBandwidthFlushSink = {
      async flushBandwidthBatch(batch) {
        batches.push(batch);
        return { applied: true, ownerIds: ["owner-1"] };
      },
    };
    const flushedOwners: string[][] = [];
    const meter = new AccountUsageMeter(sink, logger, {
      flushIntervalMs: 60_000,
      flushThresholdBytes: 10_000,
      meterId: "meter-one",
      now: () => new Date("2026-08-23T10:15:00.000Z"),
      onFlushed: (ownerIds) => flushedOwners.push(ownerIds),
    });

    meter.record({
      ownerId: "owner-1",
      direction: "ingress",
      channel: "http",
      bytes: 10,
    });
    meter.record({
      ownerId: "owner-1",
      direction: "ingress",
      channel: "http",
      bytes: 20,
    });
    meter.record({
      ownerId: "owner-1",
      direction: "egress",
      channel: "worker-control-websocket",
      bytes: 40,
      operationCount: 2,
    });

    await expect(meter.flush()).resolves.toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ meterId: "meter-one", sequence: 1n });
    expect(batches[0]!.entries).toEqual([
      expect.objectContaining({
        bucketStart: new Date("2026-08-23T10:00:00.000Z"),
        bytes: 30n,
        operationCount: 2n,
        direction: "ingress",
        channel: "http",
      }),
      expect.objectContaining({
        bytes: 40n,
        operationCount: 2n,
        direction: "egress",
        channel: "worker-control-websocket",
      }),
    ]);
    expect(flushedOwners).toEqual([["owner-1"]]);
    expect(meter.stats()).toMatchObject({
      bufferedBytes: 0n,
      bufferedEntries: 0,
      flushCount: 1,
      flushFailureCount: 0,
    });
    await meter.close();
  });

  it("retries the identical sequence after an ambiguous database failure", async () => {
    const batches: AccountBandwidthFlushBatch[] = [];
    let attempt = 0;
    const sink: AccountBandwidthFlushSink = {
      async flushBandwidthBatch(batch) {
        batches.push(batch);
        attempt += 1;
        if (attempt === 1) throw new Error("response lost after commit");
        return { applied: false, ownerIds: ["owner-1"] };
      },
    };
    const meter = new AccountUsageMeter(sink, logger, {
      flushIntervalMs: 60_000,
      flushThresholdBytes: 10_000,
      meterId: "meter-retry",
      now: () => new Date("2026-08-23T10:15:00.000Z"),
    });
    meter.record({
      ownerId: "owner-1",
      direction: "egress",
      channel: "http",
      bytes: 12,
    });

    await expect(meter.flush()).resolves.toBe(false);
    expect(meter.stats().bufferedBytes).toBe(12n);
    await expect(meter.flush()).resolves.toBe(true);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(meter.stats()).toMatchObject({
      bufferedBytes: 0n,
      flushCount: 1,
      flushFailureCount: 1,
    });
    await meter.close();
  });

  it("bounds unique buffered dimensions and flushes during shutdown", async () => {
    const batches: AccountBandwidthFlushBatch[] = [];
    const meter = new AccountUsageMeter(
      {
        async flushBandwidthBatch(batch) {
          batches.push(batch);
          return { applied: true, ownerIds: ["owner-1"] };
        },
      },
      logger,
      {
        flushIntervalMs: 60_000,
        flushThresholdBytes: 10_000,
        maxBufferedEntries: 1,
        now: () => new Date("2026-08-23T10:15:00.000Z"),
      },
    );
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "ingress",
        channel: "http",
        bytes: -1,
      }),
    ).toBe(false);
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "ingress",
        channel: "http",
        bytes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(false);
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "ingress",
        channel: "http",
        bytes: 4,
      }),
    ).toBe(true);
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "egress",
        channel: "http",
        bytes: 5,
      }),
    ).toBe(false);
    expect(meter.stats()).toMatchObject({
      bufferedEntries: 1,
      droppedBytes: 5n,
      droppedMeasurements: 1n,
    });

    await meter.close();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries[0]!.bytes).toBe(4n);
  });

  it("fans valid measurements to a live observer without coupling buffer capacity", async () => {
    const observed: Array<{ bytes: bigint | number; ownerId: string }> = [];
    const meter = new AccountUsageMeter(
      {
        async flushBandwidthBatch() {
          return { applied: true, ownerIds: ["owner-1"] };
        },
      },
      logger,
      {
        flushIntervalMs: 60_000,
        flushThresholdBytes: 10_000,
        maxBufferedEntries: 1,
        onMeasurement: (measurement) => observed.push(measurement),
      },
    );
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "ingress",
        channel: "http",
        bytes: 4,
      }),
    ).toBe(true);
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "egress",
        channel: "http",
        bytes: 5,
      }),
    ).toBe(false);
    expect(
      meter.record({
        ownerId: "owner-1",
        direction: "egress",
        channel: "http",
        bytes: -1,
      }),
    ).toBe(false);
    expect(observed).toEqual([
      expect.objectContaining({ ownerId: "owner-1", bytes: 4n }),
      expect.objectContaining({ ownerId: "owner-1", bytes: 5n }),
    ]);
    await meter.close();
  });

  it("persists observer traffic without creating a live-refresh loop", async () => {
    const flushedOwners: string[][] = [];
    const meter = new AccountUsageMeter(
      {
        async flushBandwidthBatch() {
          return { applied: true, ownerIds: ["owner-1"] };
        },
      },
      logger,
      {
        flushIntervalMs: 60_000,
        flushThresholdBytes: 10_000,
        onFlushed: (ownerIds) => flushedOwners.push(ownerIds),
      },
    );
    meter.record({
      ownerId: "owner-1",
      direction: "egress",
      channel: "http",
      bytes: 25,
      notifyChange: false,
    });
    await meter.flush();
    expect(flushedOwners).toEqual([]);
    await meter.close();
  });
});
