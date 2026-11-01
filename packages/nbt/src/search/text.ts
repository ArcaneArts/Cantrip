import {
  NbtTag,
  type NbtNode,
  type NbtSpan,
  type NbtScalar,
} from "../types.js";
import type { NbtReadModel } from "../view/types.js";
import type { NbtSearchQuery } from "./types.js";

export const NBT_TYPE_NAMES = [
  "End",
  "Byte",
  "Short",
  "Int",
  "Long",
  "Float",
  "Double",
  "Byte Array",
  "String",
  "List",
  "Compound",
  "Int Array",
  "Long Array",
] as const;
export function nbtScalarText(value: NbtScalar) {
  return typeof value === "number" && Object.is(value, -0)
    ? "-0"
    : String(value);
}
export function literalMatcher(query: NbtSearchQuery) {
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  return (text: string) =>
    (query.caseSensitive ? text : text.toLowerCase()).includes(needle);
}
export function numericMatcher(text: string) {
  const query = text.trim(),
    integer = /^[+-]?[0-9]+$/u.test(query) ? BigInt(query) : undefined;
  const valid =
    /^[+-]?(?:Infinity|NaN|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)$/iu.test(
      query,
    );
  const expected = /^[+-]?nan$/iu.test(query)
    ? NaN
    : /^[+-]?infinity$/iu.test(query)
      ? query.startsWith("-")
        ? -Infinity
        : Infinity
      : Number(query);
  return (value: NbtScalar) =>
    typeof value === "bigint"
      ? integer !== undefined && value === integer
      : typeof value === "number" &&
        valid &&
        (integer !== undefined
          ? Number.isFinite(value) &&
            Number.isInteger(value) &&
            BigInt(value) === integer &&
            (value !== 0 || Object.is(value, expected))
          : !Number.isFinite(expected) && !/^[-+]?(Infinity|NaN)$/iu.test(query)
            ? false
            : Object.is(value, expected));
}
export function exactNumeric(value: NbtScalar, text: string) {
  return numericMatcher(text)(value);
}
export async function* textChunks(
  model: NbtReadModel,
  span: NbtSpan,
  signal: AbortSignal,
) {
  let at = span.offset;
  while (at < span.offset + span.length) {
    signal.throwIfAborted();
    const part = await model.text(
      { offset: at, length: span.offset + span.length - at },
      4096,
      signal,
    );
    if (part.nextByte <= at) throw new Error("NBT text page did not advance.");
    at = part.nextByte;
    yield part.text;
    if (at % (32 * 1024) < 4096) await model.work(signal);
  }
}
/** Match across page boundaries, including case mappings of split UTF-16 surrogate pairs. */
export async function streamMatches(
  input: AsyncIterable<string>,
  query: NbtSearchQuery,
  signal: AbortSignal,
) {
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  let tail = "",
    surrogate = "";
  const test = (part: string) => {
    const text = tail + (query.caseSensitive ? part : part.toLowerCase());
    const found = text.includes(needle);
    tail = needle.length > 1 ? text.slice(-(needle.length - 1)) : "";
    return found;
  };
  for await (const chunk of input) {
    signal.throwIfAborted();
    let part = surrogate + chunk;
    surrogate = "";
    const last = part.charCodeAt(part.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      surrogate = part.slice(-1);
      part = part.slice(0, -1);
    }
    if (test(part)) return true;
  }
  return surrogate ? test(surrogate) : false;
}
export async function* pathChunks(
  model: NbtReadModel,
  node: NbtNode,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const ancestors: NbtNode[] = [];
  let current: NbtNode | undefined = node;
  while (current) {
    signal.throwIfAborted();
    if (ancestors.length > 4096) throw new Error("NBT path depth exceeded.");
    ancestors.push(current);
    current =
      current.parent === null ? undefined : await model.getNode(current.parent);
  }
  for (const part of ancestors.reverse()) {
    if (part.parent !== null || part.name?.length) yield "/";
    if (part.name) {
      for await (const text of textChunks(model, part.name, signal))
        yield text.replaceAll("~", "~0").replaceAll("/", "~1");
    } else if (part.parent !== null) yield String(part.ordinal);
  }
}
export async function pathTail(
  model: NbtReadModel,
  node: NbtNode,
  query: NbtSearchQuery,
  signal: AbortSignal,
) {
  let tail = "",
    matched = false;
  const test = literalMatcher(query);
  for await (const part of pathChunks(model, node, signal)) {
    const current = tail + part;
    if (test(current)) matched = true;
    tail = current.slice(-Math.max(1, query.text.length));
  }
  return { matched, tail };
}
export const isArray = (node: NbtNode) =>
  [NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(node.type);
