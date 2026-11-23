import { setTimeout as delay } from "node:timers/promises";
import { CantripServerRequestError } from "./cli-client.js";

/** Replay only an idempotent metadata request with its original immutable body.
 * This never admits, dispatches or repeats native/model input. The caller's
 * transport lifetime and a bounded publication deadline cancel the wait. */
export async function recoverNativeMetadata<T>(
  request: (signal: AbortSignal) => Promise<T>,
  ...parents: (AbortSignal | undefined)[]
): Promise<T> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = AbortSignal.any([
    ...parents.filter((value): value is AbortSignal => Boolean(value)),
    deadline,
  ]);
  let backoff = 250;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await request(signal);
    } catch (error) {
      signal.throwIfAborted();
      const retryable =
        error instanceof CantripServerRequestError
          ? error.status >= 500 || error.status === 408 || error.status === 429
          : error instanceof TypeError && error.message === "fetch failed";
      if (!retryable) throw error;
      await delay(backoff, undefined, { signal, ref: false });
      backoff = Math.min(backoff * 2, 2000);
    }
  }
}
