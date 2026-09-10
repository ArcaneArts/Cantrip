/** Hold autonomous requests and hide destination observations until publication.
 * Explicit native/worker cancellation still aborts the waiting request. */
export class ManagedRuntimeHandoffStaging<T extends object> {
  private readonly entries = new WeakMap<
    T,
    Map<
      string,
      {
        operationId: string;
        ready: Promise<void>;
        retired: boolean;
        release(): void;
        retire(): void;
      }
    >
  >();
  hold(runtime: T, threadId: string, operationId: string): void {
    let threads = this.entries.get(runtime);
    if (!threads) this.entries.set(runtime, (threads = new Map()));
    const prior = threads.get(threadId);
    if (prior) {
      if (prior.operationId !== operationId)
        throw new Error("Native thread already belongs to another handoff.");
      return;
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void ready.catch(() => {});
    threads.set(threadId, {
      operationId,
      ready,
      retired: false,
      release: resolve,
      retire: () => reject(new Error("The handoff source runtime is retired.")),
    });
  }
  held(runtime: T, threadId: string): boolean {
    return this.entries.get(runtime)?.has(threadId) ?? false;
  }
  async wait(runtime: T, threadId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const entry = this.entries.get(runtime)?.get(threadId);
    if (!entry) return;
    let reject!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_yes, no) => {
      reject = no;
    });
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([entry.ready, cancelled]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  release(runtime: T, threadId: string, operationId: string): void {
    const threads = this.entries.get(runtime);
    const entry = threads?.get(threadId);
    if (!entry) return;
    if (entry.retired)
      throw new Error("The handoff source runtime is retired.");
    if (entry.operationId !== operationId)
      throw new Error("Another handoff owns this native thread.");
    threads!.delete(threadId);
    entry.release();
  }
  retire(runtime: T, threadId: string, operationId: string): void {
    const entry = this.entries.get(runtime)?.get(threadId);
    if (entry?.operationId === operationId) {
      entry.retired = true;
      entry.retire();
    }
  }
}
