import { NbtCursor } from "./cursor.js";
import {
  assertTag,
  NbtError,
  NbtTag,
  type NbtByteSource,
  type NbtEncoding,
  type NbtIndexStore,
  type NbtNode,
  type NbtScanResult,
  type NbtSpan,
} from "./types.js";

export interface NbtScanOptions {
  signal?: AbortSignal;
  maxDepth?: number;
  onProgress?(progress: { bytes: number; nodes: number }): void;
  yieldControl?(): Promise<void>;
}
interface Frame {
  node: NbtNode;
  remaining?: number;
}
/** Scan structure only. Names, values, and array elements remain byte-backed. */
export async function scanNbt(
  source: NbtByteSource,
  encoding: NbtEncoding,
  store: NbtIndexStore,
  options: NbtScanOptions = {},
): Promise<NbtScanResult> {
  if (encoding.bedrockLevel && encoding.endian !== "little")
    throw new NbtError(0, "Bedrock envelope requires little-endian NBT");
  const reader = new NbtCursor(source, encoding, options.signal);
  const stack: Frame[] = [];
  let nodes = 0,
    expectedEnd: number | undefined,
    levelVersion: number | undefined;
  if (encoding.bedrockLevel) {
    levelVersion = Number(await reader.fixed(4, true));
    expectedEnd = 8 + Number(await reader.fixed(4, true));
  }
  async function readNode(
    type: NbtTag,
    start: number,
    name: NbtSpan | null,
    parent: NbtNode | null,
  ): Promise<NbtNode> {
    assertTag(type, start);
    if (type === NbtTag.End) throw new NbtError(start, "End cannot be a value");
    const node: NbtNode = {
      id: `offset:${start}`,
      parent: parent?.id ?? null,
      ordinal: parent?.childCount ?? 0,
      type,
      name,
      start,
      payload: reader.position,
      end: null,
      childCount: 0,
    };
    if (parent) parent.childCount++;
    switch (type) {
      case NbtTag.Byte:
        await reader.skip(1);
        break;
      case NbtTag.Short:
        await reader.skip(2);
        break;
      case NbtTag.Int:
        if (encoding.endian === "little-varint") await reader.varint(32, true);
        else await reader.skip(4);
        break;
      case NbtTag.Long:
        if (encoding.endian === "little-varint") await reader.varint(64, true);
        else await reader.skip(8);
        break;
      case NbtTag.Float:
        await reader.skip(4);
        break;
      case NbtTag.Double:
        await reader.skip(8);
        break;
      case NbtTag.String:
        node.data = await reader.string();
        break;
      case NbtTag.ByteArray:
      case NbtTag.IntArray:
      case NbtTag.LongArray: {
        const length = await reader.int();
        if (length < 0)
          throw new NbtError(node.payload, "Negative array length");
        node.length = length;
        node.data = {
          offset: reader.position,
          length:
            length *
            (type === NbtTag.ByteArray ? 1 : type === NbtTag.IntArray ? 4 : 8),
        };
        // Publish the descriptor before waiting for a large decompression spool.
        // end=null remains provisional until the payload and entire stream validate.
        await store.put(node);
        await reader.skip(node.data.length);
        break;
      }
      case NbtTag.List: {
        const elementType = await reader.byte(),
          length = await reader.int();
        assertTag(elementType, node.payload);
        if (length > 0 && elementType === NbtTag.End)
          throw new NbtError(
            node.payload,
            "A nonempty list cannot contain End",
          );
        node.elementType = elementType;
        node.declaredLength = length;
        node.length = Math.max(0, length);
        stack.push({ node, remaining: node.length });
        break;
      }
      case NbtTag.Compound:
        stack.push({ node });
        break;
    }
    nodes++;
    if (type !== NbtTag.List && type !== NbtTag.Compound)
      node.end = reader.position;
    await store.put(node);
    if (stack.length > (options.maxDepth ?? 4096))
      throw new NbtError(start, "NBT nesting budget exceeded");
    return node;
  }
  const first = reader.position,
    rootType = await reader.byte();
  assertTag(rootType, first);
  const name = encoding.namedRoot ? await reader.string() : null;
  const root = await readNode(rootType, first, name, null);
  let checkpoint = 0;
  while (stack.length) {
    options.signal?.throwIfAborted();
    const frame = stack.at(-1)!;
    const start = reader.position;
    if (frame.remaining === undefined) {
      const type = await reader.byte();
      assertTag(type, start);
      if (type === NbtTag.End) {
        frame.node.end = reader.position;
        await store.put(frame.node);
        stack.pop();
      } else await readNode(type, start, await reader.string(), frame.node);
    } else if (frame.remaining === 0) {
      frame.node.end = reader.position;
      await store.put(frame.node);
      stack.pop();
    } else {
      frame.remaining--;
      await readNode(frame.node.elementType!, start, null, frame.node);
    }
    if (++checkpoint === 1024) {
      checkpoint = 0;
      options.onProgress?.({ bytes: reader.position, nodes });
      await (options.yieldControl?.() ??
        new Promise<void>((resolve) => setTimeout(resolve, 0)));
    }
  }
  if (expectedEnd !== undefined && expectedEnd !== reader.position)
    throw new NbtError(
      reader.position,
      "Bedrock envelope length does not match payload",
    );
  if ((await source.read(reader.position, 1, options.signal)).length)
    throw new NbtError(reader.position, "Trailing bytes after NBT root");
  if (source.size !== undefined && reader.position !== source.size)
    throw new NbtError(
      reader.position,
      "Source snapshot length does not match NBT",
    );
  options.onProgress?.({ bytes: reader.position, nodes });
  return {
    root: root.id,
    bytes: reader.position,
    nodes,
    ...(levelVersion === undefined ? {} : { levelVersion }),
  };
}
