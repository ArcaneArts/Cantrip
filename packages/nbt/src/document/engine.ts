import { copyNbtBytes } from "../source.js";
import { scanNbt } from "../scan.js";
import { transformNbtCompression, encodeNbtFile } from "../compression.js";
import { readNbtArrayPage, readNbtScalar, readNbtText } from "../values.js";
import {
  assertRange,
  NbtError,
  NbtTag,
  type NbtByteSource,
  type NbtNode,
  type NbtSpan,
  type NbtScanResult,
} from "../types.js";
import {
  openEncryptedNbtCache,
  NbtByteSpool,
  NBT_PAGE_BYTES,
  type EncryptedNbtPageCache,
} from "../storage/index.js";
import { PagedNbtIndex } from "../paged/index.js";
import { NbtWorkGate, waitNbtPromise } from "./gate.js";
import type {
  NbtDocumentOpenOptions,
  NbtDocumentSource,
  NbtDocumentStatus,
  NbtDisplayRow,
} from "./types.js";
import type { NbtSerializableModel } from "../edit/types.js";

export function nbtDocumentError(error: unknown) {
  return {
    message:
      error instanceof Error ? error.message : "NBT document operation failed.",
    ...(error instanceof NbtError ? { offset: error.offset } : {}),
  };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Owns the only parser, expanded spool, and paged index for one document revision. */
export class NbtDocumentEngine implements NbtSerializableModel {
  private controller = new AbortController();
  private gate = new NbtWorkGate();
  private spool: NbtByteSpool;
  private status: NbtDocumentStatus = {
    state: "indexing",
    root: null,
    availableBytes: 0,
    indexedBytes: 0,
    sourceBytesRead: 0,
    nodes: 0,
    cacheBytes: 0,
    indexPages: 0,
    peakIndexPages: 0,
  };
  private lastProgress = 0;
  private stopped = false;
  private result: NbtScanResult | undefined;
  private closing: Promise<void> | undefined;
  private revision = 0;
  private changes = new Set<() => void>();
  readonly completed: Promise<NbtScanResult>;
  private constructor(
    private source: NbtDocumentSource,
    private options: NbtDocumentOpenOptions,
    private cache: EncryptedNbtPageCache,
    private index: PagedNbtIndex,
    private onStatus: (status: NbtDocumentStatus) => void,
  ) {
    this.spool = new NbtByteSpool(cache);
    this.completed = this.run();
    void this.completed.catch(() => {});
  }
  static async open(
    source: NbtDocumentSource,
    options: NbtDocumentOpenOptions,
    onStatus: (status: NbtDocumentStatus) => void = () => {},
  ) {
    if (
      !["big", "little", "little-varint"].includes(options.format.endian) ||
      !["utf8", "mutf8"].includes(options.format.strings) ||
      typeof options.format.namedRoot !== "boolean" ||
      typeof options.format.bedrockLevel !== "boolean"
    )
      throw new NbtError(0, "Unsupported NBT encoding profile");
    const cache = await openEncryptedNbtCache(options.binding, {
      budgetBytes: options.cacheBytes ?? 4 * 1024 ** 2,
    });
    try {
      const index = await PagedNbtIndex.open(cache, {
        maxPages: options.indexPages ?? 64,
      });
      return new NbtDocumentEngine(source, options, cache, index, onStatus);
    } catch (error) {
      await cache.close();
      throw error;
    }
  }
  snapshot(): NbtDocumentStatus {
    return {
      ...this.status,
      format: { ...this.options.format },
      baselineVersion: this.options.version,
      availableBytes: this.spool.available,
      nodes: this.index.size,
      cacheBytes: this.cache.retainedBytes,
      indexPages: this.index.retainedPages,
      peakIndexPages: this.index.peakPages,
    };
  }
  get format() {
    return this.options.format;
  }
  bytes(span: NbtSpan, signal?: AbortSignal) {
    if (span.source)
      throw new NbtError(
        span.offset,
        "Baseline source does not own edited bytes",
      );
    this.check(signal);
    return this.spool.read(span.offset, span.length, signal);
  }
  async count(id: string) {
    const node = await this.getNode(id);
    if (!node || node.end === null)
      throw new NbtError(0, "Subtree index is incomplete");
    const first = Number(id.slice(5));
    let low = first + 1,
      high = this.index.size;
    while (low < high) {
      const mid = Math.floor((low + high) / 2),
        next = await this.getNode("node:" + mid);
      if (next && next.start < node.end) low = mid + 1;
      else high = mid;
    }
    return low - first;
  }
  async raw(
    id: string,
    part: "node" | "header" | "payload",
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const node = await this.getNode(id);
    if (!node || node.end === null) return undefined;
    const parent =
        node.parent === null ? undefined : await this.getNode(node.parent),
      header: "named" | "unnamed" | "none" =
        node.parent === null
          ? this.encoding.namedRoot
            ? "named"
            : "unnamed"
          : parent?.type === NbtTag.List
            ? "none"
            : "named";
    const offset = part === "payload" ? node.payload : node.start,
      end = part === "header" ? node.payload : node.end;
    return {
      model: this as NbtSerializableModel,
      span: { offset, length: end - offset },
      header,
    };
  }
  get encoding() {
    return this.options.format;
  }
  get binding() {
    return this.options.binding;
  }
  changeRevision() {
    return this.revision;
  }
  private notify() {
    this.revision++;
    for (const wake of this.changes) wake();
    this.changes.clear();
  }
  waitForChange(revision: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (revision !== this.revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        this.changes.delete(done);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        this.changes.delete(done);
        reject(signal.reason);
      };
      this.changes.add(done);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async work(signal: AbortSignal, background = true) {
    this.check(signal);
    if (background) await this.gate.wait(signal);
    await turn();
    this.check(signal);
  }
  async validated(signal: AbortSignal) {
    await waitNbtPromise(this.completed, signal);
  }
  getNode(id: string) {
    this.check();
    if (!id.startsWith("node:")) return Promise.resolve(undefined);
    return this.index.get(id);
  }
  getChildren(parent: string, offset: number, limit: number) {
    this.check();
    return this.index.children(parent, offset, limit);
  }
  async scanNodes(offset: number, limit: number) {
    assertRange(offset, limit);
    if (limit > 128)
      throw new NbtError(0, "Scan pages are limited to 128 nodes");
    const rows: NbtNode[] = [];
    for (let i = offset; i < Math.min(offset + limit, this.index.size); i++) {
      const node = await this.getNode("node:" + i);
      if (node) rows.push(node);
    }
    return rows;
  }
  text(span: NbtSpan, maxBytes: number, signal?: AbortSignal) {
    this.check(signal);
    return readNbtText(this.spool, span, this.options.format, maxBytes, signal);
  }
  scalar(node: NbtNode, signal?: AbortSignal) {
    this.check(signal);
    return readNbtScalar(this.spool, node, this.options.format, signal);
  }
  private emit(force = false) {
    const now = performance.now();
    if (force || now - this.lastProgress >= 100) {
      this.lastProgress = now;
      this.onStatus(this.snapshot());
    }
  }
  private async *input() {
    let at = 0;
    const signal = this.controller.signal;
    for (;;) {
      await this.gate.wait(signal);
      const bytes = await this.source.read(at, NBT_PAGE_BYTES, signal);
      signal.throwIfAborted();
      if (bytes.length > NBT_PAGE_BYTES)
        throw new NbtError(at, "Source exceeded requested range");
      if (!bytes.length) {
        if (this.source.size !== undefined && at !== this.source.size)
          throw new NbtError(at, "Truncated source snapshot");
        return;
      }
      at += bytes.length;
      this.status.sourceBytesRead = at;
      if (this.source.size !== undefined && at > this.source.size)
        throw new NbtError(at, "Source exceeded snapshot length");
      yield bytes.slice();
    }
  }
  private async run() {
    const signal = this.controller.signal;
    const producer = (async () => {
      try {
        let pages = 0;
        for await (const bytes of transformNbtCompression(
          this.input(),
          this.options.format.compression,
          true,
          { signal, fallback: this.options.fallbackCompression },
        )) {
          try {
            for (let at = 0; at < bytes.length; at += NBT_PAGE_BYTES) {
              await this.gate.wait(signal);
              await this.spool.append(bytes.subarray(at, at + NBT_PAGE_BYTES));
              this.emit();
              if (++pages % 16 === 0) await turn();
            }
          } finally {
            bytes.fill(0);
          }
        }
        await this.spool.finish();
      } catch (error) {
        this.spool.fail(error);
        throw error;
      }
    })();
    const scanner = scanNbt(
      this.spool,
      this.options.format,
      {
        put: async (node) => {
          await this.index.put(node);
          this.notify();
          if (node.parent === null && this.status.root === null) {
            this.status.root = node.id;
            this.emit(true);
          }
        },
        get: this.index.get.bind(this.index),
        children: this.index.children.bind(this.index),
      },
      {
        signal,
        onProgress: (progress) => {
          this.status.indexedBytes = progress.bytes;
          this.emit();
        },
        yieldControl: async () => {
          await this.gate.wait(signal);
          await turn();
        },
      },
    );
    try {
      const [result] = await Promise.all([scanner, producer]);
      await this.index.flush();
      signal.throwIfAborted();
      this.result = result;
      this.status.state = "complete";
      this.status.indexedBytes = result.bytes;
      this.emit(true);
      this.notify();
      return result;
    } catch (error) {
      this.controller.abort(error);
      this.gate.setPaused(false);
      this.spool.fail(error);
      await Promise.allSettled([producer, scanner]);
      if (!this.stopped) {
        this.status.state = "error";
        this.status.error = nbtDocumentError(error);
        this.emit(true);
        this.notify();
      }
      throw error;
    }
  }
  setPaused(paused: boolean) {
    if (this.stopped) throw new NbtError(0, "NBT document is closed");
    this.gate.setPaused(paused);
    if (this.status.state === "indexing" || this.status.state === "paused") {
      this.status.state = paused ? "paused" : "indexing";
      this.emit(true);
    }
  }
  private check(signal?: AbortSignal) {
    if (this.stopped) throw new NbtError(0, "NBT document is closed");
    signal?.throwIfAborted();
  }
  async describe(node: NbtNode, signal?: AbortSignal): Promise<NbtDisplayRow> {
    this.check(signal);
    const row: NbtDisplayRow = { node, name: "", nameTruncated: false };
    try {
      if (node.name) {
        const label = await readNbtText(
          this.spool,
          node.name,
          this.options.format,
          512,
          signal,
        );
        row.name = label.text;
        row.nameTruncated = label.truncated;
      }
      if (node.type === NbtTag.String) {
        const text = await readNbtText(
          this.spool,
          node.data!,
          this.options.format,
          512,
          signal,
        );
        row.value = text.text;
        row.valueTruncated = text.truncated;
      } else if (node.type >= NbtTag.Byte && node.type <= NbtTag.Double) {
        const scalar = await readNbtScalar(
          this.spool,
          node,
          this.options.format,
          signal,
        );
        row.value = scalar.value;
        row.valueTruncated = false;
      }
    } catch (error) {
      this.check(signal);
      row.error = nbtDocumentError(error);
    }
    this.check(signal);
    return row;
  }
  async rows(
    parent: string | null,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    this.check(signal);
    assertRange(offset, limit);
    if (limit > 128)
      throw new NbtError(0, "Display pages are limited to 128 rows");
    let nodes: NbtNode[] = [];
    if (parent === null) {
      if (offset === 0 && limit && this.status.root) {
        const root = await this.index.get(this.status.root);
        if (root) nodes = [root];
      }
    } else nodes = await this.index.children(parent, offset, limit);
    const rows: NbtDisplayRow[] = [];
    for (const node of nodes) rows.push(await this.describe(node, signal));
    return rows;
  }
  async array(id: string, offset: number, limit: number, signal?: AbortSignal) {
    this.check(signal);
    const node = await this.index.get(id);
    if (!node) throw new NbtError(0, "Indexed node is unavailable");
    const result = await readNbtArrayPage(
      this.spool,
      node,
      this.options.format,
      offset,
      limit,
      signal,
    );
    this.check(signal);
    return result;
  }
  async *arrayBytes(
    id: string,
    offset: number,
    count: number,
    signal: AbortSignal,
  ) {
    this.check(signal);
    assertRange(offset, count);
    const node = await this.getNode(id);
    if (
      !node?.data ||
      node.length === undefined ||
      ![NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(
        node.type,
      ) ||
      offset + count > node.length
    )
      throw new NbtError(0, "Encoded array range is unavailable");
    const width =
      node.type === NbtTag.ByteArray
        ? 1
        : node.type === NbtTag.IntArray
          ? 4
          : 8;
    for (let at = 0; at < count * width; at += NBT_PAGE_BYTES) {
      const bytes = await this.bytes(
        {
          offset: node.data.offset + offset * width + at,
          length: Math.min(NBT_PAGE_BYTES, count * width - at),
        },
        signal,
      );
      try {
        yield bytes;
      } finally {
        bytes.fill(0);
      }
    }
  }
  async *serialize(original: boolean, signal?: AbortSignal) {
    this.check(signal);
    await waitNbtPromise(this.completed, signal);
    this.check(signal);
    if (original) {
      yield* copyNbtBytes(this.source, signal);
      return;
    }
    const skip = this.options.format.bedrockLevel ? 8 : 0,
      spool = this.spool;
    const payload: NbtByteSource = {
      size: this.result!.bytes - skip,
      read(offset, length, requestSignal) {
        return spool.read(offset + skip, length, requestSignal);
      },
    };
    yield* encodeNbtFile(payload, this.options.format, {
      levelVersion: this.result!.levelVersion,
      signal,
      fallback: this.options.fallbackCompression,
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.controller.abort(new NbtError(0, "NBT document is closed"));
    this.gate.setPaused(false);
    this.source.close?.();
    this.status.state = "closed";
    this.emit(true);
    this.notify();
    return (this.closing = (async () => {
      await this.completed.catch(() => {});
      await this.index.dispose();
      await this.spool.close();
    })());
  }
}
