import { NbtError, type NbtEncoding } from "./types.js";

export function decodeNbtString(
  bytes: Uint8Array,
  encoding: NbtEncoding["strings"],
  offset = 0,
): string {
  if (encoding === "utf8") {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new NbtError(offset, "Invalid UTF-8 string");
    }
  }
  const units: number[] = [];
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length;) {
    const at = i,
      first = bytes[i++]!;
    let value: number;
    if (first < 0x80) value = first;
    else {
      const count =
        (first & 0xe0) === 0xc0 ? 1 : (first & 0xf0) === 0xe0 ? 2 : -1;
      if (count < 0 || i + count > bytes.length)
        throw new NbtError(offset + at, "Invalid modified UTF-8 string");
      value = first & (count === 1 ? 0x1f : 0xf);
      for (let j = 0; j < count; j++) {
        const next = bytes[i++]!;
        if ((next & 0xc0) !== 0x80)
          throw new NbtError(
            offset + i - 1,
            "Invalid modified UTF-8 continuation",
          );
        value = (value << 6) | (next & 0x3f);
      }
    }
    units.push(value);
    if (units.length === 4096) {
      pieces.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  if (units.length) pieces.push(String.fromCharCode(...units));
  return pieces.join("");
}
export function encodeNbtString(
  text: string,
  encoding: NbtEncoding["strings"],
): Uint8Array {
  if (encoding === "utf8") {
    // TextEncoder replaces lone surrogates; never silently change an edited value.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw new NbtError(0, "Unpaired UTF-8 surrogate");
      } else if (c >= 0xdc00 && c <= 0xdfff)
        throw new NbtError(0, "Unpaired UTF-8 surrogate");
    }
    return new TextEncoder().encode(text);
  }
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    length += c > 0 && c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0 && c < 0x80) bytes[at++] = c;
    else if (c < 0x800) {
      bytes[at++] = 0xc0 | (c >> 6);
      bytes[at++] = 0x80 | (c & 63);
    } else {
      bytes[at++] = 0xe0 | (c >> 12);
      bytes[at++] = 0x80 | ((c >> 6) & 63);
      bytes[at++] = 0x80 | (c & 63);
    }
  }
  return bytes;
}
