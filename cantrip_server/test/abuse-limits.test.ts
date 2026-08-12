import type { WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveLimit,
  RelayLimitError,
  SlidingWindowByteLimiter,
  SlidingWindowRateLimiter,
} from "../src/security/abuse-limits.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";
import { LimitedWorkerCommandBus } from "../src/workers/limited-command-bus.js";
import { RelayQuotaManager } from "../src/operations/relay-quotas.js";

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

    const bytes = new SlidingWindowByteLimiter(10, 1_000);
    expect(bytes.consume("account", 6, 1_000)).toBeNull();
    expect(bytes.consume("account", 5, 1_100)).toBe(1);
    expect(bytes.consume("account", 5, 2_001)).toBeNull();
  });

  it("enforces account and worker surface, upload, and bandwidth quotas", () => {
    const quotas = new RelayQuotaManager({
      accountRelayBytesPerMinute: 10,
      accountRemoteSurfaceLimit: 1,
      accountUploadBytesPerMinute: 10,
      workerRelayBytesPerMinute: 8,
      workerRemoteSurfaceLimit: 1,
      workerUploadBytesPerMinute: 8,
    } as never);
    const release = quotas.acquireRemoteSurface("owner-1", "worker-1");
    expect(() => quotas.acquireRemoteSurface("owner-1", "worker-2")).toThrow(
      /Account Remote Surface/u,
    );
    release();
    expect(quotas.acquireRemoteSurface("owner-1", "worker-1")).toBeTypeOf(
      "function",
    );

    quotas.consumeUpload("owner-1", "worker-1", 8);
    expect(() => quotas.consumeUpload("owner-1", "worker-1", 1)).toThrow(
      /upload byte quota/u,
    );
    expect(quotas.consumeRelay("owner-1", "worker-1", 8)).toBe(true);
    expect(quotas.consumeRelay("owner-1", "worker-1", 1)).toBe(false);
    expect(quotas.stats()).toMatchObject({
      rejectedRelayBandwidth: 1,
      rejectedRemoteSurfaces: 1,
      rejectedUploads: 1,
      relayBytes: 8,
      uploadBytes: 8,
    });
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

  it("charges worker commands to both account and worker relay byte quotas", async () => {
    const delegate = new PendingCommandBus();
    const consumeRelayBytes = vi.fn(() => false);
    const limited = new LimitedWorkerCommandBus(delegate, {
      accountConcurrency: 2,
      accountRatePerMinute: 10,
      consumeRelayBytes,
      resolveOwnerId: async () => "owner-1",
      workerConcurrency: 2,
      workerRatePerMinute: 10,
    });

    await expect(
      limited.request("worker-1", { type: "code.probe" }),
    ).rejects.toBeInstanceOf(RelayLimitError);
    expect(consumeRelayBytes).toHaveBeenCalledWith(
      "owner-1",
      "worker-1",
      expect.any(Number),
    );
    expect(delegate.pending).toHaveLength(0);
    expect(limited.stats()).toMatchObject({
      activeRequests: 0,
      failedRequests: 1,
      routedRequests: 0,
    });
  });
});
