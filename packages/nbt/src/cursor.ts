import {
  NBT_CHUNK_BYTES,
  NbtError,
  assertRange,
  type NbtByteSource,
  type NbtEncoding,
  type NbtSpan,
} from "./types.js";

export class NbtCursor {
  position = 0;
  private buffer = new Uint8Array(0);
  private start = 0;
  constructor(
    readonly source: NbtByteSource,
    readonly encoding: NbtEncoding,
    readonly signal?: AbortSignal,
  ) {}
  async byte(): Promise<number> {
    this.signal?.throwIfAborted();
    if (
      this.position < this.start ||
      this.position >= this.start + this.buffer.length
    ) {
      this.start = this.position;
      this.buffer = (await this.source.read(
        this.position,
        NBT_CHUNK_BYTES,
        this.signal,
      )) as Uint8Array<ArrayBuffer>;
      if (this.buffer.length > NBT_CHUNK_BYTES)
        throw new NbtError(this.position, "Source exceeded requested range");
      if (!this.buffer.length)
        throw new NbtError(this.position, "Unexpected end of NBT");
    }
    return this.buffer[this.position++ - this.start]!;
  }
  async fixed(bytes: number, unsigned = false): Promise<number | bigint> {
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = await this.byte();
    const view = new DataView(data.buffer),
      little = this.encoding.endian !== "big";
    if (bytes === 1) return unsigned ? view.getUint8(0) : view.getInt8(0);
    if (bytes === 2)
      return unsigned ? view.getUint16(0, little) : view.getInt16(0, little);
    if (bytes === 4)
      return unsigned ? view.getUint32(0, little) : view.getInt32(0, little);
    return view.getBigInt64(0, little);
  }
  async varint(bits: 32 | 64, zigzag: boolean): Promise<bigint> {
    const offset = this.position,
      count = Math.ceil(bits / 7);
    let value = 0n;
    for (let i = 0; i < count; i++) {
      const byte = await this.byte();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) {
        if (value >= 1n << BigInt(bits))
          throw new NbtError(offset, "Varint exceeds its numeric type");
        return zigzag ? (value >> 1n) ^ -(value & 1n) : value;
      }
    }
    throw new NbtError(offset, "Unterminated varint");
  }
  async int(): Promise<number> {
    return this.encoding.endian === "little-varint"
      ? Number(await this.varint(32, true))
      : Number(await this.fixed(4));
  }
  async skip(length: number) {
    assertRange(this.position, length);
    this.signal?.throwIfAborted();
    const end = this.position + length;
    if (this.source.size !== undefined) {
      if (end > this.source.size)
        throw new NbtError(this.position, "Payload exceeds source length");
    } else if (
      length &&
      (await this.source.read(end - 1, 1, this.signal)).length !== 1
    )
      throw new NbtError(this.position, "Truncated payload");
    this.position = end;
  }
  async string(): Promise<NbtSpan> {
    const length =
      this.encoding.endian === "little-varint"
        ? Number(await this.varint(32, false))
        : Number(await this.fixed(2, true));
    const span = { offset: this.position, length };
    await this.skip(length);
    return span;
  }
}
export async function readNbtRange(
  source: NbtByteSource,
  span: NbtSpan,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertRange(span.offset, span.length);
  if (span.length > NBT_CHUNK_BYTES)
    throw new NbtError(span.offset, "Use bounded pages for byte ranges");
  const bytes = new Uint8Array(span.length);
  let at = 0;
  while (at < span.length) {
    signal?.throwIfAborted();
    const length = Math.min(NBT_CHUNK_BYTES, span.length - at);
    const chunk = await source.read(span.offset + at, length, signal);
    if (!chunk.length || chunk.length > length)
      throw new NbtError(span.offset + at, "Invalid source read length");
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
