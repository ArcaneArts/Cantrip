import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createNbtPageCipher,
  EncryptedNbtPageCache,
  MemoryNbtPageStore,
  openIndexedNbtStore,
  openNbtPageStore,
  openEncryptedNbtCache,
  NbtByteSpool,
  NBT_PAGE_BYTES,
  type NbtPageStore,
} from "../src/storage/index.js";
import {
  JAVA_NBT,
  MemoryNbtIndex,
  scanNbt,
  type NbtByteSource,
} from "../src/index.js";
const caches: EncryptedNbtPageCache[] = [];
afterEach(async () => {
  await Promise.allSettled(caches.splice(0).map((c) => c.close()));
});
async function fixture(
  budget = NBT_PAGE_BYTES,
  store: NbtPageStore = new MemoryNbtPageStore(16 * 1024 ** 2),
) {
  const cipher = await createNbtPageCipher("owner/server/document/revision");
  const cache = new EncryptedNbtPageCache(store, cipher, budget);
  caches.push(cache);
  return { cache, cipher, store };
}
it("persists authenticated ciphertext and binds it to page and document", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const cipher = await createNbtPageCipher("one-document", key),
    other = await createNbtPageCipher("another-document", key);
  const plain = new TextEncoder().encode("private NBT name and value");
  const encoded = await cipher.seal("page-0", plain);
  expect(new TextDecoder().decode(encoded)).not.toContain("private NBT");
  expect(await cipher.open("page-0", encoded)).toEqual(plain);
  await expect(cipher.open("page-1", encoded)).rejects.toThrow(
    "authentication",
  );
  await expect(other.open("page-0", encoded)).rejects.toThrow("authentication");
  const damaged = encoded.slice();
  damaged[damaged.length - 1]! ^= 1;
  await expect(cipher.open("page-0", damaged)).rejects.toThrow(
    "authentication",
  );
  cipher.dispose?.();
  await expect(cipher.open("page-0", encoded)).rejects.toThrow("closed");
});
it("keeps a bounded LRU and returns independently owned plaintext", async () => {
  const { cache, store } = await fixture();
  const first = new Uint8Array(NBT_PAGE_BYTES).fill(17),
    second = new Uint8Array(NBT_PAGE_BYTES).fill(29);
  await cache.set("first", first);
  const retained = (await cache.get("first"))!;
  await cache.set("second", second);
  expect(cache.retainedBytes).toBeLessThanOrEqual(NBT_PAGE_BYTES);
  expect(cache.retainedPages).toBe(1);
  expect(retained).toEqual(first);
  retained.fill(99);
  expect(await cache.get("first")).toEqual(first);
  expect((await store.get("first"))?.length).toBe(NBT_PAGE_BYTES + 29);
  await cache.close();
  expect(cache.retainedBytes).toBe(0);
  expect(first[0]).toBe(17);
  await expect(cache.get("first")).rejects.toThrow("closed");
});
it("uses committed IndexedDB transactions and paged key iteration", async () => {
  const store = await openIndexedNbtStore(
    crypto.randomUUID(),
    new IDBFactory(),
  );
  const { cache } = await fixture(0, store);
  for (let i = 0; i < 300; i++)
    await cache.set(
      `record-${String(i).padStart(3, "0")}`,
      Uint8Array.of(i & 255),
    );
  const keys: string[] = [];
  for await (const key of store.keys()) keys.push(key);
  expect(keys).toHaveLength(300);
  expect(keys[0]).toBe("record-000");
  expect(await cache.get("record-299")).toEqual(Uint8Array.of(299 & 255));
  expect(cache.retainedPages).toBe(0);
});
it("falls back after an actual write failure and migrates existing encrypted pages", async () => {
  const first = new MemoryNbtPageStore(),
    second = new MemoryNbtPageStore();
  let writes = 0;
  const failing = {
    ...first,
    get: first.get.bind(first),
    keys: first.keys.bind(first),
    close: first.close.bind(first),
    async set(key: string, bytes: Uint8Array) {
      if (++writes > 1) throw new DOMException("full", "QuotaExceededError");
      await first.set(key, bytes);
    },
  };
  const store = await openNbtPageStore({
    factories: [async () => failing, async () => second],
  });
  const { cache } = await fixture(0, store);
  await cache.set("one", Uint8Array.of(1));
  await cache.set("two", Uint8Array.of(2));
  expect(await cache.get("one")).toEqual(Uint8Array.of(1));
  expect(await cache.get("two")).toEqual(Uint8Array.of(2));
  expect(new TextDecoder().decode((await second.get("one"))!)).not.toContain(
    "private",
  );
  await expect(first.get("one")).rejects.toThrow("closed");
});
it("retains the original store if a fallback fills during migration", async () => {
  const first = new MemoryNbtPageStore();
  await first.set("one", new Uint8Array(40));
  const original = new DOMException("full", "QuotaExceededError");
  const failing: NbtPageStore = {
    get: first.get.bind(first),
    keys: first.keys.bind(first),
    close: first.close.bind(first),
    async set() {
      throw original;
    },
  };
  const store = await openNbtPageStore({
    factories: [async () => failing, async () => new MemoryNbtPageStore(1)],
  });
  await expect(store.set("two", Uint8Array.of(2))).rejects.toBe(original);
  expect(await store.get("one")).toEqual(new Uint8Array(40));
  await store.close();
});
it("attempts available storage instead of relying on a quota estimate", async () => {
  const store = await openNbtPageStore({
    factories: [
      async () => {
        throw new Error("OPFS unavailable");
      },
      () => openIndexedNbtStore(crypto.randomUUID(), new IDBFactory()),
    ],
  });
  await store.set("actual-write", Uint8Array.of(1, 2));
  expect(await store.get("actual-write")).toEqual(Uint8Array.of(1, 2));
  await store.close();
});
it("rejects missing/corrupted cache pages rather than inventing source bytes", async () => {
  const { cache, store } = await fixture(0);
  await cache.set("one", Uint8Array.of(4));
  const record = (await store.get("one"))!;
  record[15]! ^= 1;
  await store.set("one", record);
  await expect(cache.get("one")).rejects.toThrow("authentication");
  expect(await cache.get("missing")).toBeUndefined();
});
it("fences pending decrypts when the document closes", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const store = new MemoryNbtPageStore();
  const { cipher } = await fixture();
  await store.set("one", await cipher.seal("one", Uint8Array.of(1)));
  const slow: NbtPageStore = {
    get: async (key) => {
      await pending;
      return store.get(key);
    },
    set: store.set.bind(store),
    keys: store.keys.bind(store),
    close: store.close.bind(store),
  };
  const cache = new EncryptedNbtPageCache(slow, cipher);
  caches.push(cache);
  const read = cache.get("one");
  await Promise.resolve();
  const closing = cache.close();
  release();
  await expect(read).rejects.toThrow("closed");
  await closing;
});
it("spools more plaintext than its memory cache while retaining only bounded pages", async () => {
  const { cache } = await fixture(NBT_PAGE_BYTES);
  const spool = new NbtByteSpool(cache),
    size = 5 * 1024 ** 2 + 123;
  const tail = spool.read(size - 17, 17);
  for (let offset = 0; offset < size; offset += 17003) {
    const chunk = new Uint8Array(Math.min(17003, size - offset));
    for (let i = 0; i < chunk.length; i++)
      chunk[i] = ((offset + i) * 31 + 7) & 255;
    await spool.append(chunk);
    expect(cache.retainedBytes).toBeLessThanOrEqual(NBT_PAGE_BYTES);
  }
  await spool.finish();
  expect(spool.size).toBe(size);
  expect(await tail).toEqual(
    Uint8Array.from({ length: 17 }, (_, i) => ((size - 17 + i) * 31 + 7) & 255),
  );
  expect(await spool.read(NBT_PAGE_BYTES - 3, 9)).toEqual(
    Uint8Array.from(
      { length: 9 },
      (_, i) => ((NBT_PAGE_BYTES - 3 + i) * 31 + 7) & 255,
    ),
  );
  expect(await spool.read(size, 1)).toHaveLength(0);
});
it("serializes finish with already queued appends and rejects subsequent appends", async () => {
  const { cache } = await fixture();
  const spool = new NbtByteSpool(cache);
  const first = spool.append(Uint8Array.of(1, 2)),
    second = spool.append(Uint8Array.of(3, 4)),
    finish = spool.finish();
  await Promise.all([first, second, finish]);
  expect(await spool.read(0, 4)).toEqual(Uint8Array.of(1, 2, 3, 4));
  await expect(spool.append(Uint8Array.of(5))).rejects.toThrow("finishing");
});
it("settles waiting readers on cancellation and corruption", async () => {
  const { cache } = await fixture();
  const spool = new NbtByteSpool(cache),
    controller = new AbortController();
  const read = spool.read(100, 10, controller.signal);
  controller.abort(new Error("cancelled reader"));
  await expect(read).rejects.toThrow("cancelled reader");
  const next = spool.read(200, 10);
  spool.fail(new Error("corrupt compressed file"));
  await expect(next).rejects.toThrow("corrupt");
  await expect(spool.finish()).rejects.toThrow("corrupt");
});
it("cannot finish indexing before the compression stream is validated", async () => {
  const { cache } = await fixture();
  const spool = new NbtByteSpool(cache),
    data = new Uint8Array(NBT_PAGE_BYTES);
  data.set([7, 0, 0, 0, 0, 255, 249]);
  await spool.append(data);
  let atEof!: () => void;
  const observed = new Promise<void>((resolve) => (atEof = resolve));
  const source: NbtByteSource = {
    get size() {
      return spool.size;
    },
    read(offset, length, signal) {
      if (offset === NBT_PAGE_BYTES) atEof();
      return spool.read(offset, length, signal);
    },
  };
  const scan = scanNbt(source, JAVA_NBT, new MemoryNbtIndex());
  await observed;
  spool.fail(new Error("gzip checksum failed"));
  await expect(scan).rejects.toThrow("checksum");
});

it("removes the backing store if cache construction fails", async () => {
  const store = new MemoryNbtPageStore();
  await expect(
    openEncryptedNbtCache("scope", {
      budgetBytes: -1,
      factories: [async () => store],
    }),
  ).rejects.toThrow("budget");
  await expect(store.get("any")).rejects.toThrow("closed");
});
