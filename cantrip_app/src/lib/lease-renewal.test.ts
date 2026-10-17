import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLinkLease } from "@cantrip/protocol";
import {
  jitterRetryDelay,
  LeaseRenewal,
  transientRenewalError,
} from "./lease-renewal";

const now = Date.parse("2026-10-13T12:00:00Z");
function lease(expiresIn = 20_000, absoluteIn = 60_000): WorkerLinkLease {
  return {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresIn).toISOString(),
    absoluteExpiresAt: new Date(now + absoluteIn).toISOString(),
  };
}
function setup(renew = vi.fn(async (_signal: AbortSignal) => lease(40_000))) {
  const accept = vi.fn((value: WorkerLinkLease) => value);
  const onEnded = vi.fn();
  const renewal = new LeaseRenewal({
    lease: lease(),
    renewAheadMs: 10_000,
    now: Date.now,
    renew,
    accept,
    onEnded,
    random: () => 1,
  });
  renewal.start();
  return { renewal, renew, accept, onEnded };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("bounded lease renewal", () => {
  it("retries a transient failure without ending the valid lease", async () => {
    const fixture = setup(
      vi
        .fn<(signal: AbortSignal) => Promise<WorkerLinkLease>>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(lease(40_000)),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.onEnded).not.toHaveBeenCalled();
    fixture.renewal.stop();
  });

  it("ends repeated failures at the original expiry without concurrent requests", async () => {
    const fixture = setup(
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fixture.onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.onEnded).toHaveBeenCalledExactlyOnceWith("expired");
    const count = fixture.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.renew).toHaveBeenCalledTimes(count);
  });

  it.each([400, 401, 403, 404, 409])(
    "ends explicit HTTP %s rejection immediately",
    async (status) => {
      const fixture = setup(
        vi.fn(async () => {
          throw Object.assign(new Error("rejected"), { status });
        }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.onEnded).toHaveBeenCalledExactlyOnceWith("revoked");
      expect(fixture.renew).toHaveBeenCalledOnce();
    },
  );

  it("bounds a hung request and ignores its eventual result", async () => {
    let resolve!: (value: WorkerLinkLease) => void;
    const pending = new Promise<WorkerLinkLease>((done) => {
      resolve = done;
    });
    const fixture = setup(
      vi
        .fn<(signal: AbortSignal) => Promise<WorkerLinkLease>>()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(lease(40_000)),
    );
    await vi.advanceTimersByTimeAsync(15_250);
    expect(fixture.renew).toHaveBeenCalledTimes(2);
    expect(fixture.renew.mock.calls[0]![0].aborted).toBe(true);
    resolve(lease(59_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.accept).toHaveBeenCalledExactlyOnceWith(lease(40_000));
    fixture.renewal.stop();
  });

  it("aborts pending renewal when its owner is cancelled and ignores late success", async () => {
    let resolve!: (value: WorkerLinkLease) => void;
    const fixture = setup(
      vi.fn(
        (_signal: AbortSignal) =>
          new Promise<WorkerLinkLease>((done) => {
            resolve = done;
          }),
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.renewal.stop();
    resolve(lease(40_000));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.renew.mock.calls[0]![0].aborted).toBe(true);
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.onEnded).not.toHaveBeenCalled();
  });

  it("does not let a successful response after expiry resurrect authority", async () => {
    let resolve!: (value: WorkerLinkLease) => void;
    const fixture = setup(
      vi.fn(
        (_signal: AbortSignal) =>
          new Promise<WorkerLinkLease>((done) => {
            resolve = done;
          }),
      ),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    resolve(lease(40_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.onEnded).toHaveBeenCalledExactlyOnceWith("expired");
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it("never extends beyond the original absolute expiry", async () => {
    const fixture = setup(vi.fn(async () => lease(120_000, 120_000)));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fixture.onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.onEnded).toHaveBeenCalledExactlyOnceWith("expired");
  });

  it("keeps independent renewal owners usable when a sibling is revoked", async () => {
    const first = setup(
      vi.fn(async () => {
        throw Object.assign(new Error("revoked"), { status: 403 });
      }),
    );
    const second = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.onEnded).toHaveBeenCalledWith("revoked");
    expect(second.accept).toHaveBeenCalledOnce();
    expect(second.onEnded).not.toHaveBeenCalled();
    second.renewal.stop();
  });

  it("fails closed when renewed authority validation fails", async () => {
    const fixture = setup();
    fixture.accept.mockImplementation(() => {
      throw new Error("identity changed");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.onEnded).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it.each([lease(-1), { ...lease(), expiresAt: "invalid" }])(
    "rejects already invalid leases",
    (initialLease) => {
      const onEnded = vi.fn();
      new LeaseRenewal({
        lease: initialLease,
        now: Date.now,
        renewAheadMs: 10_000,
        renew: vi.fn(),
        accept: (value: WorkerLinkLease) => value,
        onEnded,
      }).start();
      expect(onEnded).toHaveBeenCalledWith("expired");
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    "classifies HTTP %s as transient",
    (status) => {
      expect(
        transientRenewalError(Object.assign(new Error(), { status })),
      ).toBe(true);
    },
  );

  it("bounds jitter and preserves an immediate initial retry", () => {
    expect(jitterRetryDelay(0)).toBe(0);
    expect(jitterRetryDelay(1_000, () => 0)).toBe(750);
    expect(jitterRetryDelay(1_000, () => 1)).toBe(1_000);
  });
});
