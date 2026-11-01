import { EncryptedNbtPageCache } from "../storage/cache.js";
import { NbtStorageError } from "../storage/types.js";
import { encodeIndexPage, decodeIndexPage, type IndexPage } from "./pages.js";

type Entry = { page: IndexPage; pins: number; dirty: boolean };
/** Conservative 64 KiB charge per decoded page, including JS object overhead. */
export class NbtIndexPager {
  private pages = new Map<string, Entry>();
  private peak = 0;
  constructor(
    private cache: EncryptedNbtPageCache,
    readonly maxPages = 64,
  ) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new NbtStorageError(
        "NBT index requires at least one bounded cache page.",
      );
  }
  get retainedPages() {
    return this.pages.size;
  }
  get peakPages() {
    return this.peak;
  }
  private async room() {
    while (this.pages.size >= this.maxPages) {
      const evict = [...this.pages].find(([, entry]) => entry.pins === 0);
      if (!evict)
        throw new NbtStorageError("NBT index page pin budget exceeded.");
      const [key, entry] = evict;
      await this.write(key, entry);
      this.pages.delete(key);
    }
  }
  private async write(key: string, entry: Entry) {
    if (entry.dirty) {
      const bytes = encodeIndexPage(entry.page);
      try {
        await this.cache.set(key, bytes);
        entry.dirty = false;
      } finally {
        bytes.fill(0);
      }
    }
  }
  async acquire(key: string, create?: IndexPage) {
    let entry = this.pages.get(key);
    if (entry) {
      this.pages.delete(key);
      this.pages.set(key, entry);
    } else {
      await this.room();
      let page = create;
      if (!page) {
        const bytes = await this.cache.get(key);
        if (!bytes)
          throw new NbtStorageError(
            "NBT index page is unavailable. Reopen the document.",
          );
        try {
          page = decodeIndexPage(bytes);
        } finally {
          bytes.fill(0);
        }
      }
      entry = { page, pins: 0, dirty: Boolean(create) };
      this.pages.set(key, entry);
      this.peak = Math.max(this.peak, this.pages.size);
    }
    entry.pins++;
    const held = entry;
    let released = false;
    return {
      page: entry.page,
      dirty: () => {
        held.dirty = true;
      },
      release: () => {
        if (!released) {
          released = true;
          held.pins--;
        }
      },
    };
  }
  async flush() {
    for (const [key, entry] of this.pages) await this.write(key, entry);
  }
  dispose() {
    this.pages.clear();
  }
}
