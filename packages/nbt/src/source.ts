import {
  assertRange,
  NBT_CHUNK_BYTES,
  NbtError,
  type NbtByteSource,
  type NbtIndexStore,
  type NbtNode,
} from "./types.js";

export function memoryNbtSource(bytes: Uint8Array): NbtByteSource {
  return {
    size: bytes.byteLength,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      assertRange(offset, length);
      return bytes.subarray(offset, offset + length);
    },
  };
}
export function blobNbtSource(blob: Blob): NbtByteSource {
  return {
    size: blob.size,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      assertRange(offset, length);
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + length).arrayBuffer(),
      );
      signal?.throwIfAborted();
      return bytes;
    },
  };
}
export async function* copyNbtBytes(
  source: NbtByteSource,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const bytes = await source.read(offset, NBT_CHUNK_BYTES, signal);
    if (bytes.length > NBT_CHUNK_BYTES)
      throw new NbtError(offset, "Source exceeded requested range");
    if (!bytes.length) {
      if (source.size !== undefined && offset !== source.size)
        throw new NbtError(offset, "Truncated source snapshot");
      return;
    }
    offset += bytes.length;
    if (source.size !== undefined && offset > source.size)
      throw new NbtError(offset, "Source exceeded snapshot length");
    yield bytes;
  }
}
/** For fixtures/small documents. Large-file clients supply a disk-backed store. */
export class MemoryNbtIndex implements NbtIndexStore {
  private nodes = new Map<string, NbtNode>();
  private lists = new Map<string, string[]>();
  async put(node: NbtNode) {
    const previous = this.nodes.get(node.id);
    if (
      previous &&
      (previous.parent !== node.parent || previous.ordinal !== node.ordinal)
    )
      throw new NbtError(node.start, "Node identity changed");
    this.nodes.set(node.id, structuredClone(node));
    if (!previous && node.parent !== null) {
      const children = this.lists.get(node.parent) ?? [];
      children[node.ordinal] = node.id;
      this.lists.set(node.parent, children);
    }
  }
  async get(id: string) {
    const node = this.nodes.get(id);
    return node && structuredClone(node);
  }
  async children(parent: string, offset: number, limit: number) {
    assertRange(offset, limit);
    return Promise.all(
      (this.lists.get(parent) ?? [])
        .slice(offset, offset + limit)
        .map(async (id) => (await this.get(id))!),
    );
  }
}
