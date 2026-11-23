import { Deflate, Inflate, type ZStream } from "pako";
import { nbtFixedInteger } from "./encode.js";
import { copyNbtBytes } from "./source.js";
import {
  NbtError,
  type NbtByteSource,
  type NbtCompression,
  type NbtFormat,
} from "./types.js";

type ByteStream = AsyncIterable<Uint8Array>;
async function* nativeTransform(
  input: ByteStream,
  stream: TransformStream<Uint8Array, Uint8Array>,
  signal?: AbortSignal,
) {
  const iterator = input[Symbol.asyncIterator]();
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const value = await iterator.next();
        if (value.done) controller.close();
        else controller.enqueue(value.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  const reader = source.pipeThrough(stream).getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Native streams first; a synchronous streaming fallback runs inside the NBT worker. */
export async function* transformNbtCompression(
  input: ByteStream,
  kind: NbtCompression,
  decompress: boolean,
  options: { signal?: AbortSignal; fallback?: boolean } = {},
): AsyncGenerator<Uint8Array> {
  options.signal?.throwIfAborted();
  if (!["none", "gzip", "zlib"].includes(kind))
    throw new NbtError(0, "Unsupported compression format");
  if (kind === "none") {
    for await (const bytes of input) {
      options.signal?.throwIfAborted();
      yield bytes;
    }
    return;
  }
  let stream: TransformStream<Uint8Array, Uint8Array> | undefined;
  if (!options.fallback) {
    try {
      stream = (
        decompress
          ? new DecompressionStream(kind === "zlib" ? "deflate" : "gzip")
          : new CompressionStream(kind === "zlib" ? "deflate" : "gzip")
      ) as TransformStream<Uint8Array, Uint8Array>;
    } catch {
      /* Constructor unsupported: actually attempt the streaming fallback. */
    }
  }
  if (stream) {
    yield* nativeTransform(input, stream, options.signal);
    return;
  }
  const pending: Uint8Array[] = [];
  let state: ZStream | undefined;
  const makeCodec = () => {
    const codec = decompress
      ? new Inflate({
          windowBits: kind === "gzip" ? 31 : 15,
          chunkSize: 64 * 1024,
        })
      : new Deflate({ gzip: kind === "gzip", chunkSize: 64 * 1024 });
    codec.onData = (bytes) => {
      if (bytes.length) pending.push(bytes);
    };
    if (codec instanceof Inflate)
      codec.onStart = (stream) => {
        state = stream;
      };
    return codec;
  };
  let codec = makeCodec(),
    offset = 0;
  for await (const chunk of input) {
    // Bound each synchronous inflation step even at extreme compression ratios.
    for (let at = 0; at < chunk.length; at += 1024) {
      options.signal?.throwIfAborted();
      if (codec instanceof Inflate && codec.ended) {
        if (kind !== "gzip")
          throw new NbtError(offset, "Trailing bytes after compressed stream");
        codec = makeCodec();
      }
      const part = chunk.subarray(at, at + 1024);
      if (!codec.push(part, false))
        throw new NbtError(offset, "Invalid compressed stream");
      offset += part.length;
      if (codec instanceof Inflate && codec.ended && state && state.avail_in)
        throw new NbtError(
          offset - state.avail_in,
          "Trailing bytes after compressed stream",
        );
      while (pending.length) yield pending.shift()!;
    }
  }
  options.signal?.throwIfAborted();
  if (
    !(codec instanceof Inflate && codec.ended) &&
    !codec.push(new Uint8Array(0), true)
  )
    throw new NbtError(offset, "Truncated or invalid compressed stream");
  while (pending.length) yield pending.shift()!;
}
/** The payload is replayable/byte-backed; envelope size never needs a giant buffer. */
export async function* encodeNbtFile(
  payload: NbtByteSource,
  format: NbtFormat,
  options: {
    levelVersion?: number;
    signal?: AbortSignal;
    fallback?: boolean;
  } = {},
) {
  async function* framed() {
    if (format.bedrockLevel) {
      if (format.endian !== "little")
        throw new NbtError(0, "Bedrock envelope requires little-endian NBT");
      if (payload.size === undefined)
        throw new NbtError(
          0,
          "Bedrock envelope requires the serialized payload length",
        );
      yield nbtFixedInteger(options.levelVersion ?? 10, 4, true, true);
      yield nbtFixedInteger(payload.size, 4, true, true);
    }
    yield* copyNbtBytes(payload, options.signal);
  }
  yield* transformNbtCompression(framed(), format.compression, false, options);
}
