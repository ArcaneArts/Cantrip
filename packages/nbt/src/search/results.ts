import { assertRange } from "../types.js";
import {
  openEncryptedNbtCache,
  type EncryptedNbtPageCache,
} from "../storage/index.js";
import type { NbtSearchField, NbtSearchResult } from "./types.js";
const fields: NbtSearchField[] = ["name", "value", "type", "path"];
const PAGE = 256,
  STRIDE = 40;
// node sequence, first element (-1 for a tag), run length, field mask, first result rank.
type RecordRow = [number, number, number, number, number];
/** Encrypted bounded result pages. Dense array matches use runs, not one object per element. */
export class NbtSearchResults {
  private pending: RecordRow[] = [];
  private pages = 0;
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
    const sequence = Number(nodeId.slice(5));
    assertRange(sequence, 0);
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
      last[0] === sequence &&
      last[1] >= 0 &&
      last[1] + last[2] === elementIndex &&
      last[3] === mask
    )
      last[2] += count;
    else
      this.pending.push([
        sequence,
        elementIndex ?? -1,
        count,
        mask,
        this.total,
      ]);
    this.total += count;
    if (this.pending.length === PAGE) {
      const bytes = new Uint8Array(PAGE * STRIDE),
        view = new DataView(bytes.buffer);
      this.pending.forEach((row, i) =>
        row.forEach((value, j) =>
          view.setFloat64(i * STRIDE + j * 8, value, true),
        ),
      );
      try {
        await this.cache.set("matches-" + this.pages, bytes);
        this.pages++;
        this.pending = [];
        this.pendingStart = this.total;
      } finally {
        bytes.fill(0);
      }
    }
  }
  private async page(index: number) {
    if (index === this.pages)
      return this.pending.map((row) => row.slice() as RecordRow);
    const bytes = await this.cache.get("matches-" + index);
    if (!bytes || bytes.length !== PAGE * STRIDE)
      throw new Error("NBT search results are unavailable.");
    try {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      return Array.from(
        { length: PAGE },
        (_, i) =>
          Array.from({ length: 5 }, (_, j) =>
            view.getFloat64(i * STRIDE + j * 8, true),
          ) as RecordRow,
      );
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
            nodeId: "node:" + row[0],
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
