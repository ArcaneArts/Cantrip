import type { CodexRuntime } from "./codex/runtime.js";
import type {
  NativeHistoryNotification,
  NativeHistorySnapshotObservation,
  NativeHistorySubscription,
} from "./codex/native-history-observation.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import { NativeHistoryCursorTracker } from "./native-history-cursor-tracker.js";

type Frame = NativeHistoryNotification | NativeHistorySnapshotObservation;
type Record = Awaited<ReturnType<NativeHistorySourceJournal["append"]>>;
type CapturedSnapshot = {
  observation: NativeHistorySnapshotObservation;
  record: Record;
};
type Phase = "observe" | "snapshot" | "append" | "notify";
interface Pending {
  frame: Frame;
  revision?: number;
}

export interface NativeHistoryCaptureOptions {
  runtime: Pick<CodexRuntime, "observeNativeHistory">;
  threadId: string;
  journal: Pick<NativeHistorySourceJournal, "append">;
  /** Wake a separate durable projector with the newest persisted header. Calls
   * may coalesce/repeat: read the journal, not only this row. Never perform input. */
  onPersisted?: (record: Record) => void | Promise<void>;
  /** Correlation-only diagnostics; don't log raw frame contents. */
  onError?: (error: unknown, phase: Phase) => void;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  snapshotDelayMs?: number;
}

/** Captures one transport lifetime into a durable source journal. Native calls
 * never await this writer. Retirement stops observation, not pending persistence.
 * This is source recovery, not canonical projection/commit or execution authority. */
export class NativeHistoryCapture {
  private readonly subscription: NativeHistorySubscription;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly snapshotDelayMs: number;
  private readonly pending: Pending[] = [];
  private readonly cursors = new NativeHistoryCursorTracker();
  private offset = 0;
  private observing = true;
  private stopped = false;
  private writing = false;
  private reading = false;
  private dirty = false;
  private requestedRevision = 0;
  private writeFailures = 0;
  private readFailures = 0;
  private notifyFailures = 0;
  private notification: Record | null = null;
  private notifying = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushWaiters = new Set<{
    resolve(): void;
    reject(error: unknown): void;
  }>();
  private readonly snapshotWaiters = new Set<{
    revision: number;
    resolve(value: CapturedSnapshot): void;
    reject(error: unknown): void;
  }>();

  constructor(private readonly options: NativeHistoryCaptureOptions) {
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.snapshotDelayMs = options.snapshotDelayMs ?? 50;
    if (
      ![this.retryDelayMs, this.maxRetryDelayMs, this.snapshotDelayMs].every(
        (value) =>
          Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647,
      ) ||
      this.retryDelayMs < 1 ||
      this.maxRetryDelayMs < this.retryDelayMs
    )
      throw new Error("Invalid native history capture scheduling interval.");
    this.subscription = options.runtime.observeNativeHistory(options.threadId, {
      capture: (event) => {
        this.enqueue({ frame: event });
        if (
          this.cursors.notification(event) ||
          ["thread/started", "turn/started", "turn/completed"].includes(
            event.method,
          )
        )
          this.reconcile();
      },
      onError: (error) => {
        this.report(error, "observe");
        this.reconcile();
      },
    });
    this.subscription.signal.addEventListener("abort", this.retired, {
      once: true,
    });
    if (this.subscription.signal.aborted) this.retired();
    else this.reconcile(0);
  }

  get generation() {
    return this.subscription.generation;
  }
  get signal() {
    return this.subscription.signal;
  }
  get pendingRecords() {
    return this.pending.length - this.offset;
  }

  private report(error: unknown, phase: Phase) {
    try {
      this.options.onError?.(error, phase);
    } catch {
      /* Diagnostics cannot poison recovery. */
    }
  }
  private delay(failures: number) {
    return Math.min(
      this.maxRetryDelayMs,
      this.retryDelayMs * 2 ** Math.min(failures - 1, 32),
    );
  }
  private retired = () => {
    this.endObservation(this.subscription.signal.reason);
    this.checkFlushed();
  };
  private endObservation(error: unknown) {
    this.observing = false;
    this.dirty = false;
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = null;
    for (const waiter of this.snapshotWaiters) waiter.reject(error);
    this.snapshotWaiters.clear();
  }

  /** Coalesces real dirty signals; an actual failed read retries without new input. */
  reconcile(delay = this.snapshotDelayMs): void {
    if (!this.observing || this.stopped) return;
    if (!this.dirty) this.requestedRevision++;
    this.dirty = true;
    this.scheduleRead(delay);
  }

  /** Resolves only after a read begun for this request reaches durable storage. */
  snapshot(): Promise<CapturedSnapshot> {
    if (!this.observing || this.stopped)
      return Promise.reject(
        new Error("Native history capture is no longer observing."),
      );
    const revision = ++this.requestedRevision;
    const result = new Promise<CapturedSnapshot>((resolve, reject) =>
      this.snapshotWaiters.add({ revision, resolve, reject }),
    );
    this.dirty = true;
    this.scheduleRead(0);
    return result;
  }

  private scheduleRead(delay: number) {
    if (
      this.stopped ||
      !this.observing ||
      this.reading ||
      this.readTimer ||
      !this.dirty
    )
      return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      void this.read();
    }, delay);
    this.readTimer.unref();
  }
  private async read() {
    if (this.stopped || !this.observing) return;
    this.reading = true;
    this.dirty = false;
    const revision = this.requestedRevision;
    let delay = this.snapshotDelayMs;
    try {
      const frame = await this.subscription.readSnapshot();
      if (!this.observing || this.stopped) return;
      const unresolvedGap = this.cursors.snapshot(frame);
      this.enqueue({ frame, revision });
      if (unresolvedGap) {
        this.dirty = true;
        delay = this.delay(++this.readFailures);
      } else this.readFailures = 0;
    } catch (error) {
      if (this.observing && !this.stopped) {
        this.report(error, "snapshot");
        this.dirty = true;
        delay = this.delay(++this.readFailures);
      }
    } finally {
      this.reading = false;
      this.scheduleRead(delay);
      this.checkFlushed();
    }
  }

  private enqueue(entry: Pending) {
    if (this.stopped) return;
    this.pending.push(structuredClone(entry));
    this.scheduleWrite(0);
  }
  private scheduleWrite(delay: number) {
    if (this.stopped || this.writing || this.writeTimer || !this.pendingRecords)
      return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.write();
    }, delay);
    this.writeTimer.unref();
  }
  private async write() {
    if (this.stopped) return;
    this.writing = true;
    let delay = 0;
    try {
      while (this.pendingRecords && !this.stopped) {
        const entry = this.pending[this.offset]!;
        const record = await this.options.journal.append(entry.frame);
        this.offset++;
        this.writeFailures = 0;
        if (entry.frame.kind === "snapshot") {
          for (const waiter of this.snapshotWaiters) {
            if (waiter.revision > entry.revision!) continue;
            this.snapshotWaiters.delete(waiter);
            waiter.resolve({ observation: entry.frame, record });
          }
        }
        if (
          this.offset === this.pending.length ||
          (this.offset >= 128 && this.offset * 2 >= this.pending.length)
        ) {
          this.pending.splice(0, this.offset);
          this.offset = 0;
        }
        if (!this.stopped && this.options.onPersisted) {
          this.notification = record;
          this.scheduleNotify(0);
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.report(error, "append");
        delay = this.delay(++this.writeFailures);
      }
    } finally {
      this.writing = false;
      this.scheduleWrite(delay);
      this.checkFlushed();
    }
  }

  private scheduleNotify(delay: number) {
    if (
      this.stopped ||
      this.notifying ||
      this.notifyTimer ||
      !this.notification
    )
      return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      void this.notify();
    }, delay);
    this.notifyTimer.unref();
  }
  private async notify() {
    if (this.stopped || !this.notification) return;
    this.notifying = true;
    const record = this.notification;
    let delay = 0;
    try {
      await this.options.onPersisted?.({ ...record });
      if (this.notification === record) this.notification = null;
      this.notifyFailures = 0;
    } catch (error) {
      if (!this.stopped) {
        this.report(error, "notify");
        delay = this.delay(++this.notifyFailures);
      }
    } finally {
      this.notifying = false;
      this.scheduleNotify(delay);
      this.checkFlushed();
    }
  }

  /** Waits for current captured records and requested reads, never for a model turn. */
  flush(): Promise<void> {
    if (this.stopped)
      return Promise.reject(
        new Error(
          "Native history capture was stopped before confirming a drain.",
        ),
      );
    const result = new Promise<void>((resolve, reject) =>
      this.flushWaiters.add({ resolve, reject }),
    );
    this.checkFlushed();
    return result;
  }
  private checkFlushed() {
    if (
      this.pendingRecords ||
      this.writing ||
      this.notification ||
      this.notifying ||
      (this.observing && (this.reading || this.dirty || this.readTimer))
    )
      return;
    for (const waiter of this.flushWaiters) waiter.resolve();
    this.flushWaiters.clear();
  }

  /** Detach observation and drain accepted frames; storage failures remain retryable. */
  close(): Promise<void> {
    this.endObservation(new Error("Native history observation was closed."));
    this.subscription.signal.removeEventListener("abort", this.retired);
    this.subscription.close();
    return this.flush();
  }

  /** Final teardown only. Pending memory is NOT declared durable or consumed.
   * Normal retirement/close should drain; a forced shutdown needs reconciliation. */
  stop(): void {
    this.stopped = true;
    const error = new Error(
      "Native history capture stopped before confirming a drain.",
    );
    this.endObservation(error);
    this.subscription.signal.removeEventListener("abort", this.retired);
    this.subscription.close();
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    for (const waiter of this.flushWaiters) waiter.reject(error);
    this.flushWaiters.clear();
  }
}
