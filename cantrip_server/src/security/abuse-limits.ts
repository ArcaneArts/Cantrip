export class RelayLimitError extends Error {
  readonly statusCode = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds = 1,
  ) {
    super(message);
    this.name = "RelayLimitError";
  }
}

export class SlidingWindowRateLimiter {
  readonly #attempts = new Map<string, number[]>();
  #consumed = 0;

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    readonly maximumKeys = 20_000,
  ) {}

  consume(key: string, now = Date.now()): number | null {
    const cutoff = now - this.windowMs;
    this.#consumed += 1;
    if (this.#consumed % 256 === 0) this.#sweep(cutoff);
    const attempts = (this.#attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (attempts.length >= this.limit) {
      this.#attempts.set(key, attempts);
      return Math.max(
        1,
        Math.ceil((attempts[0]! + this.windowMs - now) / 1_000),
      );
    }
    attempts.push(now);
    this.#attempts.set(key, attempts);
    return null;
  }

  #sweep(cutoff: number): void {
    for (const [key, timestamps] of this.#attempts) {
      if ((timestamps.at(-1) ?? 0) <= cutoff) this.#attempts.delete(key);
    }
    while (this.#attempts.size > this.maximumKeys) {
      const oldest = this.#attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#attempts.delete(oldest);
    }
  }
}

interface ByteWindowBucket {
  bytes: number;
  timestamp: number;
}

export class SlidingWindowByteLimiter {
  readonly #buckets = new Map<string, ByteWindowBucket[]>();
  #consumed = 0;

  constructor(
    readonly limitBytes: number,
    readonly windowMs = 60_000,
    readonly maximumKeys = 20_000,
  ) {}

  consume(key: string, bytes: number, now = Date.now()): number | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("Relay byte usage must be a non-negative safe integer.");
    }
    if (bytes === 0) return null;
    const retryAfter = this.retryAfter(key, bytes, now);
    if (retryAfter !== null) return retryAfter;
    const cutoff = now - this.windowMs;
    this.#consumed += 1;
    if (this.#consumed % 256 === 0) this.#sweep(cutoff);
    const buckets = (this.#buckets.get(key) ?? []).filter(
      (bucket) => bucket.timestamp > cutoff,
    );
    const latest = buckets.at(-1);
    if (latest && latest.timestamp === now) latest.bytes += bytes;
    else buckets.push({ bytes, timestamp: now });
    this.#buckets.set(key, buckets);
    return null;
  }

  retryAfter(key: string, bytes: number, now = Date.now()): number | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("Relay byte usage must be a non-negative safe integer.");
    }
    if (bytes === 0) return null;
    const cutoff = now - this.windowMs;
    const buckets = (this.#buckets.get(key) ?? []).filter(
      (bucket) => bucket.timestamp > cutoff,
    );
    const total = buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
    if (bytes <= this.limitBytes && total + bytes <= this.limitBytes)
      return null;
    return Math.max(
      1,
      Math.ceil(((buckets[0]?.timestamp ?? now) + this.windowMs - now) / 1_000),
    );
  }

  #sweep(cutoff: number): void {
    for (const [key, buckets] of this.#buckets) {
      if ((buckets.at(-1)?.timestamp ?? 0) <= cutoff) this.#buckets.delete(key);
    }
    while (this.#buckets.size > this.maximumKeys) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#buckets.delete(oldest);
    }
  }
}

export class ActiveLimit {
  readonly #counts = new Map<string, number>();

  constructor(readonly limit: number) {}

  acquire(key: string): (() => void) | null {
    const count = this.#counts.get(key) ?? 0;
    if (count >= this.limit) return null;
    this.#counts.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#counts.get(key) ?? 1;
      if (current <= 1) this.#counts.delete(key);
      else this.#counts.set(key, current - 1);
    };
  }

  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  total(): number {
    let total = 0;
    for (const count of this.#counts.values()) total += count;
    return total;
  }
}
