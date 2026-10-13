import type { WorkerLinkLease } from "@cantrip/protocol";

/** Retry transient transport/server failures, never explicit authority denials. */
export function transientRenewalError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Reflect.get(error, "status");
  if (typeof status === "number") {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  return error instanceof Error && error.name !== "ZodError";
}

/** Bounded jitter keeps retries inside their existing maximum delay. */
export function jitterRetryDelay(
  delayMs: number,
  random = Math.random,
): number {
  return Math.floor(
    delayMs * (0.75 + Math.min(1, Math.max(0, random())) * 0.25),
  );
}

export async function boundedRenewalAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<T> {
  signal.throwIfAborted();
  const request = new AbortController();
  const cancel = () => request.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let rejectAbort!: (error: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => request.abort(new Error("Lease renewal request timed out.")),
    timeoutMs,
  );
  try {
    return await Promise.race([operation(request.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", onAbort);
  }
}

interface LeaseRenewalOptions<T> {
  lease: WorkerLinkLease;
  renewAheadMs: number;
  now(): number;
  renew(signal: AbortSignal): Promise<T>;
  accept(value: T): WorkerLinkLease;
  onEnded(reason: "expired" | "revoked"): void;
  random?: () => number;
}

/** Owns one authorization lifetime. An outstanding HTTP request cannot extend it. */
export class LeaseRenewal<T> {
  #closed = false;
  #deadline = 0;
  #absoluteDeadline = Number.POSITIVE_INFINITY;
  #deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #request: AbortController | null = null;
  #failures = 0;

  constructor(private readonly options: LeaseRenewalOptions<T>) {}

  start(): void {
    if (this.#closed || this.#deadlineTimer) return;
    this.#installLease(this.options.lease);
  }

  stop(): void {
    this.#closed = true;
    if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#deadlineTimer = this.#retryTimer = null;
    this.#request?.abort();
    this.#request = null;
  }

  #end(reason: "expired" | "revoked"): void {
    if (this.#closed) return;
    this.stop();
    this.options.onEnded(reason);
  }

  #installLease(lease: WorkerLinkLease): void {
    this.#absoluteDeadline = Math.min(
      this.#absoluteDeadline,
      Date.parse(lease.absoluteExpiresAt),
    );
    this.#deadline = Math.min(
      Date.parse(lease.expiresAt),
      this.#absoluteDeadline,
    );
    const remaining = this.#deadline - this.options.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.#end("expired");
      return;
    }
    if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = setTimeout(() => this.#end("expired"), remaining);
    this.#schedule(Math.max(1_000, remaining - this.options.renewAheadMs));
  }

  #schedule(delayMs: number): void {
    if (this.#closed) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        void this.#renew();
      },
      Math.min(delayMs, Math.max(0, this.#deadline - this.options.now())),
    );
  }

  async #renew(): Promise<void> {
    if (this.#closed || this.#request) return;
    if (this.options.now() >= this.#deadline) {
      this.#end("expired");
      return;
    }
    const request = new AbortController();
    this.#request = request;
    try {
      const value = await boundedRenewalAttempt(
        this.options.renew,
        request.signal,
        Math.min(5_000, this.#deadline - this.options.now()),
      );
      if (this.#closed || request.signal.aborted) return;
      if (this.options.now() >= this.#deadline) {
        this.#end("expired");
        return;
      }
      let lease: WorkerLinkLease;
      try {
        lease = this.options.accept(value);
      } catch {
        this.#end("revoked");
        return;
      }
      if (this.#closed) return;
      this.#failures = 0;
      this.#installLease(lease);
    } catch (error) {
      if (this.#closed) return;
      if (!transientRenewalError(error)) {
        this.#end("revoked");
        return;
      }
      this.#schedule(
        jitterRetryDelay(
          Math.min(3_000, 250 * 2 ** Math.min(this.#failures++, 4)),
          this.options.random,
        ),
      );
    } finally {
      if (this.#request === request) this.#request = null;
    }
  }
}
