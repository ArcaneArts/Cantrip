import { NbtStorageError, type NbtPageStore } from "./types.js";

export async function openIndexedNbtStore(
  id: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<NbtPageStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("cantrip-nbt-cache-v1-" + id, 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore("pages");
    request.onerror = () => {
      failed = true;
      reject(request.error);
    };
    request.onblocked = () => {
      failed = true;
      reject(new NbtStorageError("NBT cache database is blocked."));
    };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
  });
  let closed = false;
  function run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    if (closed)
      return Promise.reject(new NbtStorageError("NBT page store is closed."));
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pages", mode),
        request = operation(tx.objectStore("pages"));
      let value: T;
      request.onsuccess = () => {
        value = request.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(
          tx.error ??
            request.error ??
            new NbtStorageError("NBT cache transaction aborted."),
        );
    });
  }
  return {
    async get(key) {
      const value = await run("readonly", (store) => store.get(key));
      return value === undefined ? undefined : new Uint8Array(value);
    },
    async set(key, bytes) {
      await run("readwrite", (store) => store.put(bytes, key));
    },
    async *keys() {
      let after: IDBValidKey | undefined;
      for (;;) {
        const batch = await run("readonly", (store) =>
          store.getAllKeys(
            after === undefined
              ? undefined
              : IDBKeyRange.lowerBound(after, true),
            256,
          ),
        );
        for (const key of batch) {
          if (typeof key !== "string")
            throw new NbtStorageError("Invalid NBT cache key.");
          yield key;
        }
        if (batch.length < 256) return;
        after = batch.at(-1)!;
      }
    },
    async close(remove = true) {
      if (closed) return;
      closed = true;
      db.close();
      if (!remove) return;
      await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase(db.name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new NbtStorageError("NBT cache removal is blocked."));
      });
    },
  };
}
