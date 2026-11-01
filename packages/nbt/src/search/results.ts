import { assertRange } from "../types.js";
import {
  openEncryptedNbtCache,
  NBT_PAGE_BYTES,
  type EncryptedNbtPageCache,
} from "../storage/index.js";
import type { NbtSearchField, NbtSearchResult } from "./types.js";
const fields: NbtSearchField[] = ["name", "value", "type", "path"];
const PAGE = 256;
// node sequence, first element (-1 for a tag), run length, field mask, first result rank.
type RecordRow = [string, number, number, number, number];
/** Encrypted bounded result pages. Dense array matches use runs, not one object per element. */
export class NbtSearchResults {
  private pending: RecordRow[] = [];
  private pages = 0;
  private pendingBytes = 0;
  private total = 0;
  private pendingStart = 0;
  private constructor(private cache: EncryptedNbtPageCache) {}
  static async open(binding: string) {
    return new NbtSearchResults(
      await openEncryptedNbtCache(binding, { budgetBytes: 128 * 1024 }),
    );
  }
  get count() {
    return this.total;
  }
  append(
    nodeId: string,
    elementIndex: number | undefined,
    matched: NbtSearchField[],
  ) {
    return this.appendRange(nodeId, elementIndex, 1, matched);
  }
  async appendRange(
    nodeId: string,
    elementIndex: number | undefined,
    count: number,
    matched: NbtSearchField[],
  ) {
    if (!nodeId) throw new Error("Invalid NBT result identity.");
    assertRange(this.total, count);
    if (!count) return;
    const mask = matched.reduce(
        (bits, field) => bits | (1 << fields.indexOf(field)),
        0,
      ),
      last = this.pending.at(-1);
    if (
      elementIndex !== undefined &&
      last &&
      last[0] === nodeId &&
      last[1] >= 0 &&
      last[1] + last[2] === elementIndex &&
      last[3] === mask
    )
      last[2] += count;
    else {
      const cost = nodeId.length * 6 + 128;
      if (this.pending.length && this.pendingBytes + cost > 32768)
        await this.flush();
      this.pendingBytes += cost;
      this.pending.push([nodeId, elementIndex ?? -1, count, mask, this.total]);
    }
    this.total += count;
    if (this.pending.length === PAGE) await this.flush();
  }
  private async flush() {
    if (this.pending.length) {
      const bytes = new TextEncoder().encode(JSON.stringify(this.pending));
      if (bytes.length > 256 * 1024)
        throw new Error("NBT result identity exceeds the bounded page size.");
      try {
        const parts = Math.ceil(bytes.length / NBT_PAGE_BYTES);
        for (let part = 0; part < parts; part++)
          await this.cache.set(
            "matches-" + this.pages + "-" + part,
            bytes.subarray(part * NBT_PAGE_BYTES, (part + 1) * NBT_PAGE_BYTES),
          );
        const manifest = new TextEncoder().encode(
          JSON.stringify({ version: 1, length: bytes.length, parts }),
        );
        try {
          await this.cache.set("matches-" + this.pages, manifest);
        } finally {
          manifest.fill(0);
        }
        this.pages++;
        this.pending = [];
        this.pendingBytes = 0;
        this.pendingStart = this.total;
      } finally {
        bytes.fill(0);
      }
    }
  }
  private async page(index: number) {
    if (index === this.pages)
      return this.pending.map((row) => row.slice() as RecordRow);
    const manifest = await this.cache.get("matches-" + index);
    if (!manifest) throw new Error("NBT search results are unavailable.");
    let meta: { version: number; length: number; parts: number };
    try {
      meta = JSON.parse(new TextDecoder().decode(manifest));
    } finally {
      manifest.fill(0);
    }
    if (
      meta.version !== 1 ||
      !Number.isSafeInteger(meta.length) ||
      meta.length < 1 ||
      meta.length > 256 * 1024 ||
      meta.parts !== Math.ceil(meta.length / NBT_PAGE_BYTES)
    )
      throw new Error("Invalid NBT result manifest.");
    const bytes = new Uint8Array(meta.length);
    try {
      for (let part = 0; part < meta.parts; part++) {
        const page = await this.cache.get("matches-" + index + "-" + part);
        if (!page) throw new Error("NBT search result page is incomplete.");
        try {
          if (
            page.length !==
            Math.min(NBT_PAGE_BYTES, meta.length - part * NBT_PAGE_BYTES)
          )
            throw new Error("Invalid NBT result page size.");
          bytes.set(page, part * NBT_PAGE_BYTES);
        } finally {
          page.fill(0);
        }
      }
      const records = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as RecordRow[];
      if (!Array.isArray(records) || !records.length || records.length > PAGE)
        throw new Error("Invalid NBT result page.");
      return records;
    } finally {
      bytes.fill(0);
    }
  }
  private async locate(rank: number, signal?: AbortSignal) {
    if (rank >= this.pendingStart) return this.page(this.pages);
    let lo = 0,
      hi = this.pages - 1;
    while (lo <= hi) {
      signal?.throwIfAborted();
      const mid = Math.floor((lo + hi) / 2),
        records = await this.page(mid),
        last = records.at(-1)!;
      if (rank < records[0]![4]) hi = mid - 1;
      else if (rank >= last[4] + last[2]) lo = mid + 1;
      else return records;
    }
    throw new Error("NBT search result rank is unavailable.");
  }
  async read(
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NbtSearchResult[]> {
    assertRange(offset, limit);
    if (limit > 128)
      throw new Error("Search pages are limited to 128 results.");
    const end = Math.min(this.total, offset + limit),
      result: NbtSearchResult[] = [];
    for (let rank = offset; rank < end;) {
      signal?.throwIfAborted();
      const records = await this.locate(rank, signal);
      let advanced = false;
      for (const row of records) {
        if (rank < row[4] || rank >= row[4] + row[2]) continue;
        const count = Math.min(end - rank, row[4] + row[2] - rank);
        for (let i = 0; i < count; i++)
          result.push({
            id: "result:" + (rank + i),
            nodeId: row[0],
            ...(row[1] < 0 ? {} : { elementIndex: row[1] + rank + i - row[4] }),
            fields: fields.filter((_field, bit) =>
              Boolean(row[3] & (1 << bit)),
            ),
          });
        rank += count;
        advanced = true;
        if (rank >= end) break;
      }
      if (!advanced) throw new Error("NBT search result page is incomplete.");
    }
    return result;
  }
  close() {
    this.pending = [];
    return this.cache.close();
  }
}
