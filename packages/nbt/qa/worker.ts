/// <reference lib="webworker" />
import {
  JAVA_NBT,
  BEDROCK_NBT,
  NETWORK_NBT,
  NbtTag,
  MemoryNbtIndex,
  encodeNbtPayload,
  encodeNbtFile,
  memoryNbtSource,
  blobNbtSource,
  scanNbt,
  readNbtScalar,
  readNbtName,
  copyNbtBytes,
  transformNbtCompression,
  readNbtArrayPage,
  type NbtByteSource,
  type NbtEntry,
  type NbtFormat,
} from "../src/index";

const worker = self as unknown as DedicatedWorkerGlobalScope;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function collect(input: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
worker.onmessage = async () => {
  const cases: string[] = [];
  try {
    const formats: NbtFormat[] = [
      JAVA_NBT,
      BEDROCK_NBT,
      NETWORK_NBT,
      { ...JAVA_NBT, namedRoot: false },
      { ...BEDROCK_NBT, bedrockLevel: true },
    ];
    for (const encoding of formats)
      for (const compression of ["none", "gzip", "zlib"] as const)
        for (const fallback of [false, true]) {
          const format = { ...encoding, compression };
          const root: NbtEntry = {
            name: "root",
            tag: {
              type: NbtTag.Compound,
              value: [
                {
                  name: "duplicate",
                  tag: { type: NbtTag.Long, value: 9223372036854775807n },
                },
                {
                  name: "duplicate",
                  tag: { type: NbtTag.String, value: "NUL\0 😀" },
                },
                {
                  name: "array",
                  tag: {
                    type: NbtTag.LongArray,
                    value: new BigInt64Array([-(1n << 63n), 1n]),
                    length: 2,
                  },
                },
              ],
            },
          };
          const payload = await collect(encodeNbtPayload(root, format));
          const encoded = await collect(
            encodeNbtFile(memoryNbtSource(payload), format, { fallback }),
          );
          const original = blobNbtSource(new Blob([encoded]));
          const expanded = await collect(
            transformNbtCompression(copyNbtBytes(original), compression, true, {
              fallback,
            }),
          );
          const source = blobNbtSource(new Blob([expanded])),
            store = new MemoryNbtIndex();
          const result = await scanNbt(source, format, store),
            children = await store.children(result.root, 0, 10);
          check(children.length === 3, "lost duplicate properties");
          check(
            (await readNbtName(source, children[1]!, format)).text ===
              "duplicate",
            "incorrect name",
          );
          check(
            (await readNbtScalar(source, children[0]!, format)).value ===
              9223372036854775807n,
            "lost long precision",
          );
          check(
            (await readNbtScalar(source, children[1]!, format)).value ===
              "NUL\0 😀",
            "lost string encoding",
          );
          const array = await readNbtArrayPage(
            source,
            children[2]!,
            format,
            0,
            2,
          );
          check(
            array[0] === -(1n << 63n) && array[1] === 1n,
            "lost array values",
          );
          const copy = await collect(copyNbtBytes(original));
          check(
            copy.length === encoded.length &&
              copy.every((b, i) => encoded[i] === b),
            "original export changed bytes",
          );
          cases.push(
            `${encoding.endian}/${encoding.namedRoot ? "named" : "unnamed"}/${encoding.bedrockLevel ? "level" : "raw"}/${compression}/${fallback ? "fallback" : "native"}`,
          );
        }
    const header = Uint8Array.from([10, 0, 0, 7, 0, 1, 98, 64, 0, 0, 0]),
      length = 1024 ** 3;
    let transferred = 0;
    const source: NbtByteSource = {
      size: header.length + length + 1,
      async read(offset, count) {
        const size = Math.max(0, Math.min(count, this.size! - offset));
        transferred += size;
        const result = new Uint8Array(size);
        if (offset < header.length)
          result.set(header.subarray(offset, offset + size));
        return result;
      },
    };
    const store = new MemoryNbtIndex(),
      result = await scanNbt(source, JAVA_NBT, store);
    const array = (await store.children(result.root, 0, 1))[0]!;
    check(
      array.length === length && result.nodes === 2,
      "expanded array into nodes",
    );
    check(
      (await readNbtArrayPage(source, array, JAVA_NBT, length - 1, 1))[0] === 0,
      "array tail inaccessible",
    );
    check(transferred < 128 * 1024, "buffered large array");
    worker.postMessage({
      ok: true,
      cases,
      largeArray: {
        logicalBytes: source.size,
        transferredBytes: transferred,
        nodes: result.nodes,
      },
    });
  } catch (error) {
    worker.postMessage({ ok: false, cases, error: String(error) });
  }
};
