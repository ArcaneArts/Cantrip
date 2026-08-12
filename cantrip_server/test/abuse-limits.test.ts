import type { WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveLimit,
  RelayLimitError,
  SlidingWindowRateLimiter,
} from "../src/security/abuse-limits.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";
import { LimitedWorkerCommandBus } from "../src/workers/limited-command-bus.js";

class PendingCommandBus implements WorkerCommandBus {
  readonly pending: Array<{
    reject(error: Error): void;
    resolve(value: unknown): void;
  }> = [];

  attach(): void {}
  close(): void {}
  isConnected(): boolean {
    return true;
  }
  sendSurfaceFrame(): boolean {
    return true;
  }
  subscribeWorkerDisconnect(): () => void {
    return () => undefined;
  }
  subscribeSurfaceFrames(): () => void {
    return () => undefined;
  }
  request(
    _workerId: string,
    _command: WorkerCommand,
    _options?: WorkerRequestOptions,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

describe("hosted relay abuse limits", () => {
  it("bounds sliding windows and releases active claims exactly once", () => {
    const rate = new SlidingWindowRateLimiter(2, 1_000);
    expect(rate.consume("account", 1_000)).toBeNull();
    expect(rate.consume("account", 1_100)).toBeNull();
    expect(rate.consume("account", 1_200)).toBe(1);
    expect(rate.consume("account", 2_101)).toBeNull();

    const active = new ActiveLimit(1);
    const release = active.acquire("account");
    expect(release).not.toBeNull();
    expect(active.acquire("account")).toBeNull();
    release!();
    release!();
    expect(active.count("account")).toBe(0);
    expect(active.acquire("account")).not.toBeNull();
  });

  it("enforces worker and account command concurrency without timing out long work", async () => {
    const delegate = new PendingCommandBus();
    const limited = new LimitedWorkerCommandBus(delegate, {
      accountConcurrency: 1,
      accountRatePerMinute: 10,
      resolveOwnerId: async () => "owner-1",
      workerConcurrency: 1,
      workerRatePerMinute: 10,
    });
    const first = limited.request("worker-1", { type: "code.probe" });
    await vi.waitFor(() => expect(delegate.pending).toHaveLength(1));
    await expect(
      limited.request("worker-1", { type: "code.probe" }),
    ).rejects.toBeInstanceOf(RelayLimitError);
    delegate.pending[0]!.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });

    const next = limited.request("worker-1", { type: "code.probe" });
    await vi.waitFor(() => expect(delegate.pending).toHaveLength(2));
    delegate.pending[1]!.resolve({ ok: true });
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("rate limits commands independently from active command lifetime", async () => {
    const delegate = new PendingCommandBus();
    const limited = new LimitedWorkerCommandBus(delegate, {
      accountConcurrency: 2,
      accountRatePerMinute: 1,
      resolveOwnerId: async () => "owner-1",
      workerConcurrency: 2,
      workerRatePerMinute: 1,
    });
    const first = limited.request("worker-1", { type: "code.probe" });
    await vi.waitFor(() => expect(delegate.pending).toHaveLength(1));
    delegate.pending[0]!.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(
      limited.request("worker-1", { type: "code.probe" }),
    ).rejects.toMatchObject({
      name: "RelayLimitError",
      retryAfterSeconds: expect.any(Number),
    });
  });
});
