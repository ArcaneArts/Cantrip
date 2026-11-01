import { NBT_PAGE_BYTES, NbtStorageError, pageKey } from "../storage/types.js";
import {
  NbtRecoveryConflict,
  type NbtRecoveryRecord,
  type NbtRecoveryStore,
} from "./types.js";

/** Durable recovery has no memory fallback: accepting an edit requires a real
 * committed write. Disposable parser caches still have their normal fallback. */
export async function openIndexedNbtRecovery(
  id: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<NbtRecoveryStore> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
    throw new NbtStorageError("Invalid NBT recovery identifier.");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("cantrip-protected-nbt-recovery-v1", 1);
    let failed = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore("heads");
      request.result.createObjectStore("pages");
    };
    request.onblocked = () => {
      failed = true;
      reject(new NbtStorageError("NBT recovery database is blocked."));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
  });
  let closed = false;
  db.onversionchange = () => {
    closed = true;
    db.close();
  };
  function run<T>(
    names: string[],
    mode: IDBTransactionMode,
    operation: (
      tx: IDBTransaction,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ) {
    if (closed)
      return Promise.reject(new NbtStorageError("NBT recovery is closed."));
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(names, mode, { durability: "strict" });
      let value: T, error: unknown;
      const fail = (failure: unknown) => {
        error = failure;
        tx.abort();
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(
          error ??
            tx.error ??
            new NbtStorageError("NBT recovery transaction aborted."),
        );
      tx.onerror = () => {
        error ??= tx.error;
      };
      try {
        operation(
          tx,
          (next) => {
            value = next;
          },
          fail,
        );
      } catch (failure) {
        fail(failure);
      }
    });
  }
  function record(value: unknown): NbtRecoveryRecord {
    if (value === undefined) return { revision: 0, bytes: null };
    const entry = value as NbtRecoveryRecord;
    if (
      !entry ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      (entry.bytes !== null && !(entry.bytes instanceof Uint8Array)) ||
      (entry.bytes && entry.bytes.length > NBT_PAGE_BYTES + 29)
    )
      throw new NbtStorageError("Invalid NBT recovery head.");
    return { revision: entry.revision, bytes: entry.bytes?.slice() ?? null };
  }
  return {
    head() {
      return run<NbtRecoveryRecord>(["heads"], "readonly", (tx, done, fail) => {
        const get = tx.objectStore("heads").get(id);
        get.onsuccess = () => {
          try {
            done(record(get.result));
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    commit(expectedRevision, bytes) {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER
      )
        return Promise.reject(
          new NbtStorageError("Invalid NBT recovery revision."),
        );
      if (bytes && bytes.length > NBT_PAGE_BYTES + 29)
        return Promise.reject(
          new NbtStorageError("NBT recovery head exceeds its page budget."),
        );
      const captured = bytes?.slice() ?? null;
      return new Promise<number>((resolve, reject) => {
        if (closed) {
          reject(new NbtStorageError("NBT recovery is closed."));
          return;
        }
        const tx = db.transaction(["heads", "pages"], "readwrite", {
          durability: "strict",
        });
        let failure: unknown;
        tx.onabort = () =>
          reject(
            failure ??
              tx.error ??
              new NbtStorageError("NBT recovery commit aborted."),
          );
        tx.oncomplete = () => resolve(expectedRevision + 1);
        const heads = tx.objectStore("heads"),
          get = heads.get(id);
        get.onsuccess = () => {
          try {
            if (record(get.result).revision !== expectedRevision)
              throw new NbtRecoveryConflict();
            heads.put({ revision: expectedRevision + 1, bytes: captured }, id);
            if (captured === null)
              tx.objectStore("pages").delete(
                IDBKeyRange.bound([id, ""], [id, "\uffff"]),
              );
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      });
    },
    get(key) {
      pageKey(key);
      return run<Uint8Array | undefined>(
        ["pages"],
        "readonly",
        (tx, done, fail) => {
          const get = tx.objectStore("pages").get([id, key]);
          get.onsuccess = () => {
            try {
              const value: unknown = get.result;
              if (
                value !== undefined &&
                (!(value instanceof Uint8Array) ||
                  value.length > NBT_PAGE_BYTES + 29)
              )
                throw new NbtStorageError("Invalid NBT recovery byte page.");
              done(value?.slice());
            } catch (error) {
              fail(error);
            }
          };
        },
      );
    },
    async put(key, bytes) {
      pageKey(key);
      if (bytes.length > NBT_PAGE_BYTES + 29)
        throw new NbtStorageError("NBT recovery page exceeds its byte budget.");
      const captured = bytes.slice();
      await run<void>(["pages"], "readwrite", (tx, done) => {
        tx.objectStore("pages").put(captured, [id, key]);
        done();
      });
    },
    async close() {
      closed = true;
      db.close();
    },
  };
}
