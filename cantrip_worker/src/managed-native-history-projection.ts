import path from "node:path";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import { NativeHistoryClient } from "./native-history-client.js";
import { readNativeHistoryRecovery } from "./native-history-recovery.js";
import { restoreNativeHistoryProjectorState } from "./native-history-projector-bootstrap.js";
import { rebaseNativeHistoryProjector } from "./native-history-projector-rebase.js";
import { NativeHistoryOutbox } from "./native-history-outbox.js";
import { NativeHistoryProjection } from "./native-history-projection.js";
import { createNativeHistoryProjector } from "./native-history-projector.js";
import { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type Scope = { chatId: string; threadId: string; bindingId: string };
type ProjectorOptions = Parameters<typeof createNativeHistoryProjector>[0];
type Entry = {
  scope: Scope;
  source: NativeHistorySourceJournal;
  abort: AbortController;
  projection?: NativeHistoryProjection;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
  failures: number;
};
interface Options {
  directory: string;
  workerId: string;
  service: WorkerEncryptionService;
  client: NativeHistoryClient;
  /** Scan existing journals at worker startup, independently of native sessions. */
  sourceDirectory?: string;
  onRecoveryError?(error: unknown, key: string | null): void;
  /** Original turn context and provenance, not the latest UI selection. */
  projector(
    binding: NativeHistoryBinding,
    signal: AbortSignal,
    source: NativeHistorySourceJournal,
  ): Promise<
    Pick<ProjectorOptions, "prepare" | "context" | "materialize" | "associate">
  >;
  onError?(error: unknown, scope: Scope): void;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/** One canonical recovery pump per durable binding, independent of model turns,
 * native transports and presentations. A wake accepts work; only the underlying
 * projection's receipt-backed checkpoint establishes that it was committed. */
export class ManagedNativeHistoryProjection {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Set<{
    resolve(): void;
    reject(error: unknown): void;
  }>();
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private stopped = false;
  private closing = false;
  private readonly recoveryAbort = new AbortController();
  private recoveryPending = false;
  private recoveryRunning?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryFailures = 0;

  constructor(private readonly options: Options) {
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    if (
      ![this.retryDelayMs, this.maxRetryDelayMs].every(
        (value) =>
          Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
      ) ||
      this.maxRetryDelayMs < this.retryDelayMs
    )
      throw new Error("Invalid native history projection retry interval.");
    if (options.sourceDirectory) {
      this.recoveryPending = true;
      this.scheduleRecovery(0);
    }
  }

  wake(source: NativeHistorySourceJournal, scope: Scope): void {
    if (this.stopped || this.closing)
      throw new Error("Native history projection is closing.");
    this.accept(source, scope);
  }

  private accept(source: NativeHistorySourceJournal, scope: Scope): void {
    if (this.stopped) throw new Error("Native history projection is stopped.");
    const actual = source.scope;
    if (
      actual.workerId !== this.options.workerId ||
      actual.ownerId !== this.options.service.ownerId() ||
      actual.serverId !== this.options.service.serverIdentity() ||
      actual.chatId !== scope.chatId ||
      actual.threadId !== scope.threadId ||
      actual.bindingId !== scope.bindingId
    )
      throw new Error("Native history wake belongs to another source binding.");
    const key = JSON.stringify(actual);
    let entry = this.entries.get(key);
    if (entry && entry.source.journalId !== source.journalId)
      throw new Error(
        "Native history source identity changed; durable recovery is required.",
      );
    if (!entry) {
      entry = {
        scope: structuredClone(scope),
        source,
        abort: new AbortController(),
        dirty: false,
        failures: 0,
      };
      this.entries.set(key, entry);
    }
    entry.dirty = true;
    this.schedule(entry, 0);
  }

  private scheduleRecovery(delay: number) {
    if (
      this.stopped ||
      !this.recoveryPending ||
      this.recoveryRunning ||
      this.recoveryTimer
    )
      return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryRunning = Promise.resolve().then(() => this.recover());
    }, delay);
    this.recoveryTimer.unref();
  }

  private async recover() {
    let failed = false;
    const report = (error: unknown, key: string | null) => {
      failed = true;
      try {
        this.options.onRecoveryError?.(error, key);
      } catch {
        /* Keep recovery alive. */
      }
    };
    try {
      for await (const found of NativeHistorySourceJournal.recover({
        directory: this.options.sourceDirectory!,
        workerId: this.options.workerId,
        service: this.options.service,
        signal: this.recoveryAbort.signal,
        known: (scope, journalId) =>
          this.entries.get(JSON.stringify(scope))?.source.journalId ===
          journalId,
      })) {
        this.recoveryAbort.signal.throwIfAborted();
        if (!found.journal) {
          report(found.error, found.key);
          continue;
        }
        try {
          const { chatId, threadId, bindingId } = found.journal.scope;
          this.accept(found.journal, { chatId, threadId, bindingId });
        } catch (error) {
          report(error, found.key);
        }
      }
    } catch (error) {
      if (!this.stopped) report(error, null);
    } finally {
      this.recoveryRunning = undefined;
      this.recoveryPending = failed && !this.stopped;
      if (this.recoveryPending)
        this.scheduleRecovery(
          Math.min(
            this.maxRetryDelayMs,
            this.retryDelayMs * 2 ** Math.min(this.recoveryFailures++, 32),
          ),
        );
      this.settleFlush();
    }
  }

  private schedule(entry: Entry, delay: number) {
    if (this.stopped || entry.running || entry.timer || !entry.dirty) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      // Install the running promise before any user callback can synchronously
      // issue another wake or stop this pump.
      entry.running = Promise.resolve().then(() => this.drain(entry));
    }, delay);
    entry.timer.unref();
  }

  private async drain(entry: Entry) {
    let retry = 0;
    let releaseRecovery: (() => void) | undefined;
    try {
      if (this.stopped) return;
      if (!entry.projection) {
        const binding = await this.options.client.open(
          {
            chatId: entry.scope.chatId,
            threadId: entry.scope.threadId,
            provenance: { kind: "binding", bindingId: entry.scope.bindingId },
          },
          entry.abort.signal,
        );
        entry.abort.signal.throwIfAborted();
        const adapters = await this.options.projector(
          binding,
          entry.abort.signal,
          entry.source,
        );
        entry.abort.signal.throwIfAborted();
        const common = {
          workerId: this.options.workerId,
          chatId: binding.chatId,
          bindingId: binding.id,
          service: this.options.service,
        };
        // Outbox recovery and the first projection use the same committed heads.
        // Keep this plaintext snapshot only for initialization, never as a
        // process-wide cache or across a failed projection attempt.
        let recovery: ReturnType<typeof readNativeHistoryRecovery> | undefined;
        const recover = () =>
          (recovery ??= readNativeHistoryRecovery({
            binding,
            client: this.options.client,
            service: this.options.service,
            signal: entry.abort.signal,
          }));
        releaseRecovery = () => {
          recovery = undefined;
        };
        const outbox = await NativeHistoryOutbox.open({
          ...common,
          directory: path.join(this.options.directory, "outbox"),
          recover,
        });
        const project = createNativeHistoryProjector({
          ...adapters,
          bootstrap: async () => {
            try {
              return restoreNativeHistoryProjectorState(await recover());
            } finally {
              recovery = undefined;
            }
          },
          binding,
          client: this.options.client,
          service: this.options.service,
          signal: entry.abort.signal,
        });
        entry.projection = await NativeHistoryProjection.open({
          ...common,
          directory: path.join(this.options.directory, "projection"),
          source: entry.source,
          outbox,
          client: this.options.client,
          signal: entry.abort.signal,
          project,
          rebase: (records) =>
            rebaseNativeHistoryProjector({
              binding,
              client: this.options.client,
              service: this.options.service,
              source: entry.source,
              signal: entry.abort.signal,
              project,
              through: records.at(-1)!,
            }),
        });
      }
      while (entry.dirty && !this.stopped) {
        entry.dirty = false;
        await entry.projection.drain();
        entry.failures = 0;
      }
    } catch (error) {
      if (!this.stopped) {
        entry.dirty = true;
        retry = Math.min(
          this.maxRetryDelayMs,
          this.retryDelayMs * 2 ** Math.min(entry.failures++, 32),
        );
        try {
          this.options.onError?.(error, structuredClone(entry.scope));
        } catch {
          /* Diagnostics cannot cancel recovery. */
        }
      }
    } finally {
      // A recovered durable stage (or empty source) may not call project at all.
      releaseRecovery?.();
      entry.running = undefined;
      this.schedule(entry, retry);
      this.settleFlush();
    }
  }

  private settleFlush() {
    if (
      this.recoveryPending ||
      this.recoveryTimer ||
      this.recoveryRunning ||
      [...this.entries.values()].some(
        (entry) => entry.dirty || entry.running || entry.timer,
      )
    )
      return;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  /** Call after closing source capture when a complete graceful drain is needed. */
  flush(): Promise<void> {
    if (this.stopped)
      return Promise.reject(
        new Error("Native history projection was stopped."),
      );
    return new Promise((resolve, reject) => {
      this.waiters.add({ resolve, reject });
      this.settleFlush();
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
    await this.stop();
  }
  /** Final worker teardown: abort transport, retain every unacknowledged stage,
   * and await in-flight I/O before the caller locks the encryption service. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.recoveryAbort.abort(
      new Error("Native history source recovery stopped."),
    );
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryPending = false;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.abort.abort(new Error("Native history projection worker stopped."));
    }
    for (const waiter of this.waiters)
      waiter.reject(
        new Error(
          "Native history projection stopped before confirming a drain.",
        ),
      );
    this.waiters.clear();
    await Promise.allSettled([
      ...(this.recoveryRunning ? [this.recoveryRunning] : []),
      ...[...this.entries.values()].flatMap((entry) =>
        entry.running ? [entry.running] : [],
      ),
    ]);
  }
}
