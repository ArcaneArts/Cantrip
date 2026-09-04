import { CuaProcessError } from "./errors.js";

/** Cancel a pre-send wait without cancelling a shared handshake/queue owner. */
export function waitBeforeCuaSend<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CuaProcessError("cancelled", "not-sent"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
