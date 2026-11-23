import { nbtFixedInteger, nbtVariableInteger } from "../encode.js";
import { transformNbtCompression } from "../compression.js";
import {
  NbtError,
  NbtTag,
  NBT_CHUNK_BYTES,
  type NbtSpan,
  type NbtFormat,
  type NbtEncoding,
} from "../types.js";
import type { NbtSerializableModel } from "./types.js";
import { nbtArray, nbtContainer } from "./validate.js";
const i32 = (value: number, encoding: NbtEncoding) =>
  encoding.endian === "little-varint"
    ? nbtVariableInteger(BigInt(value), 32)
    : nbtFixedInteger(value, 4, encoding.endian !== "big");
const textLength = (length: number, encoding: NbtEncoding) =>
  encoding.endian === "little-varint"
    ? nbtVariableInteger(BigInt(length), 32, false)
    : nbtFixedInteger(length, 2, encoding.endian !== "big", true);
async function* copy(
  model: NbtSerializableModel,
  span: NbtSpan,
  signal: AbortSignal,
) {
  for (let at = 0; at < span.length; at += NBT_CHUNK_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(NBT_CHUNK_BYTES, span.length - at),
      bytes = await model.bytes(
        { ...span, offset: span.offset + at, length },
        signal,
      );
    if (bytes.length !== length)
      throw new NbtError(
        span.offset + at,
        "Serialized source range is incomplete",
      );
    try {
      yield bytes;
    } finally {
      bytes.fill(0);
    }
  }
}
type Header = "named" | "unnamed" | "none";
type Task =
  | { kind: "node"; id: string; header: Header }
  | {
      kind: "children";
      id: string;
      offset: number;
      ids: string[];
      at: number;
      header: Header;
      end: boolean;
    };
/** Copy unchanged ranges; expand only edited containers. Explicit stack supports deep trees. */
export async function* nbtEditedPayload(
  model: NbtSerializableModel,
  root: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const encoding = model.encoding,
    little = encoding.endian !== "big",
    tasks: Task[] = [
      {
        kind: "node",
        id: root,
        header: encoding.namedRoot ? "named" : "unnamed",
      },
    ];
  let steps = 0;
  while (tasks.length) {
    signal.throwIfAborted();
    if (++steps % 128 === 0) await model.work(signal, false);
    const task = tasks.pop()!;
    if (task.kind === "children") {
      if (task.at >= task.ids.length) {
        const page = await model.getChildren(task.id, task.offset, 32);
        task.ids = page.map((node) => node.id);
        task.at = 0;
        task.offset += page.length;
        if (!page.length) {
          if (task.end) yield Uint8Array.of(NbtTag.End);
          continue;
        }
      }
      const id = task.ids[task.at++]!;
      tasks.push(task, { kind: "node", id, header: task.header });
      continue;
    }
    const node = await model.getNode(task.id);
    if (!node) throw new NbtError(0, "Serialized tag is unavailable");
    const raw = await model.raw(node.id, "node", signal);
    if (raw && raw.header === task.header) {
      yield* copy(raw.model, raw.span, signal);
      continue;
    }
    if (task.header !== "none") {
      const header = await model.raw(node.id, "header", signal);
      if (header && header.header === task.header)
        yield* copy(header.model, header.span, signal);
      else {
        yield Uint8Array.of(node.type);
        if (task.header === "named") {
          if (!node.name)
            throw new NbtError(0, "Named tag is missing its name");
          yield textLength(node.name.length, encoding);
          yield* copy(model, node.name, signal);
        }
      }
    }
    const payload = await model.raw(node.id, "payload", signal);
    if (payload) {
      yield* copy(payload.model, payload.span, signal);
      continue;
    }
    if (node.type >= NbtTag.Byte && node.type <= NbtTag.Double) {
      const { value } = await model.scalar(node, signal);
      if (node.type === NbtTag.Float || node.type === NbtTag.Double) {
        const bytes = new Uint8Array(node.type === NbtTag.Float ? 4 : 8),
          view = new DataView(bytes.buffer);
        if (node.type === NbtTag.Float)
          view.setFloat32(0, value as number, little);
        else view.setFloat64(0, value as number, little);
        yield bytes;
      } else if (node.type === NbtTag.Int) yield i32(value as number, encoding);
      else if (node.type === NbtTag.Long && encoding.endian === "little-varint")
        yield nbtVariableInteger(value as bigint, 64);
      else
        yield nbtFixedInteger(
          value as number | bigint,
          node.type === NbtTag.Byte ? 1 : node.type === NbtTag.Short ? 2 : 8,
          little,
        );
    } else if (node.type === NbtTag.String) {
      if (!node.data) throw new NbtError(0, "String bytes are unavailable");
      yield textLength(node.data.length, encoding);
      yield* copy(model, node.data, signal);
    } else if (nbtArray(node.type)) {
      yield i32(node.length!, encoding);
      if (model.arrayBytes) {
        let chunks = 0;
        for await (const bytes of model.arrayBytes(
          node.id,
          0,
          node.length!,
          signal,
        )) {
          signal.throwIfAborted();
          yield bytes;
          if (++chunks % 16 === 0) await model.work(signal, false);
        }
        continue;
      }
      const width =
        node.type === NbtTag.ByteArray
          ? 1
          : node.type === NbtTag.IntArray
            ? 4
            : 8;
      for (let at = 0; at < node.length!; at += 4096) {
        const values = await model.array(
            node.id,
            at,
            Math.min(4096, node.length! - at),
            signal,
          ),
          bytes = new Uint8Array(values.length * width),
          view = new DataView(bytes.buffer);
        for (let i = 0; i < values.length; i++) {
          if (width === 1) view.setInt8(i, values[i] as number);
          else if (width === 4)
            view.setInt32(i * 4, values[i] as number, little);
          else view.setBigInt64(i * 8, values[i] as bigint, little);
        }
        try {
          yield bytes;
        } finally {
          bytes.fill(0);
        }
        await model.work(signal, false);
      }
    } else if (nbtContainer(node.type)) {
      if (node.type === NbtTag.List) {
        yield Uint8Array.of(node.elementType!);
        yield i32(node.childCount, encoding);
      }
      tasks.push({
        kind: "children",
        id: node.id,
        offset: 0,
        ids: [],
        at: 0,
        header: node.type === NbtTag.Compound ? "named" : "none",
        end: node.type === NbtTag.Compound,
      });
    } else throw new NbtError(0, "End cannot be serialized as a value");
  }
}
async function* bounded(input: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  let pending = new Uint8Array(NBT_CHUNK_BYTES),
    used = 0;
  try {
    for await (const bytes of input) {
      let at = 0;
      while (at < bytes.length) {
        signal.throwIfAborted();
        const count = Math.min(bytes.length - at, pending.length - used);
        pending.set(bytes.subarray(at, at + count), used);
        used += count;
        at += count;
        if (used === pending.length) {
          yield pending;
          pending = new Uint8Array(NBT_CHUNK_BYTES);
          used = 0;
        }
      }
    }
    if (used) yield pending.slice(0, used);
  } finally {
    pending.fill(0);
  }
}
/** Bedrock's envelope needs a counted first pass; other profiles stream in one pass. */
export async function* serializeNbtEdits(
  model: NbtSerializableModel,
  format: NbtFormat,
  options: {
    signal?: AbortSignal;
    levelVersion?: number;
    fallback?: boolean;
  } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  await model.validated(signal);
  const root = model.snapshot().root;
  if (!root) throw new NbtError(0, "NBT document has no root");
  let size = 0;
  if (format.bedrockLevel)
    for await (const chunk of nbtEditedPayload(model, root, signal)) {
      size += chunk.length;
      if (size > 2 ** 32 - 1)
        throw new NbtError(
          0,
          "Bedrock payload exceeds its envelope length field",
        );
    }
  async function* payload() {
    if (format.bedrockLevel) {
      yield nbtFixedInteger(options.levelVersion ?? 10, 4, true, true);
      yield nbtFixedInteger(size, 4, true, true);
    }
    yield* nbtEditedPayload(model, root!, signal);
  }
  yield* transformNbtCompression(
    bounded(payload(), signal),
    format.compression,
    false,
    { signal, fallback: options.fallback },
  );
}
