import type { TaskDispatchWorkerLease } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withTaskDispatchLeaseRetention } from "../src/tasks/dispatch-lease-retention.js";

const lease: TaskDispatchWorkerLease = {
  cycleId: "cycle",
  operationId: "operation",
  leaseOwner: "owner",
  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  fencingToken: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Task dispatch lease retention", () => {
  it("renews a claim throughout slow launch preflight and stops afterward", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => undefined);
    let finishPreflight: (() => void) | null = null;
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve;
    });

    const retained = withTaskDispatchLeaseRetention({
      heartbeat,
      lease,
      onHeartbeatError: vi.fn(),
      operation: () => preflight,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);

    finishPreflight?.();
    await retained;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);
  });

  it("reports a periodic heartbeat failure without hiding the operation result", async () => {
    vi.useFakeTimers();
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("lease renewal failed"));
    const onHeartbeatError = vi.fn();
    let finishPreflight: (() => void) | null = null;

    const retained = withTaskDispatchLeaseRetention({
      heartbeat,
      lease,
      onHeartbeatError,
      operation: () =>
        new Promise<string>((resolve) => {
          finishPreflight = () => resolve("ready");
        }),
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onHeartbeatError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "lease renewal failed" }),
    );

    finishPreflight?.();
    await expect(retained).resolves.toBe("ready");
  });
});
