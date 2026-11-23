import { NbtCursor, readNbtRange } from "./cursor.js";
import { decodeNbtString } from "./strings.js";
import {
  assertRange,
  NbtError,
  NbtTag,
  type NbtByteSource,
  type NbtEncoding,
  type NbtNode,
  type NbtScalar,
  type NbtSpan,
} from "./types.js";

/** A bounded preview; nextByte is at a complete character boundary. */
export async function readNbtText(
  source: NbtByteSource,
  span: NbtSpan,
  encoding: NbtEncoding,
  maxBytes = 65535,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new NbtError(span.offset, "Invalid string page size");
  let length = Math.min(span.length, maxBytes);
  const bytes = await readNbtRange(
    source,
    { offset: span.offset, length },
    signal,
  );
  if (length < span.length && length) {
    let start = length - 1;
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
    const first = bytes[start]!;
    const width =
      first < 0x80
        ? 1
        : (first & 0xe0) === 0xc0
          ? 2
          : (first & 0xf0) === 0xe0
            ? 3
            : encoding.strings === "utf8" && (first & 0xf8) === 0xf0
              ? 4
              : 1;
    if (start + width > length) length = start;
  }
  // A tiny requested page must still make progress through a multibyte character.
  if (!length && span.length)
    return readNbtText(
      source,
      span,
      encoding,
      Math.min(span.length, 4),
      signal,
    );
  return {
    text: decodeNbtString(
      bytes.subarray(0, length),
      encoding.strings,
      span.offset,
    ),
    truncated: length < span.length,
    nextByte: span.offset + length,
  };
}
export async function readNbtName(
  source: NbtByteSource,
  node: NbtNode,
  encoding: NbtEncoding,
  signal?: AbortSignal,
) {
  return node.name
    ? readNbtText(source, node.name, encoding, 65535, signal)
    : { text: "", truncated: false, nextByte: node.payload };
}
export async function readNbtScalar(
  source: NbtByteSource,
  node: NbtNode,
  encoding: NbtEncoding,
  signal?: AbortSignal,
): Promise<{ value: NbtScalar; truncated: boolean }> {
  if (node.type === NbtTag.String) {
    const result = await readNbtText(
      source,
      node.data!,
      encoding,
      65535,
      signal,
    );
    return { value: result.text, truncated: result.truncated };
  }
  if (node.type < NbtTag.Byte || node.type > NbtTag.Double)
    throw new NbtError(node.start, "Tag is not a scalar");
  const end = node.end;
  if (end === null || end < node.payload || end - node.payload > 10)
    throw new NbtError(node.start, "Scalar index record is incomplete");
  // A scalar may be the last available value in a paused growing spool. Never
  // wait for the cursor's ordinary 64 KiB structural lookahead to decode it.
  const scalarSource: NbtByteSource = {
    size: end,
    read(offset, length, requestSignal) {
      return source.read(
        offset,
        Math.min(length, Math.max(0, end - offset)),
        requestSignal,
      );
    },
  };
  const reader = new NbtCursor(scalarSource, encoding, signal);
  reader.position = node.payload;
  let value: NbtScalar;
  switch (node.type) {
    case NbtTag.Byte:
      value = await reader.fixed(1);
      break;
    case NbtTag.Short:
      value = await reader.fixed(2);
      break;
    case NbtTag.Int:
      value = await reader.int();
      break;
    case NbtTag.Long:
      value =
        encoding.endian === "little-varint"
          ? await reader.varint(64, true)
          : await reader.fixed(8);
      break;
    case NbtTag.Float:
    case NbtTag.Double: {
      const bytes = await readNbtRange(
        source,
        { offset: node.payload, length: node.type === NbtTag.Float ? 4 : 8 },
        signal,
      );
      const view = new DataView(bytes.buffer);
      value =
        node.type === NbtTag.Float
          ? view.getFloat32(0, encoding.endian !== "big")
          : view.getFloat64(0, encoding.endian !== "big");
      break;
    }
    default:
      throw new NbtError(node.start, "Tag is not a scalar");
  }
  return { value, truncated: false };
}
export async function readNbtArrayPage(
  source: NbtByteSource,
  node: NbtNode,
  encoding: NbtEncoding,
  offset: number,
  limit = 256,
  signal?: AbortSignal,
): Promise<Array<number | bigint>> {
  assertRange(offset, limit);
  if (limit > 4096)
    throw new NbtError(node.start, "Array pages are limited to 4096 elements");
  if (
    ![NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(
      node.type,
    ) ||
    !node.data ||
    node.length === undefined
  )
    throw new NbtError(node.start, "Tag is not a numeric array");
  const width =
    node.type === NbtTag.ByteArray ? 1 : node.type === NbtTag.IntArray ? 4 : 8;
  const count = Math.max(0, Math.min(limit, node.length - offset));
  const bytes = await readNbtRange(
    source,
    {
      offset: node.data.offset + Math.min(offset, node.length) * width,
      length: count * width,
    },
    signal,
  );
  const view = new DataView(bytes.buffer),
    little = encoding.endian !== "big";
  return Array.from({ length: count }, (_, i) =>
    width === 1
      ? view.getInt8(i)
      : width === 4
        ? view.getInt32(i * width, little)
        : view.getBigInt64(i * width, little),
  );
}
