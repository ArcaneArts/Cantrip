import type {
  NativeHistoryCommitReceipt,
  NativeHistoryOutbox,
  NativeHistoryOutboxRecord,
} from "./native-history-outbox.js";

type Phase = "read" | "decrypt" | "deliver" | "acknowledge";

export interface NativeHistoryDeliveryOptions {
  outbox: Pick<
    NativeHistoryOutbox,
    "pending" | "openBody" | "acknowledgeCommitted"
  >;
  /** Send the prepared opaque batch unchanged; only canonical commit may return a receipt. */
  deliver(
    record: NativeHistoryOutboxRecord,
    body: string,
    signal: AbortSignal,
  ): Promise<NativeHistoryCommitReceipt>;
  /** Correlation-only logging belongs here. Never log batch bodies or ciphertext. */
  onError?: (error: unknown, phase: Phase) => void;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * One worker-owned delivery pump per outbox. Its waits never own an execution
 * lane, native command queue, or UI connection. Stop only stops delivery: the
 * durable pending record remains available to a replacement pump.
 */
export class NativeHistoryDelivery {
  private readonly abort = new AbortController();
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dirty = false;
  private failures = 0;

  constructor(private readonly options: NativeHistoryDeliveryOptions) {
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.retryDelayMs) ||
      this.retryDelayMs < 1 ||
      !Number.isSafeInteger(this.maxRetryDelayMs) ||
      this.maxRetryDelayMs < this.retryDelayMs ||
      this.maxRetryDelayMs > 2_147_483_647
    )
      throw new Error("Invalid native history delivery retry interval.");
  }

  /** Also call once at worker recovery, before any new native activity arrives. */
  wake(): void {
    if (this.abort.signal.aborted) return;
    this.dirty = true;
    if (!this.running && !this.timer) this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.abort.abort();
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return;
    this.running = true;
    let phase: Phase = "read";
    let retry = false;
    try {
      while (!this.abort.signal.aborted) {
        this.dirty = false;
        phase = "read";
        const [record] = await this.options.outbox.pending();
        if (!record || this.abort.signal.aborted) return;
        phase = "decrypt";
        const body = await this.options.outbox.openBody(record);
        if (this.abort.signal.aborted) return;
        phase = "deliver";
        const receipt = await this.options.deliver(
          record,
          body,
          this.abort.signal,
        );
        // A response may race stop/identity replacement. Keeping it pending is
        // safe: the next pump reconciles the same immutable server commit.
        if (this.abort.signal.aborted) return;
        phase = "acknowledge";
        await this.options.outbox.acknowledgeCommitted(receipt);
        this.failures = 0;
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        retry = true;
        this.failures += 1;
        try {
          this.options.onError?.(error, phase);
        } catch {
          // A diagnostic sink cannot consume pending work or disable retry.
        }
      }
    } finally {
      this.running = false;
      if (!this.abort.signal.aborted) {
        if (retry) {
          this.schedule(
            Math.min(
              this.maxRetryDelayMs,
              this.retryDelayMs * 2 ** Math.min(this.failures - 1, 32),
            ),
          );
        } else if (this.dirty) {
          this.schedule(0);
        }
      }
    }
  }
}
