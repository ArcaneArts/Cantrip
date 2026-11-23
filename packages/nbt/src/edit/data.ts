import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  assertRange,
  NbtError,
  type NbtSpan,
  type NbtByteSource,
  type NbtEncoding,
} from "../types.js";
import { readNbtText } from "../values.js";
import {
  NBT_PAGE_BYTES,
  openEncryptedNbtCache,
  type EncryptedNbtPageCache,
} from "../storage/index.js";
import { NbtSequence } from "./persistent.js";
import type { NbtSerializableModel } from "./types.js";
/** Append-only encrypted edit bytes. Undo roots retain spans/rope roots, never full value copies. */
export class NbtEditData {
  private ropes = new Map<string, NbtSequence<NbtSpan>>();
  private sequence = 0;
  private pending = new Uint8Array(NBT_PAGE_BYTES);
  private pendingLength = 0;
  private length = 0;
  private closed = false;
  private writing = Promise.resolve();
  private closing?: Promise<void>;
  private constructor(
    private baseline: NbtSerializableModel,
    private cache: EncryptedNbtPageCache,
  ) {}
  static async open(baseline: NbtSerializableModel, binding: string) {
    const cache = await openEncryptedNbtCache(binding + "/edits", {
      budgetBytes: 1024 ** 2,
    });
    return new NbtEditData(baseline, cache);
  }
  private check() {
    if (this.closed) throw new NbtError(0, "NBT edit bytes are closed");
  }
  append(bytes: Uint8Array) {
    const snapshot = bytes.slice();
    const operation = this.writing.then(async () => {
      const working = this.pending.slice();
      let used = this.pendingLength,
        position = this.length - used,
        at = 0;
      const offset = this.length;
      try {
        this.check();
        assertRange(offset, snapshot.length);
        // Keep the committed tail intact until every new full page is stored.
        // A quota/write failure must not poison earlier unsaved value spans.
        while (at < snapshot.length) {
          const count = Math.min(NBT_PAGE_BYTES - used, snapshot.length - at);
          working.set(snapshot.subarray(at, at + count), used);
          used += count;
          at += count;
          if (used === NBT_PAGE_BYTES) {
            await this.cache.set(
              "bytes-" + Math.floor(position / NBT_PAGE_BYTES),
              working,
            );
            this.check();
            working.fill(0);
            used = 0;
            position += NBT_PAGE_BYTES;
          }
        }
        this.check();
        this.pending.fill(0);
        this.pending.set(working.subarray(0, used));
        this.pendingLength = used;
        this.length += snapshot.length;
        return { source: "edit", offset, length: snapshot.length };
      } finally {
        working.fill(0);
        snapshot.fill(0);
      }
    });
    this.writing = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async read(span: NbtSpan, signal?: AbortSignal): Promise<Uint8Array> {
    this.check();
    signal?.throwIfAborted();
    assertRange(span.offset, span.length);
    if (span.length > 256 * 1024)
      throw new NbtError(0, "Edit byte reads require bounded pages");
    if (!span.source) return this.baseline.bytes(span, signal);
    if (span.source === "edit") {
      if (span.offset + span.length > this.length)
        throw new NbtError(0, "Edit span is unavailable");
      const bytes = new Uint8Array(span.length);
      let used = 0;
      try {
        while (used < bytes.length) {
          this.check();
          signal?.throwIfAborted();
          const position = span.offset + used,
            pageOffset = position % NBT_PAGE_BYTES,
            count = Math.min(bytes.length - used, NBT_PAGE_BYTES - pageOffset);
          if (position >= this.length - this.pendingLength)
            bytes.set(
              this.pending.subarray(pageOffset, pageOffset + count),
              used,
            );
          else {
            const page = await this.cache.get(
              "bytes-" + Math.floor(position / NBT_PAGE_BYTES),
            );
            if (!page)
              throw new NbtError(position, "Edited byte page is unavailable");
            try {
              if (page.length !== NBT_PAGE_BYTES)
                throw new NbtError(position, "Edited byte page is incomplete");
              bytes.set(page.subarray(pageOffset, pageOffset + count), used);
            } finally {
              page.fill(0);
            }
          }
          used += count;
        }
        return bytes;
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    }
    const rope = this.ropes.get(span.source);
    if (!rope || span.offset + span.length > rope.length)
      throw new NbtError(0, "String edit span is unavailable");
    const bytes = new Uint8Array(span.length);
    let at = 0;
    try {
      for (const piece of rope.slices(span.offset, span.length)) {
        const part = await this.read(
          {
            ...piece.data,
            offset: piece.data.offset + piece.offset,
            length: piece.count,
          },
          signal,
        );
        bytes.set(part, at);
        at += part.length;
        part.fill(0);
      }
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  text(
    span: NbtSpan,
    encoding: NbtEncoding,
    maxBytes: number,
    signal?: AbortSignal,
  ) {
    const source: NbtByteSource = {
      size: span.offset + span.length,
      read: (offset, length) =>
        this.read(
          {
            ...span,
            offset,
            length: Math.min(
              length,
              Math.max(0, span.offset + span.length - offset),
            ),
          },
          signal,
        ),
    };
    return readNbtText(source, span, encoding, maxBytes, signal);
  }
  private rope(span: NbtSpan) {
    const found = span.source && this.ropes.get(span.source);
    return found
      ? found
          .splice(
            span.offset + span.length,
            found.length - span.offset - span.length,
          )
          .splice(0, span.offset)
      : NbtSequence.from(span, span.length);
  }
  async splice(
    span: NbtSpan,
    offset: number,
    remove: number,
    insert: Uint8Array,
    signal: AbortSignal,
  ) {
    assertRange(offset, remove);
    if (offset + remove > span.length)
      throw new NbtError(0, "String splice exceeds value length");
    for (const boundary of [offset, offset + remove])
      if (boundary > 0 && boundary < span.length) {
        const bytes = await this.read(
          { ...span, offset: span.offset + boundary, length: 1 },
          signal,
        );
        try {
          if ((bytes[0]! & 0xc0) === 0x80)
            throw new NbtError(
              boundary,
              "String splice must use complete character boundaries",
            );
        } finally {
          bytes.fill(0);
        }
      }
    const replacement = await this.append(insert),
      next = this.rope(span).splice(
        offset,
        remove,
        NbtSequence.from<NbtSpan>(replacement, replacement.length),
      ),
      source = "text:" + ++this.sequence;
    this.ropes.set(source, next);
    return { source, offset: 0, length: next.length };
  }
  captureAllocations() {
    return this.sequence;
  }
  rollbackAllocations(after: number) {
    for (let i = after + 1; i <= this.sequence; i++)
      this.ropes.delete("text:" + i);
  }
  async journal(sequence: number, value: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    try {
      if (bytes.length > 512 * 1024)
        throw new NbtError(
          0,
          "Edit journal transaction exceeds its bounded size",
        );
      const pages = Math.ceil(bytes.length / NBT_PAGE_BYTES);
      for (let page = 0; page < pages; page++)
        await this.cache.set(
          "journal-" + sequence + "-" + page,
          bytes.subarray(page * NBT_PAGE_BYTES, (page + 1) * NBT_PAGE_BYTES),
        );
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          length: bytes.length,
          pages,
          sha256: bytesToHex(sha256(bytes)),
        }),
      );
      try {
        await this.cache.set("journal-" + sequence, manifest);
      } finally {
        manifest.fill(0);
      }
    } finally {
      bytes.fill(0);
    }
  }
  async readJournal(sequence: number): Promise<unknown | undefined> {
    const bytes = await this.cache.get("journal-" + sequence);
    if (!bytes) return undefined;
    let meta: {
      version: number;
      length: number;
      pages: number;
      sha256: string;
    };
    try {
      meta = JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      bytes.fill(0);
    }
    if (
      meta.version !== 1 ||
      !Number.isSafeInteger(meta.length) ||
      meta.length < 0 ||
      meta.length > 512 * 1024 ||
      meta.pages !== Math.ceil(meta.length / NBT_PAGE_BYTES)
    )
      throw new NbtError(0, "Edit journal manifest is invalid");
    const result = new Uint8Array(meta.length);
    try {
      for (let page = 0; page < meta.pages; page++) {
        const part = await this.cache.get("journal-" + sequence + "-" + page);
        if (
          !part ||
          part.length !==
            Math.min(NBT_PAGE_BYTES, meta.length - page * NBT_PAGE_BYTES)
        )
          throw new NbtError(0, "Edit journal transaction is incomplete");
        result.set(part, page * NBT_PAGE_BYTES);
        part.fill(0);
      }
      if (bytesToHex(sha256(result)) !== meta.sha256)
        throw new NbtError(0, "Edit journal checksum is invalid");
      return JSON.parse(new TextDecoder().decode(result));
    } finally {
      result.fill(0);
    }
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.writing;
      this.ropes.clear();
      this.pending.fill(0);
      this.pendingLength = 0;
      await this.cache.close();
    })());
  }
}
