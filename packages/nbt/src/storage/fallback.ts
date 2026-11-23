import { MemoryNbtPageStore } from "./memory.js";
import { openIndexedNbtStore } from "./indexeddb.js";
import { openOpfsNbtStore } from "./opfs.js";
import { NbtStorageError, type NbtPageStore } from "./types.js";

/** Actual creation/write failures select fallback storage; there is no quota preflight. */
export async function openNbtPageStore(
  options: {
    id?: string;
    memoryBytes?: number;
    factories?: Array<() => Promise<NbtPageStore>>;
  } = {},
): Promise<NbtPageStore> {
  const id = options.id ?? crypto.randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
    throw new NbtStorageError("Invalid NBT cache instance identifier.");
  const factories = options.factories ?? [
    () => openOpfsNbtStore(id),
    () => openIndexedNbtStore(id),
    async () => new MemoryNbtPageStore(options.memoryBytes),
  ];
  let current: NbtPageStore | undefined,
    index = -1,
    closed = false;
  let tail = Promise.resolve();
  async function next(after: number) {
    let error: unknown = new NbtStorageError(
      "No NBT cache storage is available.",
    );
    for (let i = after + 1; i < factories.length; i++) {
      try {
        return { store: await factories[i]!(), index: i };
      } catch (failure) {
        error = failure;
      }
    }
    throw error;
  }
  ({ store: current, index } = await next(index));
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(() => {
      if (closed) throw new NbtStorageError("NBT page store is closed.");
      return run();
    });
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    get(key) {
      return serial(() => current!.get(key));
    },
    set(key, bytes) {
      return serial(async () => {
        try {
          await current!.set(key, bytes);
          return;
        } catch (original) {
          let after = index;
          while (after < factories.length - 1) {
            let candidate: Awaited<ReturnType<typeof next>>;
            try {
              candidate = await next(after);
            } catch {
              break;
            }
            after = candidate.index;
            try {
              // Copy one encrypted page at a time. The original remains usable if
              // a fallback also fills up part way through migration.
              for await (const existing of current!.keys()) {
                const data = await current!.get(existing);
                if (!data)
                  throw new NbtStorageError(
                    "NBT cache page disappeared during migration.",
                  );
                await candidate.store.set(existing, data);
              }
              await candidate.store.set(key, bytes);
              const previous = current!;
              current = candidate.store;
              index = candidate.index;
              await previous.close(true).catch(() => {});
              return;
            } catch {
              await candidate.store.close(true).catch(() => {});
            }
          }
          throw original;
        }
      });
    },
    async *keys() {
      const snapshot = current!;
      for await (const key of snapshot.keys()) yield key;
    },
    async close(remove = true) {
      if (closed) return;
      closed = true;
      await tail;
      await current!.close(remove);
    },
  };
}
