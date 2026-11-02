import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createNbtPageCipher } from "../storage/cipher.js";
import { NBT_PAGE_BYTES, type NbtPageCipher } from "../storage/types.js";
import {
  assertRange,
  NbtError,
  type NbtByteSource,
  type NbtFormat,
} from "../types.js";
import type {
  NbtRecoveryDescriptor,
  NbtRecoveryEvent,
  NbtRecoveryStore,
} from "./types.js";

interface BlobReference {
  id: string;
  size: number;
  pages: number;
  sha256: string;
}
interface Head {
  version: 1;
  format: NbtFormat;
  baselineVersion: string;
  baseline: BlobReference;
  tail: BlobReference | null;
  events: number;
}
interface Entry {
  version: 1;
  sequence: number;
  previous: BlobReference | null;
  event: NbtRecoveryEvent;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
function reference(value: unknown): asserts value is BlobReference {
  const r = value as BlobReference;
  if (
    !r ||
    !/^[a-f0-9-]{36}$/u.test(r.id) ||
    !Number.isSafeInteger(r.size) ||
    r.size < 0 ||
    r.pages !== Math.ceil(r.size / NBT_PAGE_BYTES) ||
    !/^[a-f0-9]{64}$/u.test(r.sha256)
  )
    throw new NbtError(0, "Invalid NBT recovery byte reference");
}
function readHead(value: unknown): Head {
  const head = value as Head;
  if (
    !head ||
    head.version !== 1 ||
    !head.format ||
    !["big", "little", "little-varint"].includes(head.format.endian) ||
    !["utf8", "mutf8"].includes(head.format.strings) ||
    !["none", "gzip", "zlib"].includes(head.format.compression) ||
    typeof head.format.namedRoot !== "boolean" ||
    typeof head.format.bedrockLevel !== "boolean" ||
    typeof head.baselineVersion !== "string" ||
    !head.baselineVersion ||
    !Number.isSafeInteger(head.events) ||
    head.events < 0 ||
    (head.events === 0) !== (head.tail === null)
  )
    throw new NbtError(0, "Invalid NBT recovery journal header");
  reference(head.baseline);
  if (head.tail !== null) reference(head.tail);
  return head;
}

/** Durable encrypted original bytes plus a linked operation journal. Immutable
 * random page identities prevent a losing concurrent writer from overwriting
 * the winning branch. Only the authenticated CAS head makes new pages visible. */
export class NbtRecoveryJournal {
  private head: Head | null = null;
  private revision = 0;
  private closed = false;
  private pending = Promise.resolve();
  private closing?: Promise<void>;
  private constructor(
    private store: NbtRecoveryStore,
    private cipher: NbtPageCipher,
  ) {}
  static async open(store: NbtRecoveryStore, binding: string, key: CryptoKey) {
    const journal = new NbtRecoveryJournal(
      store,
      await createNbtPageCipher("recovery-v1/" + binding, key),
    );
    try {
      const record = await store.head();
      journal.revision = record.revision;
      if (record.bytes) {
        const plain = await journal.cipher.open(
          "head-" + record.revision,
          record.bytes,
        );
        try {
          journal.head = readHead(JSON.parse(decoder.decode(plain)));
        } finally {
          plain.fill(0);
        }
      }
      return journal;
    } catch (error) {
      await journal.close();
      throw error;
    }
  }
  private check(signal?: AbortSignal) {
    if (this.closed) throw new NbtError(0, "NBT recovery journal is closed");
    signal?.throwIfAborted();
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.pending.then(() => {
      this.check();
      return run();
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  descriptor(): NbtRecoveryDescriptor | null {
    this.check();
    const h = this.head;
    return h
      ? {
          format: { ...h.format },
          version: h.baselineVersion,
          size: h.baseline.size,
          sha256: h.baseline.sha256,
          events: h.events,
        }
      : null;
  }
  private async put(key: string, bytes: Uint8Array) {
    this.check();
    const encrypted = await this.cipher.seal(key, bytes);
    this.check();
    await this.store.put(key, encrypted);
  }
  private async page(ref: BlobReference, index: number) {
    this.check();
    const id = ref.id + ":" + index,
      encrypted = await this.store.get(id);
    if (!encrypted || encrypted.length > NBT_PAGE_BYTES + 29)
      throw new NbtError(0, "NBT recovery page is missing or oversized");
    const bytes = await this.cipher.open(id, encrypted);
    if (
      bytes.length !==
      Math.min(NBT_PAGE_BYTES, ref.size - index * NBT_PAGE_BYTES)
    ) {
      bytes.fill(0);
      throw new NbtError(0, "NBT recovery page has an invalid length");
    }
    return bytes;
  }
  private async writeBytes(
    stream: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    const ref: BlobReference = {
        id: crypto.randomUUID(),
        size: 0,
        pages: 0,
        sha256: "",
      },
      hash = sha256.create(),
      buffer = new Uint8Array(NBT_PAGE_BYTES);
    let used = 0;
    try {
      for await (const bytes of stream) {
        this.check(signal);
        assertRange(ref.size, bytes.length);
        hash.update(bytes);
        ref.size += bytes.length;
        let at = 0;
        while (at < bytes.length) {
          const take = Math.min(buffer.length - used, bytes.length - at);
          buffer.set(bytes.subarray(at, at + take), used);
          used += take;
          at += take;
          if (used === buffer.length) {
            await this.put(ref.id + ":" + ref.pages++, buffer);
            this.check(signal);
            buffer.fill(0);
            used = 0;
          }
        }
      }
      if (used)
        await this.put(ref.id + ":" + ref.pages++, buffer.subarray(0, used));
      ref.sha256 = bytesToHex(hash.digest());
      return ref;
    } finally {
      buffer.fill(0);
      hash.destroy();
    }
  }
  private async commit(head: Head | null) {
    this.check();
    let ciphertext: Uint8Array | null = null;
    if (head) {
      const bytes = encoder.encode(JSON.stringify(head));
      try {
        ciphertext = await this.cipher.seal(
          "head-" + (this.revision + 1),
          bytes,
        );
      } finally {
        bytes.fill(0);
      }
    }
    const revision = await this.store.commit(this.revision, ciphertext);
    // No cancellation check after the commit: the durable head is authoritative.
    this.revision = revision;
    this.head = head;
  }
  prepare(
    format: NbtFormat,
    version: string,
    bytes: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    return this.writeBaseline(format, version, bytes, signal, false);
  }
  /** Publish a fully written replacement in one authenticated CAS head update.
   * Until that update succeeds, the old baseline and events remain recoverable. */
  replace(
    format: NbtFormat,
    version: string,
    bytes: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    return this.writeBaseline(format, version, bytes, signal, true);
  }
  private writeBaseline(
    format: NbtFormat,
    version: string,
    bytes: AsyncIterable<Uint8Array>,
    signal: AbortSignal | undefined,
    replace: boolean,
  ) {
    const captured = { ...format };
    return this.serial(async () => {
      if (this.head && !replace) {
        if (
          this.head.baselineVersion !== version ||
          (Object.keys(captured) as Array<keyof NbtFormat>).some(
            (key) => this.head!.format[key] !== captured[key],
          )
        )
          throw new NbtError(0, "NBT recovery belongs to a different baseline");
        return;
      }
      if (!version)
        throw new NbtError(0, "NBT recovery requires a baseline version");
      const baseline = await this.writeBytes(bytes, signal);
      this.check(signal);
      await this.commit(
        readHead({
          version: 1,
          format: captured,
          baselineVersion: version,
          baseline,
          tail: null,
          events: 0,
        }),
      );
    });
  }
  append(event: NbtRecoveryEvent) {
    // Freeze synchronously; the caller can reuse form state after submission.
    const captured = structuredClone(event);
    return this.serial(async () => {
      const head = this.head;
      if (!head)
        throw new NbtError(
          0,
          "Prepare the NBT recovery baseline before editing",
        );
      if (head.events >= Number.MAX_SAFE_INTEGER)
        throw new NbtError(0, "NBT recovery sequence is exhausted");
      const value: Entry = {
          version: 1,
          sequence: head.events + 1,
          previous: head.tail,
          event: captured,
        },
        bytes = encoder.encode(JSON.stringify(value));
      try {
        if (bytes.length > 512 * 1024)
          throw new NbtError(
            0,
            "NBT recovery operation exceeds its bounded batch size",
          );
        const tail = await this.writeBytes(
          (async function* () {
            yield bytes;
          })(),
        );
        await this.commit({ ...head, tail, events: value.sequence });
      } finally {
        bytes.fill(0);
      }
    });
  }
  source(): NbtByteSource {
    this.check();
    const ref = this.head?.baseline;
    if (!ref) throw new NbtError(0, "NBT recovery has no baseline");
    return {
      size: ref.size,
      read: async (offset, length, signal) => {
        this.check(signal);
        assertRange(offset, length);
        if (length > 256 * 1024)
          throw new NbtError(
            offset,
            "NBT recovery reads require bounded pages",
          );
        const bytes = new Uint8Array(
          Math.min(length, Math.max(0, ref.size - offset)),
        );
        try {
          for (let at = 0; at < bytes.length;) {
            this.check(signal);
            const position = offset + at,
              page = await this.page(
                ref,
                Math.floor(position / NBT_PAGE_BYTES),
              );
            try {
              const start = position % NBT_PAGE_BYTES,
                count = Math.min(page.length - start, bytes.length - at);
              bytes.set(page.subarray(start, start + count), at);
              at += count;
            } finally {
              page.fill(0);
            }
          }
          return bytes;
        } catch (error) {
          bytes.fill(0);
          throw error;
        }
      },
    };
  }
  private async entry(ref: BlobReference): Promise<Entry> {
    reference(ref);
    if (ref.size > 512 * 1024)
      throw new NbtError(0, "NBT recovery event is oversized");
    const bytes = new Uint8Array(ref.size);
    try {
      for (let i = 0; i < ref.pages; i++) {
        const page = await this.page(ref, i);
        bytes.set(page, i * NBT_PAGE_BYTES);
        page.fill(0);
      }
      if (bytesToHex(sha256(bytes)) !== ref.sha256)
        throw new NbtError(0, "NBT recovery event checksum failed");
      const value = JSON.parse(decoder.decode(bytes)) as Entry;
      if (
        !value ||
        value.version !== 1 ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        !value.event
      )
        throw new NbtError(0, "NBT recovery event is invalid");
      if (value.previous !== null) reference(value.previous);
      return value;
    } finally {
      bytes.fill(0);
    }
  }
  async *events(signal?: AbortSignal): AsyncIterable<NbtRecoveryEvent> {
    this.check(signal);
    const head = this.head;
    if (!head) return;
    // Keep only byte references, not potentially large operation payloads.
    const references: BlobReference[] = [];
    let tail = head.tail;
    for (let sequence = head.events; sequence > 0; sequence--) {
      this.check(signal);
      if (!tail) throw new NbtError(0, "NBT recovery journal is truncated");
      references.push(tail);
      const entry = await this.entry(tail);
      if (entry.sequence !== sequence)
        throw new NbtError(0, "NBT recovery event sequence is invalid");
      tail = entry.previous;
    }
    if (tail !== null)
      throw new NbtError(0, "NBT recovery journal has an invalid origin");
    for (let i = references.length - 1; i >= 0; i--) {
      this.check(signal);
      yield (await this.entry(references[i]!)).event;
    }
  }
  clear() {
    return this.serial(() => this.commit(null));
  }
  /** After acquiring the actual origin-wide owner lock, fence any journal
   * instance left by the preceding renderer before opening the new worker. */
  claim() {
    return this.serial(async () => {
      await this.commit(this.head);
      return this.revision;
    });
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.pending;
      this.cipher.dispose?.();
      await this.store.close();
      this.head = null;
    })());
  }
}
