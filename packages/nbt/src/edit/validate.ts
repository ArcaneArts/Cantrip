import {
  NbtError,
  NbtTag,
  assertTag,
  type NbtEncoding,
  type NbtScalar,
} from "../types.js";
import { encodeNbtString } from "../strings.js";
export const nbtArray = (type: NbtTag) =>
  [NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(type);
export const nbtContainer = (type: NbtTag) =>
  type === NbtTag.Compound || type === NbtTag.List;
export const nbtArrayType = (type: NbtTag) =>
  type === NbtTag.ByteArray
    ? NbtTag.Byte
    : type === NbtTag.IntArray
      ? NbtTag.Int
      : NbtTag.Long;
export function nbtValueType(type: NbtTag) {
  assertTag(type, 0);
  if (type === NbtTag.End)
    throw new NbtError(0, "End is a structural marker, not a value");
}
export function nbtStringBytes(text: string, encoding: NbtEncoding) {
  const bytes = encodeNbtString(text, encoding.strings),
    max = encoding.endian === "little-varint" ? 2 ** 32 - 1 : 65535;
  if (bytes.length > max)
    throw new NbtError(0, "String exceeds its encoding's length field");
  return bytes;
}
export function nbtParseScalar(type: NbtTag, text: string): NbtScalar {
  if (type === NbtTag.String) return text;
  if (type >= NbtTag.Byte && type <= NbtTag.Long) {
    if (!/^[+-]?[0-9]+$/u.test(text.trim()))
      throw new NbtError(0, "Enter a decimal integer");
    const value = BigInt(text.trim()),
      bits =
        type === NbtTag.Byte
          ? 8
          : type === NbtTag.Short
            ? 16
            : type === NbtTag.Int
              ? 32
              : 64;
    if (value < -(1n << BigInt(bits - 1)) || value >= 1n << BigInt(bits - 1))
      throw new NbtError(0, "Integer exceeds tag range");
    return type === NbtTag.Long ? value : Number(value);
  }
  if (type !== NbtTag.Float && type !== NbtTag.Double)
    throw new NbtError(0, "Tag is not a scalar");
  const input = text.trim();
  if (
    !/^[+-]?(?:NaN|Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)$/iu.test(
      input,
    )
  )
    throw new NbtError(0, "Enter a floating-point value");
  const value = /^[+-]?nan$/iu.test(input)
    ? NaN
    : /^[+-]?infinity$/iu.test(input)
      ? input.startsWith("-")
        ? -Infinity
        : Infinity
      : Number(input);
  if (!Number.isFinite(value) && !/^[+-]?(?:NaN|Infinity)$/iu.test(input))
    throw new NbtError(0, "Floating-point value exceeds tag range");
  if (
    type === NbtTag.Float &&
    Number.isFinite(value) &&
    !Number.isFinite(Math.fround(value))
  )
    throw new NbtError(0, "Float exceeds 32-bit range");
  return type === NbtTag.Float ? Math.fround(value) : value;
}
