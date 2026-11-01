import { expect, it } from "vitest";
import { gzipSync, deflateSync } from "node:zlib";
import {
  JAVA_NBT,
  encodeNbtFile,
  memoryNbtSource,
  copyNbtBytes,
  transformNbtCompression,
  type NbtCompression,
} from "../src/index.js";

async function collect(input: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of input) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}
async function* split(bytes: Uint8Array, size = 1) {
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, i + size);
}

it.each([false, true])(
  "verifies gzip/zlib independently generated checksums (fallback=%s)",
  async (fallback) => {
    for (const kind of ["gzip", "zlib"] as const) {
      const input = new Uint8Array(200000).fill(42),
        encoded = kind === "gzip" ? gzipSync(input) : deflateSync(input);
      expect(
        await collect(
          transformNbtCompression(split(encoded), kind, true, { fallback }),
        ),
      ).toEqual(input);
      const corrupt = new Uint8Array(encoded);
      corrupt[corrupt.length - (kind === "gzip" ? 8 : 4)]! ^= 1;
      await expect(
        collect(
          transformNbtCompression(split(corrupt), kind, true, { fallback }),
        ),
      ).rejects.toThrow();
      await expect(
        collect(
          transformNbtCompression(split(encoded.subarray(0, -2)), kind, true, {
            fallback,
          }),
        ),
      ).rejects.toThrow();
    }
  },
);
it.each([false, true])(
  "streams encode/decode without changing bytes (fallback=%s)",
  async (fallback) => {
    const bytes = new Uint8Array(130000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
    for (const compression of ["none", "gzip", "zlib"] as NbtCompression[]) {
      const encoded = await collect(
        encodeNbtFile(
          memoryNbtSource(bytes),
          { ...JAVA_NBT, compression },
          { fallback },
        ),
      );
      const decoded = await collect(
        transformNbtCompression(
          copyNbtBytes(memoryNbtSource(encoded)),
          compression,
          true,
          { fallback },
        ),
      );
      expect(decoded).toEqual(bytes);
    }
  },
);
it.each([false, true])(
  "rejects trailing garbage and empty compressed inputs (fallback=%s)",
  async (fallback) => {
    for (const kind of ["gzip", "zlib"] as const) {
      await expect(
        collect(
          transformNbtCompression(split(new Uint8Array()), kind, true, {
            fallback,
          }),
        ),
      ).rejects.toThrow();
      const compressed =
        kind === "gzip"
          ? gzipSync(Uint8Array.of(1))
          : deflateSync(Uint8Array.of(1));
      await expect(
        collect(
          transformNbtCompression(
            split(
              new Uint8Array(Buffer.concat([compressed, Uint8Array.of(123)])),
            ),
            kind,
            true,
            { fallback },
          ),
        ),
      ).rejects.toThrow();
    }
  },
);
it.each([false, true])(
  "settles cancellation without silently returning partial bytes (fallback=%s)",
  async (fallback) => {
    const controller = new AbortController(),
      bytes = gzipSync(new Uint8Array(100000));
    async function* input() {
      yield bytes.subarray(0, 5);
      controller.abort(new Error("cancelled inflate"));
      yield bytes.subarray(5);
    }
    await expect(
      collect(
        transformNbtCompression(input(), "gzip", true, {
          fallback,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled inflate");
  },
);
it("exports the original compressed bytes without recompression", async () => {
  const input = gzipSync(Uint8Array.from([10, 0, 0, 0]));
  expect(await collect(copyNbtBytes(memoryNbtSource(input)))).toEqual(
    new Uint8Array(input),
  );
});
