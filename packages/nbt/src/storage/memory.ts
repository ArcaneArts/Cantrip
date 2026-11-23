import {
  NBT_MEMORY_BUDGET,
  NbtStorageError,
  pageKey,
  type NbtPageStore,
} from "./types.js";
/** Last-resort bounded ciphertext storage; it never silently evicts source bytes. */
export class MemoryNbtPageStore implements NbtPageStore {
  private pages = new Map<string, Uint8Array>();
  private used = 0;
  private closed = false;
  constructor(private budget = NBT_MEMORY_BUDGET) {}
  private check() {
    if (this.closed) throw new NbtStorageError("NBT page store is closed.");
  }
  async get(key: string) {
    this.check();
    return this.pages.get(key)?.slice();
  }
  async set(key: string, bytes: Uint8Array) {
    this.check();
    pageKey(key);
    const old = this.pages.get(key),
      cost = bytes.length + key.length * 2 + 256;
    const next =
      this.used - (old ? old.length + key.length * 2 + 256 : 0) + cost;
    if (next > this.budget)
      throw new DOMException(
        "NBT cache memory storage is full.",
        "QuotaExceededError",
      );
    this.pages.set(key, bytes.slice());
    this.used = next;
  }
  async *keys() {
    this.check();
    yield* this.pages.keys();
  }
  async close() {
    this.closed = true;
    this.pages.clear();
    this.used = 0;
  }
}
