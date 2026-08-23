import { SerialTaskQueue } from "./serial-task-queue";

interface LifecycleEntry<TOwned> {
  controller: AbortController;
  generation: number;
  owned: TOwned | null;
  retirement: Promise<void> | null;
}

export async function retireAttachmentBestEffort(
  stopLocal: () => Promise<void>,
  releaseServer: () => Promise<void>,
): Promise<void> {
  try {
    await stopLocal();
  } catch {
    // Server release must still run when native shutdown rejects.
  }
  try {
    await releaseServer();
  } catch {
    // Cleanup is best-effort after both retirement steps were attempted.
  }
}

/**
 * Serializes ownership of side-effecting attachment creations.
 *
 * Creation is deliberately not cancellable: once it starts, its result is
 * claimed and retired before a replacement may be created. Cancellation is
 * reserved for preparation work that cannot create a server-side resource.
 */
export class SerializedAttachmentLifecycle<TOwned> {
  readonly #queue = new SerialTaskQueue();
  readonly #retireOwned: (owned: TOwned) => Promise<void>;
  #active: LifecycleEntry<TOwned> | null = null;
  #generation = 0;

  constructor(retireOwned: (owned: TOwned) => Promise<void>) {
    this.#retireOwned = retireOwned;
  }

  replace<TResult>(
    create: () => Promise<TOwned>,
    prepare: (owned: TOwned, signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult | null> {
    const generation = ++this.#generation;
    this.#abortActive("Attachment replaced.");

    return this.#queue.run(async () => {
      await this.#retireActive();
      if (generation !== this.#generation) return null;

      const entry: LifecycleEntry<TOwned> = {
        controller: new AbortController(),
        generation,
        owned: null,
        retirement: null,
      };
      this.#active = entry;

      try {
        // Do not pass an AbortSignal to this side-effecting creation. A late
        // result must be claimed so its server attachment can be released.
        entry.owned = await create();
        if (this.#isStale(entry)) {
          await this.#retireEntry(entry);
          return null;
        }

        const result = await prepare(entry.owned, entry.controller.signal);
        if (this.#isStale(entry)) {
          await this.#retireEntry(entry);
          return null;
        }
        return result;
      } catch (error) {
        const superseded = this.#isStale(entry);
        await this.#retireEntry(entry);
        if (superseded) return null;
        throw error;
      }
    });
  }

  retire(reason = "Attachment retired."): Promise<void> {
    this.#generation += 1;
    this.#abortActive(reason);
    return this.#queue.run(() => this.#retireActive());
  }

  #abortActive(reason: string): void {
    this.#active?.controller.abort(new DOMException(reason, "AbortError"));
  }

  #isStale(entry: LifecycleEntry<TOwned>): boolean {
    return (
      entry.controller.signal.aborted ||
      entry.generation !== this.#generation ||
      this.#active !== entry
    );
  }

  async #retireActive(): Promise<void> {
    if (this.#active) await this.#retireEntry(this.#active);
  }

  async #retireEntry(entry: LifecycleEntry<TOwned>): Promise<void> {
    entry.retirement ??= entry.owned
      ? this.#retireOwned(entry.owned)
      : Promise.resolve();
    try {
      await entry.retirement;
    } finally {
      if (this.#active === entry) this.#active = null;
    }
  }
}
