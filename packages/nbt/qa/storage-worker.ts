/// <reference lib="webworker" />
import {
  MemoryNbtIndex,
  NbtTag,
  JAVA_NBT,
  scanNbt,
  readNbtArrayPage,
  type NbtNode,
} from "../src/index";
import {
  openOpfsNbtStore,
  openIndexedNbtStore,
  createNbtPageCipher,
  EncryptedNbtPageCache,
  NbtByteSpool,
  NBT_PAGE_BYTES,
  openNbtPageStore,
  type NbtPageStore,
} from "../src/storage/index";
const worker = self as unknown as DedicatedWorkerGlobalScope;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
worker.onmessage = async (event) => {
  const cases: unknown[] = [];
  let stage = "start";
  try {
    for (const kind of event.data === "automatic"
      ? ["automatic"]
      : ["opfs", "indexeddb"]) {
      let selected = kind;
      let openingFailure: string | undefined;
      stage = kind + ":open";
      const id = crypto.randomUUID(),
        raw =
          kind === "automatic"
            ? await openNbtPageStore({
                factories: [
                  async () => {
                    try {
                      const store = await openOpfsNbtStore(id);
                      selected = "opfs";
                      return store;
                    } catch (error) {
                      openingFailure = String(error);
                      throw error;
                    }
                  },
                  async () => {
                    const store = await openIndexedNbtStore(id);
                    selected = "indexeddb";
                    return store;
                  },
                ],
              })
            : kind === "opfs"
              ? await openOpfsNbtStore(id)
              : await openIndexedNbtStore(id);
      let writes = 0,
        storedBytes = 0,
        maxRetained = 0,
        earlyAt: number | undefined;
      const store: NbtPageStore = {
        get: raw.get.bind(raw),
        keys: raw.keys.bind(raw),
        close: raw.close.bind(raw),
        async set(key, data) {
          writes++;
          storedBytes += data.length;
          check(
            data[0] === 1 && data.length <= NBT_PAGE_BYTES + 29,
            "invalid ciphertext page",
          );
          await raw.set(key, data);
        },
      };
      const cipher = await createNbtPageCipher("storage-QA/owner/file/version"),
        cache = new EncryptedNbtPageCache(store, cipher, 2 * NBT_PAGE_BYTES),
        spool = new NbtByteSpool(cache);
      try {
        class Index extends MemoryNbtIndex {
          override async put(node: NbtNode) {
            await super.put(node);
            if (
              node.type === NbtTag.ByteArray &&
              node.end === null &&
              earlyAt === undefined
            )
              earlyAt = spool.available;
          }
        }
        const index = new Index(),
          scan = scanNbt(spool, JAVA_NBT, index);
        // 100 MiB real expanded data in disk storage; only a two-page plaintext LRU.
        const size = 100 * 1024 ** 2,
          header = Uint8Array.from([
            10, 0, 0, 7, 0, 5, 97, 114, 114, 97, 121, 6, 64, 0, 0,
          ]);
        await spool.append(header);
        const chunk = new Uint8Array(NBT_PAGE_BYTES).fill(42);
        for (let offset = 0; offset < size; offset += chunk.length) {
          stage = kind + ":append:" + offset;
          await spool.append(chunk);
          maxRetained = Math.max(maxRetained, cache.retainedBytes);
          check(
            maxRetained <= 2 * NBT_PAGE_BYTES,
            "plaintext cache exceeded budget",
          );
          if (offset % (16 * 1024 ** 2) === 0)
            worker.postMessage({
              progress: true,
              kind,
              bytes: spool.available,
            });
        }
        await spool.append(Uint8Array.of(0));
        await spool.finish();
        const result = await scan,
          children = await index.children(result.root, 0, 1);
        check(
          result.nodes === 2 && result.bytes === size + header.length + 1,
          "incorrect indexed document",
        );
        check(
          earlyAt !== undefined && earlyAt < size,
          "array descriptor waited for entire document",
        );
        const tail = await readNbtArrayPage(
          spool,
          children[0]!,
          JAVA_NBT,
          size - 4,
          4,
        );
        check(
          tail.every((value) => value === 42),
          "array tail changed during encrypted paging",
        );
        const ciphertext = (await raw.get("bytes-0"))!;
        check(
          ciphertext.length === NBT_PAGE_BYTES + 29 && ciphertext[0] === 1,
          "plaintext persisted instead of ciphertext",
        );
        cases.push({
          kind,
          selected,
          openingFailure,
          expandedBytes: spool.size,
          nodes: result.nodes,
          descriptorAt: earlyAt,
          cacheBudget: cache.budgetBytes,
          maxRetained,
          writes,
          storedBytes,
        });
      } finally {
        await spool.close();
      }
    }
    if (event.data === "automatic") {
      worker.postMessage({ ok: true, cases });
      return;
    }
    const first = await openOpfsNbtStore(crypto.randomUUID()),
      second = await openIndexedNbtStore(crypto.randomUUID());
    let count = 0;
    const failing: NbtPageStore = {
      get: first.get.bind(first),
      keys: first.keys.bind(first),
      close: first.close.bind(first),
      async set(key, data) {
        if (++count > 1)
          throw new DOMException("simulated full disk", "QuotaExceededError");
        await first.set(key, data);
      },
    };
    const backing = await openNbtPageStore({
        factories: [async () => failing, async () => second],
      }),
      cipher = await createNbtPageCipher("fallback-QA"),
      cache = new EncryptedNbtPageCache(backing, cipher, 0);
    try {
      await cache.set("first", Uint8Array.of(1, 2));
      await cache.set("second", Uint8Array.of(3, 4));
      check(
        (await cache.get("first"))?.[0] === 1 &&
          (await cache.get("second"))?.[0] === 3,
        "migration lost encrypted pages",
      );
      cases.push({ kind: "opfs-write-failure-to-indexeddb", ok: true });
    } finally {
      await cache.close();
    }
    worker.postMessage({ ok: true, cases });
  } catch (error) {
    worker.postMessage({
      ok: false,
      cases,
      stage,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};
