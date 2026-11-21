import { ServiceLogBuffer } from "@cantrip/logging";
import type { ServiceLogRecord, WorkerNotification } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerLogStreamManager } from "../src/log-stream.js";

function harness(deliveries: boolean[] = [true]) {
  const buffer = new ServiceLogBuffer({ maxEntries: 1_000 });
  const listeners = new Set<(record: ServiceLogRecord) => void>();
  const notifications: WorkerNotification[] = [];
  const manager = new WorkerLogStreamManager({
    emit(notification) {
      notifications.push(notification);
      return deliveries.shift() ?? true;
    },
    read: (query) => buffer.read(query),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    append(message: string, level: "debug" | "warn" = "debug") {
      const record = buffer.append({
        timestamp: new Date().toISOString(),
        system: "worker",
        level,
        message,
      });
      for (const listener of listeners) listener(record);
      return record;
    },
    manager,
    notifications,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker log stream manager", () => {
  it("batches ordered records and advances across filtered records", () => {
    vi.useFakeTimers();
    const stream = harness();
    stream.manager.start({
      type: "diagnostics.logs.stream.start",
      subscriptionId: "00000000-0000-4000-8000-000000000001",
      afterCursor: 0,
      minimumLevel: "warn",
      leaseMs: 60_000,
    });
    stream.append("hidden");
    stream.append("shown", "warn");
    vi.advanceTimersByTime(75);

    expect(stream.notifications).toEqual([
      expect.objectContaining({
        type: "diagnostics.logs.observed",
        records: [expect.objectContaining({ cursor: 2, level: "warn" })],
        nextCursor: 2,
        truncated: false,
      }),
    ]);
    stream.manager.close();
  });

  it("retains a failed batch and bounds a burst with truncation", () => {
    vi.useFakeTimers();
    const stream = harness([false, true]);
    stream.manager.start({
      type: "diagnostics.logs.stream.start",
      subscriptionId: "00000000-0000-4000-8000-000000000002",
      afterCursor: 0,
      minimumLevel: "trace",
      leaseMs: 60_000,
    });
    for (let index = 0; index < 250; index += 1) {
      stream.append(`record-${index}`);
    }
    vi.advanceTimersByTime(75);
    vi.advanceTimersByTime(1_000);

    expect(stream.notifications).toHaveLength(2);
    for (const notification of stream.notifications) {
      expect(notification).toMatchObject({
        type: "diagnostics.logs.observed",
        nextCursor: 250,
        truncated: true,
      });
      if (notification.type === "diagnostics.logs.observed") {
        expect(notification.records).toHaveLength(200);
        expect(notification.records[0]?.cursor).toBe(51);
      }
    }
    stream.manager.close();
  });

  it("expires abandoned subscriptions even when the worker is idle", () => {
    vi.useFakeTimers();
    const stream = harness();
    stream.manager.start({
      type: "diagnostics.logs.stream.start",
      subscriptionId: "00000000-0000-4000-8000-000000000003",
      afterCursor: 0,
      minimumLevel: "trace",
      leaseMs: 10_000,
    });
    vi.advanceTimersByTime(10_000);
    expect(
      stream.manager.renew("00000000-0000-4000-8000-000000000003", 10_000),
    ).toEqual({ accepted: false });
    stream.manager.close();
  });
});
