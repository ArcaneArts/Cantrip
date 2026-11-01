import { assertRange, type NbtByteSource } from "../types.js";
import { EncryptedNbtPageCache } from "./cache.js";
import { NBT_PAGE_BYTES, NbtStorageError } from "./types.js";

/** Growing encrypted byte source. Readers wait for bytes or definitive EOF/error. */
export class NbtByteSpool implements NbtByteSource {
  private pending = new Uint8Array(NBT_PAGE_BYTES);
  private pendingLength = 0;
  private length = 0;
  private finished = false;
  private finishing = false;
  private failed = false;
  private failure: unknown;
  private writing = Promise.resolve();
  private finishPromise: Promise<void> | undefined;
  private waiters = new Set<() => void>();
  constructor(
    private cache: EncryptedNbtPageCache,
    private prefix = "bytes",
  ) {}
  get size() {
    return this.finished ? this.length : undefined;
  }
  get available() {
    return this.length;
  }
  private key(page: number) {
    return `${this.prefix}-${page}`;
  }
  private wake() {
    for (const notify of this.waiters) notify();
    this.waiters.clear();
  }
  private check() {
    if (this.failed) throw this.failure;
  }
  append(bytes: Uint8Array): Promise<void> {
    if (this.finishing)
      return Promise.reject(
        new NbtStorageError("NBT byte spool is finishing."),
      );
    const snapshot = bytes.slice();
    const operation = this.writing.then(async () => {
      let offset = 0;
      try {
        this.check();
        if (this.finished)
          throw new NbtStorageError("NBT byte spool is complete.");
        while (offset < snapshot.length) {
          const count = Math.min(
            this.pending.length - this.pendingLength,
            snapshot.length - offset,
          );
          this.pending.set(
            snapshot.subarray(offset, offset + count),
            this.pendingLength,
          );
          this.pendingLength += count;
          offset += count;
          if (this.pendingLength === NBT_PAGE_BYTES) {
            await this.cache.set(
              this.key(Math.floor(this.length / NBT_PAGE_BYTES)),
              this.pending,
            );
            this.check();
            this.pending.fill(0);
            this.pendingLength = 0;
          }
          this.length += count;
          this.wake();
        }
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        snapshot.fill(0);
      }
    });
    this.writing = operation.catch(() => {});
    return operation;
  }
  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishing = true;
    const operation = this.writing.then(async () => {
      this.check();
      if (this.finished) return;
      try {
        if (this.pendingLength)
          await this.cache.set(
            this.key(Math.floor(this.length / NBT_PAGE_BYTES)),
            this.pending.subarray(0, this.pendingLength),
          );
        this.check();
        this.finished = true;
        this.pending.fill(0);
        this.pendingLength = 0;
        this.wake();
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
    this.finishPromise = operation;
    this.writing = operation.catch(() => {});
    return operation;
  }
  fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.failure = error ?? new NbtStorageError("NBT byte spool failed.");
    this.pending.fill(0);
    this.wake();
  }
  private async wait(end: number, signal?: AbortSignal) {
    while (this.length < end && !this.finished) {
      this.check();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          this.waiters.delete(done);
          resolve();
        };
        const abort = () => {
          this.waiters.delete(done);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        this.waiters.add(done);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.check();
    signal?.throwIfAborted();
  }
  async read(offset: number, length: number, signal?: AbortSignal) {
    assertRange(offset, length);
    if (length > 256 * 1024)
      throw new NbtStorageError("NBT byte reads require bounded pages.");
    if (length === 0) return new Uint8Array(0);
    await this.wait(offset + length, signal);
    const count = Math.max(0, Math.min(length, this.length - offset)),
      result = new Uint8Array(count);
    let used = 0;
    try {
      while (used < count) {
        this.check();
        signal?.throwIfAborted();
        const position = offset + used,
          page = Math.floor(position / NBT_PAGE_BYTES),
          within = position % NBT_PAGE_BYTES;
        const partial =
          !this.finished && page === Math.floor(this.length / NBT_PAGE_BYTES);
        const data = partial
          ? this.pending.slice(0, this.pendingLength)
          : await this.cache.get(this.key(page));
        if (!data)
          throw new NbtStorageError(
            "NBT cache bytes were evicted. Reopen the source document.",
          );
        const size = Math.min(count - used, data.length - within);
        if (size <= 0) {
          data.fill(0);
          throw new NbtStorageError("NBT cache page is incomplete.");
        }
        result.set(data.subarray(within, within + size), used);
        used += size;
        data.fill(0);
      }
      this.check();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      result.fill(0);
      throw error;
    }
  }
  async close() {
    this.fail(new NbtStorageError("NBT byte spool is closed."));
    await this.writing;
    await this.cache.close();
  }
}
