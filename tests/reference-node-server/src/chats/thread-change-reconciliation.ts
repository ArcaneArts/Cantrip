import type { WorkerNotification } from "@cantrip/protocol";

export type ChatThreadChangeNotification = Extract<
  WorkerNotification,
  { type: "chat.thread.changed" }
>;

interface PendingThreadChange {
  changes: Set<ChatThreadChangeNotification["changes"][number]>;
  latestRevision: number;
  processedRevision: number;
  running: boolean;
}

const DEFAULT_TRACKED_THREAD_LIMIT = 4_096;

export class ChatThreadChangeReconciler {
  readonly #entries = new Map<string, PendingThreadChange>();
  readonly #limit: number;
  readonly #onError: (error: unknown, key: string) => void;

  constructor(
    onError: (error: unknown, key: string) => void = () => undefined,
    limit = DEFAULT_TRACKED_THREAD_LIMIT,
  ) {
    this.#onError = onError;
    this.#limit = limit;
  }

  schedule(
    key: string,
    notification: ChatThreadChangeNotification,
    reconcile: (observation: ChatThreadChangeNotification) => Promise<void>,
  ): boolean {
    let entry = this.#entries.get(key);
    if (entry && notification.revision <= entry.latestRevision) return false;
    if (!entry) {
      if (this.#entries.size >= this.#limit) {
        const evictable = [...this.#entries].find(
          ([, candidate]) => !candidate.running,
        );
        if (!evictable) return false;
        this.#entries.delete(evictable[0]);
      }
      entry = {
        changes: new Set(),
        latestRevision: 0,
        processedRevision: 0,
        running: false,
      };
      this.#entries.set(key, entry);
    } else {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    entry.latestRevision = notification.revision;
    for (const change of notification.changes) entry.changes.add(change);
    if (!entry.running) {
      entry.running = true;
      queueMicrotask(
        () => void this.#drain(key, entry!, notification, reconcile),
      );
    }
    return true;
  }

  clear(): void {
    this.#entries.clear();
  }

  async #drain(
    key: string,
    entry: PendingThreadChange,
    notification: ChatThreadChangeNotification,
    reconcile: (observation: ChatThreadChangeNotification) => Promise<void>,
  ): Promise<void> {
    try {
      while (
        this.#entries.get(key) === entry &&
        entry.processedRevision < entry.latestRevision
      ) {
        const revision = entry.latestRevision;
        const changes = [...entry.changes];
        entry.changes.clear();
        try {
          await reconcile({ ...notification, changes, revision });
        } catch (error) {
          this.#onError(error, key);
        }
        entry.processedRevision = revision;
      }
    } finally {
      entry.running = false;
      if (
        this.#entries.get(key) === entry &&
        entry.processedRevision < entry.latestRevision
      ) {
        entry.running = true;
        queueMicrotask(
          () => void this.#drain(key, entry, notification, reconcile),
        );
      }
    }
  }
}
