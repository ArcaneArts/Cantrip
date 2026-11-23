import {
  assertRange,
  NbtError,
  type NbtNode,
  type NbtIndexStore,
} from "../types.js";
import { EncryptedNbtPageCache } from "../storage/cache.js";
import { NbtStorageError } from "../storage/types.js";
import { INDEX_FANOUT } from "./pages.js";
import { NbtIndexPager } from "./pager.js";

function sequence(id: string) {
  if (!/^node:(0|[1-9][0-9]*)$/u.test(id))
    throw new NbtError(0, "Invalid indexed node identity");
  const value = Number(id.slice(5));
  assertRange(value, 0);
  return value;
}
function pack(n: NbtNode) {
  return [
    n.start,
    n.parent === null ? -1 : sequence(n.parent),
    n.ordinal,
    n.type,
    n.name?.offset ?? -1,
    n.name?.length ?? 0,
    n.payload,
    n.end ?? -1,
    n.childCount,
    n.elementType ?? -1,
    n.length ?? -1,
    n.declaredLength ?? NaN,
    n.data?.offset ?? -1,
    n.data?.length ?? 0,
  ];
}
function unpack(id: number, n: number[]): NbtNode {
  return {
    id: "node:" + id,
    start: n[0]!,
    parent: n[1] === -1 ? null : "node:" + n[1],
    ordinal: n[2]!,
    type: n[3]!,
    name: n[4] === -1 ? null : { offset: n[4]!, length: n[5]! },
    payload: n[6]!,
    end: n[7] === -1 ? null : n[7]!,
    childCount: n[8]!,
    ...(n[9] === -1 ? {} : { elementType: n[9]! }),
    ...(n[10] === -1 ? {} : { length: n[10]! }),
    ...(Number.isNaN(n[11]) ? {} : { declaredLength: n[11]! }),
    ...(n[12] === -1 ? {} : { data: { offset: n[12]!, length: n[13]! } }),
  };
}

/** Direct paged descriptors and sparse 256-child location checkpoints; no per-node Map. */
export class PagedNbtIndex implements NbtIndexStore {
  private tail = Promise.resolve();
  private closed = false;
  private count = 0;
  private constructor(
    private cache: EncryptedNbtPageCache,
    private pager: NbtIndexPager,
    private prefix: string,
  ) {}
  static async open(
    cache: EncryptedNbtPageCache,
    options: { prefix?: string; maxPages?: number } = {},
  ) {
    const prefix = options.prefix ?? "index";
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(prefix))
      throw new NbtStorageError("Invalid NBT index scope.");
    const pager = new NbtIndexPager(cache, options.maxPages),
      meta = await cache.get(prefix + "-meta"),
      index = new PagedNbtIndex(cache, pager, prefix);
    if (meta) {
      try {
        if (meta.length !== 16)
          throw new NbtStorageError("Invalid NBT index metadata.");
        const view = new DataView(
          meta.buffer,
          meta.byteOffset,
          meta.byteLength,
        );
        index.count = view.getFloat64(8, true);
        if (
          view.getUint32(0, true) !== 1 ||
          !Number.isSafeInteger(index.count) ||
          index.count < 0
        )
          throw new NbtStorageError("Invalid NBT index metadata.");
      } finally {
        meta.fill(0);
      }
    }
    return index;
  }
  get size() {
    return this.count;
  }
  get retainedPages() {
    return this.pager.retainedPages;
  }
  get peakPages() {
    return this.pager.peakPages;
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.tail.then(() => {
      if (this.closed) throw new NbtStorageError("NBT index is closed.");
      return run();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private nodeKey(id: number) {
    return this.prefix + "-nodes-" + Math.floor(id / INDEX_FANOUT);
  }
  private childKey(id: number, ordinal: number) {
    return (
      this.prefix + "-children-" + id + "-" + Math.floor(ordinal / INDEX_FANOUT)
    );
  }
  private async record(id: number) {
    if (id >= this.count) return undefined;
    const held = await this.pager.acquire(this.nodeKey(id));
    try {
      if (held.page.kind !== "nodes" || !held.page.records[id % INDEX_FANOUT])
        throw new NbtStorageError("NBT descriptor page is incomplete.");
      return held.page.records[id % INDEX_FANOUT]!.slice();
    } finally {
      held.release();
    }
  }
  private async write(id: number, record: number[], added = false) {
    const at = id % INDEX_FANOUT,
      held = await this.pager.acquire(
        this.nodeKey(id),
        added && at === 0 ? { kind: "nodes", records: [] } : undefined,
      );
    try {
      if (
        held.page.kind !== "nodes" ||
        held.page.records.length < (added ? at : at + 1)
      )
        throw new NbtStorageError("NBT descriptor page is incomplete.");
      held.page.records[at] = record.slice();
      held.dirty();
    } finally {
      held.release();
    }
  }
  put(node: NbtNode) {
    const snapshot = structuredClone(node);
    return this.serial(async () => {
      const id = sequence(snapshot.id);
      assertRange(snapshot.start, 0);
      assertRange(snapshot.ordinal, 0);
      assertRange(snapshot.childCount, 0);
      if (id > this.count)
        throw new NbtError(snapshot.start, "Node sequences must be contiguous");
      const previous = await this.record(id),
        values = pack(snapshot),
        added = id === this.count;
      if (
        previous &&
        (previous[0] !== values[0] ||
          previous[1] !== values[1] ||
          previous[2] !== values[2])
      )
        throw new NbtError(snapshot.start, "Node identity changed");
      const parent =
        snapshot.parent === null
          ? undefined
          : await this.record(sequence(snapshot.parent));
      if (snapshot.parent !== null && !parent)
        throw new NbtError(snapshot.start, "Indexed parent is missing");
      if (added && parent && snapshot.ordinal !== parent[8])
        throw new NbtError(snapshot.start, "Child ordinals must be contiguous");
      await this.write(id, values, added);
      if (added) {
        this.count++;
        if (parent) {
          const parentId = sequence(snapshot.parent!),
            at = snapshot.ordinal % INDEX_FANOUT;
          const held = await this.pager.acquire(
            this.childKey(parentId, snapshot.ordinal),
            at === 0 ? { kind: "children", offsets: [] } : undefined,
          );
          try {
            if (
              held.page.kind !== "children" ||
              held.page.offsets.length !== at
            )
              throw new NbtError(snapshot.start, "Invalid child checkpoint");
            held.page.offsets.push(id);
            held.dirty();
          } finally {
            held.release();
          }
          parent[8] = snapshot.ordinal + 1;
          await this.write(parentId, parent);
        }
      }
    });
  }
  get(id: string) {
    return this.serial(async () => {
      const number = sequence(id),
        value = await this.record(number);
      return value && unpack(number, value);
    });
  }
  children(parent: string, first: number, limit: number) {
    return this.serial(async () => {
      assertRange(first, limit);
      if (limit > 512)
        throw new NbtError(0, "Child pages are limited to 512 rows");
      const parentId = sequence(parent),
        record = await this.record(parentId);
      if (!record) return [];
      const end = Math.min(first + limit, record[8]!),
        result: NbtNode[] = [];
      for (let ordinal = first; ordinal < end;) {
        const held = await this.pager.acquire(this.childKey(parentId, ordinal));
        let ids: number[];
        try {
          if (held.page.kind !== "children")
            throw new NbtError(record[0]!, "Invalid child checkpoint");
          const at = ordinal % INDEX_FANOUT;
          ids = held.page.offsets.slice(
            at,
            at + Math.min(end - ordinal, INDEX_FANOUT - at),
          );
        } finally {
          held.release();
        }
        if (!ids.length)
          throw new NbtError(record[0]!, "Missing child checkpoint");
        for (const id of ids) {
          const value = await this.record(id);
          if (!value) throw new NbtError(record[0]!, "Missing indexed child");
          result.push(unpack(id, value));
        }
        ordinal += ids.length;
      }
      return result;
    });
  }
  checkpoint(parent: string, ordinal: number) {
    return this.serial(async () => {
      assertRange(ordinal, 0);
      const base = Math.floor(ordinal / INDEX_FANOUT) * INDEX_FANOUT,
        held = await this.pager.acquire(
          this.childKey(sequence(parent), ordinal),
        );
      let id: number;
      try {
        if (held.page.kind !== "children" || !held.page.offsets.length)
          throw new NbtError(0, "Missing child checkpoint");
        id = held.page.offsets[0]!;
      } finally {
        held.release();
      }
      const node = await this.record(id);
      if (!node) throw new NbtError(0, "Missing checkpoint node");
      return { ordinal: base, id: "node:" + id, offset: node[0]! };
    });
  }
  flush() {
    return this.serial(async () => {
      await this.pager.flush();
      const bytes = new Uint8Array(16),
        view = new DataView(bytes.buffer);
      view.setUint32(0, 1, true);
      view.setFloat64(8, this.count, true);
      try {
        await this.cache.set(this.prefix + "-meta", bytes);
      } finally {
        bytes.fill(0);
      }
    });
  }
  async dispose() {
    this.closed = true;
    await this.tail;
    this.pager.dispose();
  }
}
