import { expect, it } from "vitest";
import { PagedNbtIndex } from "../src/paged/index.js";
import {
  createNbtPageCipher,
  EncryptedNbtPageCache,
  MemoryNbtPageStore,
} from "../src/storage/index.js";
import {
  JAVA_NBT,
  memoryNbtSource,
  NbtTag,
  scanNbt,
  type NbtNode,
} from "../src/index.js";

function node(start: number, parent: string | null, ordinal: number): NbtNode {
  return {
    id: "node:" + (parent === null ? 0 : ordinal + 1),
    start,
    parent,
    ordinal,
    type: NbtTag.Int,
    name: { offset: start + 1, length: 1 },
    payload: start + 4,
    end: start + 8,
    childCount: 0,
  };
}
async function fixture() {
  const store = new MemoryNbtPageStore(128 * 1024 ** 2),
    cipher = await createNbtPageCipher("test/account/document/revision"),
    cache = new EncryptedNbtPageCache(store, cipher, 0),
    index = await PagedNbtIndex.open(cache, { maxPages: 16 });
  return { store, cache, index };
}
it("spills descriptor pages and pages children after reopening", async () => {
  const { store, cache, index } = await fixture();
  try {
    const root = {
      ...node(0, null, 0),
      type: NbtTag.Compound,
      end: null,
      name: null,
    };
    await index.put(root);
    for (let i = 0; i < 50000; i++)
      await index.put(node(10 + i * 8, root.id, i));
    expect((await index.get(root.id))?.childCount).toBe(50000);
    expect(index.retainedPages).toBeLessThanOrEqual(16);
    expect(index.peakPages).toBeLessThanOrEqual(16);
    expect(await index.checkpoint(root.id, 49999)).toEqual({
      ordinal: 49920,
      id: "node:49921",
      offset: 10 + 49920 * 8,
    });
    root.end = 400011;
    root.childCount = 50000;
    await index.put(root);
    await index.flush();
    await index.dispose();
    const reopened = await PagedNbtIndex.open(cache, { maxPages: 16 });
    expect(reopened.size).toBe(50001);
    expect((await reopened.get(root.id))?.end).toBe(root.end);
    expect(await reopened.children(root.id, 49990, 512)).toEqual(
      Array.from({ length: 10 }, (_, i) =>
        node(10 + (49990 + i) * 8, root.id, 49990 + i),
      ),
    );
    let pages = 0;
    for await (const key of store.keys()) {
      const data = (await store.get(key))!;
      expect(data[0]).toBe(1);
      pages++;
    }
    expect(pages).toBeGreaterThan(300);
    await reopened.dispose();
  } finally {
    await index.dispose();
    await cache.close();
  }
}, 30000);
it("supports nonsequential locations, updates, duplicate names and split boundaries", async () => {
  const { cache, index } = await fixture();
  try {
    const root = {
      ...node(0, null, 0),
      type: NbtTag.Compound,
      end: null,
      name: null,
    };
    await index.put(root);
    for (let i = 0; i < 2000; i++) {
      const start = 10 + ((i * 991) % 2000) * 8;
      await index.put(node(start, root.id, i));
    }
    const page = await index.children(root.id, 250, 30);
    expect(page.map((n) => n.ordinal)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 250),
    );
    expect(page.map((n) => n.start)).toEqual(
      Array.from({ length: 30 }, (_, i) => 10 + (((i + 250) * 991) % 2000) * 8),
    );
    const existing = page[3]!;
    await index.put({ ...existing, end: existing.end! + 1 });
    expect(index.size).toBe(2001);
    await expect(index.put({ ...existing, ordinal: 9999 })).rejects.toThrow(
      "identity",
    );
    expect((await index.get(existing.id))?.ordinal).toBe(existing.ordinal);
    await expect(index.children(root.id, 0, 513)).rejects.toThrow("512");
  } finally {
    await index.dispose();
    await cache.close();
  }
}, 20000);
it("scans real NBT through the paged store and preserves provisional container counts", async () => {
  const { cache, index } = await fixture();
  try {
    const bytes = Uint8Array.from([
      10, 0, 0, 9, 0, 1, 108, 10, 0, 0, 0, 2, 3, 0, 1, 120, 0, 0, 0, 1, 0, 3, 0,
      1, 120, 0, 0, 0, 2, 0, 0,
    ]);
    const result = await scanNbt(memoryNbtSource(bytes), JAVA_NBT, index);
    expect(result.nodes).toBe(6);
    const [list] = await index.children(result.root, 0, 10);
    expect(list?.length).toBe(2);
    const items = await index.children(list!.id, 0, 10);
    expect(items).toHaveLength(2);
    for (const item of items)
      expect(await index.children(item.id, 0, 10)).toHaveLength(1);
  } finally {
    await index.dispose();
    await cache.close();
  }
});
it("preserves unusual negative list declarations and all descriptor spans", async () => {
  const { cache, index } = await fixture();
  try {
    const root: NbtNode = {
      ...node(0, null, 0),
      type: NbtTag.List,
      name: null,
      elementType: NbtTag.End,
      length: 0,
      declaredLength: -7,
      data: { offset: 7, length: 0 },
    };
    await index.put(root);
    await index.flush();
    await index.dispose();
    const reopened = await PagedNbtIndex.open(cache, { maxPages: 16 });
    expect(await reopened.get(root.id)).toEqual(root);
    await reopened.dispose();
  } finally {
    await cache.close();
  }
});
