import {
  NBT_MEMORY_BUDGET,
  NBT_PAGE_BYTES,
  NbtStorageError,
  type NbtPageCipher,
  type NbtPageStore,
} from "./types.js";

/** Bounded decrypted LRU. Callers own copies; eviction/close can safely zero ours. */
export class EncryptedNbtPageCache {
  private pages = new Map<string, Uint8Array>();
  private cost = 0;
  private closed = false;
  private tail = Promise.resolve();
  constructor(
    private store: NbtPageStore,
    private cipher: NbtPageCipher,
    readonly budgetBytes = NBT_MEMORY_BUDGET,
  ) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
      throw new NbtStorageError("Invalid NBT cache memory budget.");
  }
  get retainedBytes() {
    return this.cost;
  }
  get retainedPages() {
    return this.pages.size;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      this.check();
      return run();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private check() {
    if (this.closed) throw new NbtStorageError("NBT page cache is closed.");
  }
  private charge(key: string, bytes: Uint8Array) {
    return Math.max(bytes.length, key.length * 2 + 256);
  }
  private remember(key: string, bytes: Uint8Array) {
    const old = this.pages.get(key);
    if (old) {
      this.cost -= this.charge(key, old);
      old.fill(0);
      this.pages.delete(key);
    }
    const charge = this.charge(key, bytes);
    if (charge > this.budgetBytes) return;
    while (this.cost + charge > this.budgetBytes && this.pages.size) {
      const [first, value] = this.pages.entries().next().value!;
      this.pages.delete(first);
      this.cost -= this.charge(first, value);
      value.fill(0);
    }
    this.pages.set(key, bytes.slice());
    this.cost += charge;
  }
  get(key: string): Promise<Uint8Array | undefined> {
    return this.serial(async () => {
      const found = this.pages.get(key);
      if (found) {
        this.pages.delete(key);
        this.pages.set(key, found);
        return found.slice();
      }
      const record = await this.store.get(key);
      this.check();
      if (!record) return undefined;
      if (record.length > NBT_PAGE_BYTES + 29)
        throw new NbtStorageError(
          "Encrypted NBT cache page exceeds its byte budget.",
        );
      const value = await this.cipher.open(key, record);
      try {
        this.check();
        if (value.length > NBT_PAGE_BYTES)
          throw new NbtStorageError(
            "Decrypted NBT cache page exceeds its byte budget.",
          );
        this.remember(key, value);
        return value.slice();
      } finally {
        value.fill(0);
      }
    });
  }
  set(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > NBT_PAGE_BYTES)
      return Promise.reject(
        new NbtStorageError("NBT cache pages are limited to 64 KiB."),
      );
    const snapshot = bytes.slice();
    return this.serial(async () => {
      const record = await this.cipher.seal(key, snapshot);
      this.check();
      await this.store.set(key, record);
      this.check();
      this.remember(key, snapshot);
    }).finally(() => snapshot.fill(0));
  }
  async close(remove = true) {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    for (const bytes of this.pages.values()) bytes.fill(0);
    this.pages.clear();
    this.cost = 0;
    this.cipher.dispose?.();
    await this.store.close(remove);
  }
}
