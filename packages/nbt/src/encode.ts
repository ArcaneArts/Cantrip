import { encodeNbtString } from "./strings.js";
import {
  NBT_CHUNK_BYTES,
  NbtError,
  NbtTag,
  assertTag,
  type NbtEncoding,
  type NbtEntry,
  type NbtValue,
} from "./types.js";

function integer(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new NbtError(0, "Integer exceeds tag range");
}
function variable(value: bigint, bits: 32 | 64, zigzag = true): Uint8Array {
  if (zigzag) {
    if (value < -(1n << BigInt(bits - 1)) || value >= 1n << BigInt(bits - 1))
      throw new NbtError(0, "Integer exceeds tag range");
    value = (value << 1n) ^ (value >> BigInt(bits - 1));
  } else if (value < 0n || value >= 1n << BigInt(bits))
    throw new NbtError(0, "Unsigned integer exceeds tag range");
  const result: number[] = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return Uint8Array.from(result);
}
export function nbtFixedInteger(
  value: number | bigint,
  width: 1 | 2 | 4 | 8,
  little: boolean,
  unsigned = false,
): Uint8Array {
  const bytes = new Uint8Array(width),
    view = new DataView(bytes.buffer);
  if (width === 8) {
    if (typeof value !== "bigint" || value < -(1n << 63n) || value >= 1n << 63n)
      throw new NbtError(0, "Long exceeds signed 64-bit range");
    view.setBigInt64(0, value, little);
  } else {
    if (typeof value !== "number")
      throw new NbtError(0, "Expected a numeric integer");
    integer(
      value,
      unsigned ? 0 : -(2 ** (width * 8 - 1)),
      unsigned ? 2 ** (width * 8) - 1 : 2 ** (width * 8 - 1) - 1,
    );
    if (width === 1)
      unsigned ? view.setUint8(0, value) : view.setInt8(0, value);
    else if (width === 2)
      unsigned
        ? view.setUint16(0, value, little)
        : view.setInt16(0, value, little);
    else
      unsigned
        ? view.setUint32(0, value, little)
        : view.setInt32(0, value, little);
  }
  return bytes;
}
interface Frame {
  tag: NbtValue;
  iterator: Iterator<NbtEntry | NbtValue | number | bigint>;
  count: number;
}
/** Encode new/edited subtrees. Existing ranges can be copied without re-encoding. */
function* parts(
  root: NbtEntry,
  encoding: NbtEncoding,
  signal?: AbortSignal,
): Generator<Uint8Array> {
  const little = encoding.endian !== "big",
    varints = encoding.endian === "little-varint";
  const stack: Frame[] = [],
    ancestors = new Set<NbtValue>();
  function* string(text: string) {
    const bytes = encodeNbtString(text, encoding.strings);
    yield varints
      ? variable(BigInt(bytes.length), 32, false)
      : nbtFixedInteger(bytes.length, 2, little, true);
    yield bytes;
  }
  const i32 = (value: number) => {
    integer(value, -(2 ** 31), 2 ** 31 - 1);
    return varints
      ? variable(BigInt(value), 32)
      : nbtFixedInteger(value, 4, little);
  };
  let next: NbtValue | undefined = root.tag;
  assertTag(next.type, 0);
  if (!next.type) throw new NbtError(0, "End cannot be a value");
  yield Uint8Array.of(next.type);
  if (encoding.namedRoot) yield* string(root.name);
  while (next || stack.length) {
    signal?.throwIfAborted();
    if (next) {
      const tag = next;
      next = undefined;
      assertTag(tag.type, 0);
      if (!tag.type) throw new NbtError(0, "End cannot be a value");
      switch (tag.type) {
        case NbtTag.Byte:
          yield nbtFixedInteger(tag.value, 1, little);
          break;
        case NbtTag.Short:
          yield nbtFixedInteger(tag.value, 2, little);
          break;
        case NbtTag.Int:
          yield i32(tag.value);
          break;
        case NbtTag.Long:
          yield varints
            ? variable(tag.value, 64)
            : nbtFixedInteger(tag.value, 8, little);
          break;
        case NbtTag.Float:
        case NbtTag.Double: {
          if (typeof tag.value !== "number")
            throw new NbtError(0, "Expected floating-point number");
          if (
            tag.type === NbtTag.Float &&
            Number.isFinite(tag.value) &&
            !Number.isFinite(Math.fround(tag.value))
          )
            throw new NbtError(0, "Float exceeds 32-bit range");
          const bytes = new Uint8Array(tag.type === NbtTag.Float ? 4 : 8),
            view = new DataView(bytes.buffer);
          if (tag.type === NbtTag.Float) view.setFloat32(0, tag.value, little);
          else view.setFloat64(0, tag.value, little);
          yield bytes;
          break;
        }
        case NbtTag.String:
          yield* string(tag.value);
          break;
        default: {
          if (
            tag.type === NbtTag.ByteArray ||
            tag.type === NbtTag.IntArray ||
            tag.type === NbtTag.LongArray
          ) {
            const width =
              tag.type === NbtTag.ByteArray
                ? 1
                : tag.type === NbtTag.IntArray
                  ? 4
                  : 8;
            const values = tag.value;
            const raw =
              (width === 1 &&
                (values instanceof Uint8Array ||
                  values instanceof Int8Array)) ||
              (width === 4 &&
                (values instanceof Int32Array ||
                  values instanceof Uint32Array)) ||
              (width === 8 &&
                (values instanceof BigInt64Array ||
                  values instanceof BigUint64Array));
            if (raw && ArrayBuffer.isView(values)) {
              integer(tag.length, 0, 2 ** 31 - 1);
              if (values.byteLength / width !== tag.length)
                throw new NbtError(
                  0,
                  "Container length does not match its elements",
                );
              yield i32(tag.length);
              const bytes = new Uint8Array(
                values.buffer,
                values.byteOffset,
                values.byteLength,
              );
              const hostLittle =
                new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
              if (width === 1 || little === hostLittle) yield bytes;
              else
                for (
                  let offset = 0;
                  offset < bytes.length;
                  offset += NBT_CHUNK_BYTES
                ) {
                  const output = bytes.slice(offset, offset + NBT_CHUNK_BYTES);
                  for (let i = 0; i < output.length; i += width)
                    output.subarray(i, i + width).reverse();
                  yield output;
                }
              break;
            }
          }
          if (ancestors.has(tag)) throw new NbtError(0, "Cyclic NBT subtree");
          ancestors.add(tag);
          if (tag.type === NbtTag.List) {
            assertTag(tag.elementType, 0);
            if (tag.length && tag.elementType === NbtTag.End)
              throw new NbtError(0, "A nonempty list cannot contain End");
            yield Uint8Array.of(tag.elementType);
          }
          if (tag.type !== NbtTag.Compound) {
            integer(tag.length, 0, 2 ** 31 - 1);
            yield i32(tag.length);
          }
          stack.push({ tag, iterator: tag.value[Symbol.iterator](), count: 0 });
        }
      }
    } else {
      const frame = stack.at(-1)!,
        entry = frame.iterator.next(),
        tag = frame.tag;
      if (entry.done) {
        if (
          tag.type !== NbtTag.Compound &&
          "length" in tag &&
          frame.count !== tag.length
        )
          throw new NbtError(0, "Container length does not match its elements");
        if (tag.type === NbtTag.Compound) yield Uint8Array.of(NbtTag.End);
        ancestors.delete(tag);
        stack.pop();
        continue;
      }
      frame.count++;
      if ("length" in tag && frame.count > tag.length)
        throw new NbtError(0, "Container contains too many elements");
      if (tag.type === NbtTag.Compound) {
        const child = entry.value as NbtEntry;
        assertTag(child.tag.type, 0);
        yield Uint8Array.of(child.tag.type);
        yield* string(child.name);
        next = child.tag;
      } else if (tag.type === NbtTag.List) {
        next = entry.value as NbtValue;
        if (next.type !== tag.elementType)
          throw new NbtError(
            0,
            "List element type does not match its declaration",
          );
      } else if (tag.type === NbtTag.ByteArray) {
        const value = entry.value as number;
        integer(value, -128, 127);
        yield Uint8Array.of(value & 255);
      } else if (tag.type === NbtTag.IntArray)
        yield nbtFixedInteger(entry.value as number, 4, little);
      else if (tag.type === NbtTag.LongArray)
        yield nbtFixedInteger(entry.value as bigint, 8, little);
      else throw new NbtError(0, "Tag is not a container");
    }
  }
}
export async function* encodeNbtPayload(
  root: NbtEntry,
  encoding: NbtEncoding,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(NBT_CHUNK_BYTES),
    used = 0;
  for (const part of parts(root, encoding, signal)) {
    let offset = 0;
    while (offset < part.length) {
      signal?.throwIfAborted();
      const count = Math.min(part.length - offset, buffer.length - used);
      buffer.set(part.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === buffer.length) {
        yield buffer;
        buffer = new Uint8Array(NBT_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}
