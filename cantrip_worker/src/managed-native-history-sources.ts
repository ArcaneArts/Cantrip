import type { NativeHistoryBindingOpen } from "@cantrip/protocol";
import type { CodexRuntime } from "./codex/runtime.js";
import { NativeHistoryCapture } from "./native-history-capture.js";
import type { NativeHistoryCaptureOptions } from "./native-history-capture.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import { NativeHistorySourceJournal } from "./native-history-source-journal.js";

type Runtime = Pick<
  CodexRuntime,
  "observeNativeHistory" | "transportGeneration"
>;
type Provenance = NativeHistoryBindingOpen["provenance"];
type Scope = { chatId: string; threadId: string };
type Entry = Scope & {
  runtime: Runtime;
  capture: NativeHistoryCapture;
  provenance: Provenance;
  lifetime: AbortController;
  closing?: Promise<void>;
};

interface Options {
  directory: string;
  workerId: string;
  service: NativeHistoryEncryptionService;
  client: Pick<NativeHistoryClient, "open">;
  onError?: (
    error: unknown,
    context: Scope & {
      generation: string;
      phase: Parameters<NonNullable<NativeHistoryCaptureOptions["onError"]>>[1];
    },
  ) => void;
  onPersisted?: (
    journal: NativeHistorySourceJournal,
    scope: Scope & { bindingId: string },
  ) => void | Promise<void>;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  snapshotDelayMs?: number;
  /** Deadline of one history-binding HTTP attempt, never a native turn limit. */
  bindingTimeoutMs?: number;
}

/** Worker-owned observation across managed root transports. Subscription is
 * synchronous, before input; binding and storage run independently and retry
 * actual failures. No input, configuration, execution lane or CUA grant is owned
 * here. Retired captures drain their exact frames into the same durable source. */
export class ManagedNativeHistorySources {
  private readonly current = new Map<string, Entry>();
  private readonly entries = new Set<Entry>();
  private stopped = false;
  private readonly bindingTimeoutMs: number;

  constructor(private readonly options: Options) {
    this.bindingTimeoutMs = options.bindingTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.bindingTimeoutMs) ||
      this.bindingTimeoutMs < 1 ||
      this.bindingTimeoutMs > 2_147_483_647
    )
      throw new Error("Invalid native history binding request timeout.");
  }

  bind(input: Scope & { runtime: Runtime; provenance?: Provenance }) {
    if (this.stopped)
      throw new Error("Managed history capture has been stopped.");
    const key = JSON.stringify([
      this.options.service.serverIdentity(),
      this.options.service.ownerId(),
      this.options.workerId,
      input.chatId,
      input.threadId,
    ]);
    const previous = this.current.get(key);
    if (
      previous?.runtime === input.runtime &&
      previous.capture.generation === input.runtime.transportGeneration &&
      !previous.capture.signal.aborted
    ) {
      // An actual admitted start can establish historical ownership if current
      // routing changes before the initial binding request has succeeded.
      if (input.provenance)
        previous.provenance = structuredClone(input.provenance);
      return previous.capture;
    }
    if (previous) void this.retire(previous).catch(() => {});

    const scope = { chatId: input.chatId, threadId: input.threadId };
    const lifetime = new AbortController();
    let bindingId: string | undefined;
    let journal: NativeHistorySourceJournal | undefined;
    let entry!: Entry;
    const capture = new NativeHistoryCapture({
      runtime: input.runtime,
      threadId: input.threadId,
      retryDelayMs: this.options.retryDelayMs,
      maxRetryDelayMs: this.options.maxRetryDelayMs,
      snapshotDelayMs: this.options.snapshotDelayMs,
      journal: {
        append: async (frame) => {
          lifetime.signal.throwIfAborted();
          if (!bindingId) {
            const binding = await this.options.client.open(
              { ...scope, provenance: structuredClone(entry.provenance) },
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(this.bindingTimeoutMs),
              ]),
            );
            lifetime.signal.throwIfAborted();
            bindingId = binding.id;
          }
          if (!journal) {
            journal = await NativeHistorySourceJournal.open({
              directory: this.options.directory,
              workerId: this.options.workerId,
              service: this.options.service,
              ...scope,
              bindingId,
            });
          }
          lifetime.signal.throwIfAborted();
          return journal.append(frame);
        },
      },
      onPersisted: this.options.onPersisted
        ? () =>
            this.options.onPersisted!(journal!, {
              ...scope,
              bindingId: bindingId!,
            })
        : undefined,
      onError: (error, phase) =>
        this.options.onError?.(error, {
          ...scope,
          generation: capture.generation,
          phase,
        }),
    });
    entry = {
      ...scope,
      runtime: input.runtime,
      capture,
      lifetime,
      provenance: structuredClone(input.provenance ?? { kind: "current" }),
    };
    this.entries.add(entry);
    this.current.set(key, entry);
    capture.signal.addEventListener(
      "abort",
      () => {
        if (this.current.get(key) === entry) this.current.delete(key);
        void this.retire(entry).catch(() => {});
      },
      { once: true },
    );
    if (capture.signal.aborted) {
      this.current.delete(key);
      void this.retire(entry).catch(() => {});
    }
    return capture;
  }

  private retire(entry: Entry): Promise<void> {
    // Defer close until the promise is installed: close aborts the subscription
    // synchronously and its abort listener can enter this method again.
    return (entry.closing ??= Promise.resolve().then(async () => {
      try {
        await entry.capture.close();
      } finally {
        entry.lifetime.abort();
        this.entries.delete(entry);
      }
    }));
  }

  async flush() {
    await Promise.all([...this.entries].map((entry) => entry.capture.flush()));
  }

  /** Graceful detach retains retries until all accepted source frames are saved. */
  async close() {
    this.stopped = true;
    this.current.clear();
    await Promise.all([...this.entries].map((entry) => this.retire(entry)));
  }

  /** Final worker teardown only. Return unsaved counts, not a fictitious ACK. */
  stop() {
    this.stopped = true;
    const pending = [...this.entries].flatMap((entry) =>
      entry.capture.pendingRecords
        ? [
            {
              chatId: entry.chatId,
              threadId: entry.threadId,
              pendingRecords: entry.capture.pendingRecords,
            },
          ]
        : [],
    );
    for (const entry of this.entries) {
      entry.capture.stop();
      entry.lifetime.abort();
    }
    this.current.clear();
    this.entries.clear();
    return pending;
  }
}
