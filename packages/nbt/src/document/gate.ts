export class NbtWorkGate {
  private paused = false;
  private waiters = new Set<() => void>();
  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
  }
  async wait(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(done);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(done);
        reject(signal.reason);
      };
      this.waiters.add(done);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
  }
}
export async function waitNbtPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
