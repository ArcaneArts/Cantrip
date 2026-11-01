import { describe, expect, it } from "vitest";
import * as reference from "nbtify";
import {
  JAVA_NBT,
  BEDROCK_NBT,
  NETWORK_NBT,
  NbtTag,
  NbtError,
  MemoryNbtIndex,
  memoryNbtSource,
  blobNbtSource,
  scanNbt,
  readNbtName,
  readNbtScalar,
  readNbtArrayPage,
  encodeNbtPayload,
  encodeNbtFile,
  copyNbtBytes,
  transformNbtCompression,
  decodeNbtString,
  encodeNbtString,
  readNbtText,
  type NbtByteSource,
  type NbtEntry,
  type NbtFormat,
  type NbtNode,
  type NbtValue,
} from "../src/index.js";

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const bytes of stream) {
    parts.push(bytes);
    length += bytes.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function fragmented(bytes: Uint8Array, page = 3): NbtByteSource {
  return {
    size: bytes.length,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      return bytes.subarray(offset, offset + Math.min(page, length));
    },
  };
}
const entry = (name: string, tag: NbtValue): NbtEntry => ({ name, tag });
const compound = (value: NbtEntry[]): NbtValue => ({
  type: NbtTag.Compound,
  value,
});
function fixture(unicode = false): NbtEntry {
  return entry(
    "root",
    compound([
      entry("byte", { type: NbtTag.Byte, value: -128 }),
      entry("short", { type: NbtTag.Short, value: 32767 }),
      entry("int", { type: NbtTag.Int, value: -2147483648 }),
      entry("long", { type: NbtTag.Long, value: 9223372036854775807n }),
      entry("float", { type: NbtTag.Float, value: -0 }),
      entry("double", { type: NbtTag.Double, value: Infinity }),
      entry("string", {
        type: NbtTag.String,
        value: unicode ? "NUL\0 😀 \ud800" : "hello",
      }),
      entry("bytes", {
        type: NbtTag.ByteArray,
        value: [-128, -1, 0, 127],
        length: 4,
      }),
      entry("ints", {
        type: NbtTag.IntArray,
        value: [-2147483648, 2147483647],
        length: 2,
      }),
      entry("longs", {
        type: NbtTag.LongArray,
        value: [-(1n << 63n), (1n << 63n) - 1n],
        length: 2,
      }),
      entry("list", {
        type: NbtTag.List,
        elementType: NbtTag.Int,
        value: [1, -1, 2].map((value) => ({ type: NbtTag.Int, value })),
        length: 3,
      }),
      entry("empty", {
        type: NbtTag.List,
        elementType: NbtTag.End,
        value: [],
        length: 0,
      }),
      entry(
        "nested",
        compound([entry("last", { type: NbtTag.String, value: "found" })]),
      ),
    ]),
  );
}
async function inspect(bytes: Uint8Array, format: NbtFormat, page = 3) {
  const source = fragmented(bytes, page),
    store = new MemoryNbtIndex();
  const result = await scanNbt(source, format, store);
  const children = await store.children(result.root, 0, 100);
  const names = await Promise.all(
    children.map(
      async (node) => (await readNbtName(source, node, format)).text,
    ),
  );
  return {
    source,
    store,
    result,
    children,
    named: Object.fromEntries(
      children.map((node, i) => [names[i], node]),
    ) as Record<string, NbtNode>,
  };
}
const profiles: Array<[string, NbtFormat]> = [
  ["java", { ...JAVA_NBT }],
  ["bedrock", { ...BEDROCK_NBT }],
  ["network", { ...NETWORK_NBT }],
  ["java unnamed", { ...JAVA_NBT, namedRoot: false }],
  ["bedrock envelope", { ...BEDROCK_NBT, bedrockLevel: true }],
];

describe("lossless typed NBT", () => {
  it.each(profiles)("preserves every standard tag in %s", async (_, format) => {
    const payload = await collect(
      encodeNbtPayload(fixture(format.strings === "mutf8"), format),
    );
    const file = await collect(
      encodeNbtFile(memoryNbtSource(payload), format, { levelVersion: 123 }),
    );
    const { source, result, named } = await inspect(file, format, 1);
    expect(result.nodes).toBe(18);
    expect(result.levelVersion).toBe(format.bedrockLevel ? 123 : undefined);
    for (const [name, value] of [
      ["byte", -128],
      ["short", 32767],
      ["int", -2147483648],
      ["long", 9223372036854775807n],
      ["float", -0],
      ["double", Infinity],
      ["string", format.strings === "mutf8" ? "NUL\0 😀 \ud800" : "hello"],
    ] as const)
      expect((await readNbtScalar(source, named[name]!, format)).value).toBe(
        value,
      );
    expect(await readNbtArrayPage(source, named.bytes!, format, 1, 2)).toEqual([
      -1, 0,
    ]);
    expect(await readNbtArrayPage(source, named.ints!, format, 0)).toEqual([
      -2147483648, 2147483647,
    ]);
    expect(await readNbtArrayPage(source, named.longs!, format, 0)).toEqual([
      -(1n << 63n),
      (1n << 63n) - 1n,
    ]);
  });

  it.each([
    [JAVA_NBT, "0300016901020304", 0x01020304],
    [BEDROCK_NBT, "0301006904030201", 0x01020304],
    [NETWORK_NBT, "0301", -1],
    [{ ...NETWORK_NBT, namedRoot: true }, "03016901", -1],
  ] as const)(
    "matches independent integer golden bytes: %j",
    async (format, hex, value) => {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const store = new MemoryNbtIndex(),
        source = fragmented(bytes, 1);
      const result = await scanNbt(source, format, store);
      expect(
        (await readNbtScalar(source, (await store.get(result.root))!, format))
          .value,
      ).toBe(value);
      expect(
        await collect(
          encodeNbtPayload(entry("i", { type: NbtTag.Int, value }), format),
        ),
      ).toEqual(bytes);
    },
  );

  it.each(profiles)(
    "is readable by the independent NBTify codec: %s",
    async (_, format) => {
      const payload = await collect(encodeNbtPayload(fixture(false), format));
      const file = await collect(
        encodeNbtFile(memoryNbtSource(payload), format),
      );
      const decoded = await reference.read(file, {
        endian: format.endian,
        rootName: format.namedRoot,
        bedrockLevel: format.bedrockLevel,
        compression: null,
      });
      const values = decoded.data as reference.CompoundTag;
      expect(Number(values.byte)).toBe(-128);
      expect(Number(values.int)).toBe(-2147483648);
      expect(values.long).toBe(9223372036854775807n);
      expect(values.longs).toEqual(
        new BigInt64Array([-(1n << 63n), (1n << 63n) - 1n]),
      );
    },
  );

  it.each(profiles.filter(([, format]) => !format.bedrockLevel))(
    "reads independent NBTify output: %s",
    async (_, format) => {
      const bytes = await reference.write(
        {
          int: new reference.Int32(-2147483648),
          long: -(1n << 63n),
          string: "hello",
          list: [new reference.Int16(12), new reference.Int16(-12)],
        },
        {
          endian: format.endian,
          rootName: format.namedRoot ? "root" : null,
          compression: null,
        },
      );
      const { source, store, named } = await inspect(bytes, format);
      expect((await readNbtScalar(source, named.int!, format)).value).toBe(
        -2147483648,
      );
      expect((await readNbtScalar(source, named.long!, format)).value).toBe(
        -(1n << 63n),
      );
      const list = await store.children(named.list!.id, 0, 10);
      expect(
        await Promise.all(
          list.map(
            async (node) => (await readNbtScalar(source, node, format)).value,
          ),
        ),
      ).toEqual([12, -12]);
    },
  );

  it("preserves duplicate and prototype-like names with stable distinct identities", async () => {
    const root = entry(
      "",
      compound([
        entry("x", { type: NbtTag.Byte, value: 1 }),
        entry("x", { type: NbtTag.Byte, value: 2 }),
        entry("__proto__", { type: NbtTag.Byte, value: 3 }),
      ]),
    );
    const bytes = await collect(encodeNbtPayload(root, JAVA_NBT));
    const { children, source, store, result } = await inspect(bytes, JAVA_NBT);
    expect(new Set(children.map((node) => node.id)).size).toBe(3);
    expect(
      await Promise.all(
        children.map(
          async (node) => (await readNbtName(source, node, JAVA_NBT)).text,
        ),
      ),
    ).toEqual(["x", "x", "__proto__"]);
    expect((await store.children(result.root, 1, 1))[0]?.id).toBe(
      children[1]?.id,
    );
  });

  it("preserves noncanonical NaN payloads and negative zero through original-byte export", async () => {
    for (const hex of ["0500007fa12345", "0600008000000000000000"]) {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex")),
        source = memoryNbtSource(bytes),
        store = new MemoryNbtIndex();
      const result = await scanNbt(source, JAVA_NBT, store);
      const value = (
        await readNbtScalar(source, (await store.get(result.root))!, JAVA_NBT)
      ).value;
      expect(
        hex.startsWith("05") ? Number.isNaN(value) : Object.is(value, -0),
      ).toBe(true);
      expect(await collect(copyNbtBytes(source))).toEqual(bytes);
    }
  });

  it("does not recursively overflow on deep legal trees", async () => {
    let tag: NbtValue = { type: NbtTag.Int, value: 4 };
    for (let i = 0; i < 1500; i++) tag = compound([entry("", tag)]);
    const bytes = await collect(encodeNbtPayload(entry("", tag), JAVA_NBT));
    const result = await scanNbt(
      memoryNbtSource(bytes),
      JAVA_NBT,
      new MemoryNbtIndex(),
    );
    expect(result.nodes).toBe(1501);
  });

  it("keeps a one-GiB array byte-backed and reads only requested element pages", async () => {
    const count = 1024 ** 3,
      header = Uint8Array.from(Buffer.from("0a00000700016240000000", "hex"));
    let read = 0;
    const source: NbtByteSource = {
      size: header.length + count + 1,
      async read(offset, length) {
        const size = Math.max(0, Math.min(length, this.size! - offset));
        read += size;
        const bytes = new Uint8Array(size);
        if (offset < header.length)
          bytes.set(header.subarray(offset, offset + size));
        return bytes;
      },
    };
    const store = new MemoryNbtIndex(),
      result = await scanNbt(source, JAVA_NBT, store);
    const node = (await store.children(result.root, 0, 1))[0]!;
    expect(result.nodes).toBe(2);
    expect(node.length).toBe(count);
    expect(
      await readNbtArrayPage(source, node, JAVA_NBT, count - 3, 3),
    ).toEqual([0, 0, 0]);
    expect(read).toBeLessThan(128 * 1024);
  });

  it("accepts an immutable local browser Blob as a source", async () => {
    const bytes = await collect(encodeNbtPayload(fixture(), JAVA_NBT));
    const result = await scanNbt(
      blobNbtSource(new Blob([bytes])),
      JAVA_NBT,
      new MemoryNbtIndex(),
    );
    expect(result.bytes).toBe(bytes.length);
  });
});

describe("string encodings", () => {
  it.each([
    "",
    "abc",
    "a\0b",
    "😀",
    "\ud800",
    "\udfff",
    "\ufeffdata",
    "x".repeat(10000),
  ])("round-trips modified UTF-8 code units", (text) => {
    expect(decodeNbtString(encodeNbtString(text, "mutf8"), "mutf8")).toBe(text);
  });
  it("matches independent modified UTF-8 bytes", () => {
    expect(encodeNbtString("\0😀", "mutf8")).toEqual(
      Uint8Array.from(Buffer.from("c080eda0bdedb880", "hex")),
    );
  });
  it.each(["\ud800", "\udfff", "a\ud800x"])(
    "refuses lossy UTF-8 edits",
    (value) => {
      expect(() => encodeNbtString(value, "utf8")).toThrow("Unpaired");
    },
  );
  it.each(["utf8", "mutf8"] as const)(
    "pages %s without cutting encoded characters",
    async (strings) => {
      const text = "😀abc",
        bytes = encodeNbtString(text, strings),
        format = { ...JAVA_NBT, strings };
      const first = await readNbtText(
        fragmented(bytes, 1),
        { offset: 0, length: bytes.length },
        format,
        1,
      );
      expect(first.nextByte).toBeGreaterThan(0);
      const rest = await readNbtText(
        memoryNbtSource(bytes),
        { offset: first.nextByte, length: bytes.length - first.nextByte },
        format,
      );
      expect(first.text + rest.text).toBe(text);
    },
  );
});

describe("malformed input and cancellation", () => {
  it("rejects every truncated prefix instead of producing a complete document", async () => {
    const bytes = await collect(encodeNbtPayload(fixture(), JAVA_NBT));
    for (let end = 0; end < bytes.length; end++)
      await expect(
        scanNbt(
          fragmented(bytes.subarray(0, end)),
          JAVA_NBT,
          new MemoryNbtIndex(),
        ),
      ).rejects.toThrow(NbtError);
  });
  it.each([
    "ff",
    "0a0000ff",
    "070000ffffffff",
    "0900000000000001",
    "0301",
    "0a00000001",
  ])("rejects malformed wire bytes %s", async (hex) => {
    await expect(
      scanNbt(
        memoryNbtSource(Uint8Array.from(Buffer.from(hex, "hex"))),
        JAVA_NBT,
        new MemoryNbtIndex(),
      ),
    ).rejects.toThrow(NbtError);
  });
  it.each(["03808080808000", "03ffffffff1f", "048080808080808080808000"])(
    "rejects oversized network varints %s",
    async (hex) => {
      await expect(
        scanNbt(
          fragmented(Uint8Array.from(Buffer.from(hex, "hex")), 1),
          NETWORK_NBT,
          new MemoryNbtIndex(),
        ),
      ).rejects.toThrow(NbtError);
    },
  );
  it("keeps unusual nonpositive empty-list declarations intact", async () => {
    const bytes = Uint8Array.from(Buffer.from("09000001ffffffff", "hex")),
      store = new MemoryNbtIndex();
    const result = await scanNbt(memoryNbtSource(bytes), JAVA_NBT, store);
    expect(await store.get(result.root)).toMatchObject({
      length: 0,
      declaredLength: -1,
      elementType: NbtTag.Byte,
    });
    expect(await collect(copyNbtBytes(memoryNbtSource(bytes)))).toEqual(bytes);
  });
  it("reports a real Bedrock envelope length mismatch", async () => {
    const format = { ...BEDROCK_NBT, bedrockLevel: true };
    await expect(
      scanNbt(
        memoryNbtSource(
          Uint8Array.from(Buffer.from("0a000000050000000a000000", "hex")),
        ),
        format,
        new MemoryNbtIndex(),
      ),
    ).rejects.toThrow("envelope length");
  });
  it("supports cooperative cancellation while scanning", async () => {
    const value = Array.from({ length: 2000 }, (_, i) =>
      entry(String(i), { type: NbtTag.Int, value: i } as NbtValue),
    );
    const bytes = await collect(
      encodeNbtPayload(entry("", compound(value)), JAVA_NBT),
    );
    const controller = new AbortController();
    await expect(
      scanNbt(memoryNbtSource(bytes), JAVA_NBT, new MemoryNbtIndex(), {
        signal: controller.signal,
        yieldControl: async () => {
          controller.abort(new Error("cancelled scan"));
        },
      }),
    ).rejects.toThrow("cancelled scan");
  });
  it.each([
    { type: NbtTag.Byte, value: 128 },
    { type: NbtTag.Int, value: 2147483648 },
    { type: NbtTag.Long, value: 1n << 63n },
    {
      type: NbtTag.List,
      elementType: NbtTag.Int,
      value: [{ type: NbtTag.Byte, value: 1 }],
      length: 1,
    },
    { type: NbtTag.IntArray, value: [1], length: 2 },
    { type: NbtTag.LongArray, value: [1n, 2n], length: 1 },
  ] as NbtValue[])("rejects invalid typed edits", async (tag) => {
    await expect(
      collect(encodeNbtPayload(entry("", tag), JAVA_NBT)),
    ).rejects.toThrow(NbtError);
  });
  it("rejects cyclic builders without recursive overflow", async () => {
    const children: NbtEntry[] = [],
      root = entry("", compound(children));
    children.push(root);
    await expect(collect(encodeNbtPayload(root, JAVA_NBT))).rejects.toThrow(
      "Cyclic",
    );
  });
});

export { collect };

it.each(profiles)(
  "round-trips compressed NBT with both client engines: %s",
  async (_, encoding) => {
    for (const compression of ["gzip", "zlib"] as const)
      for (const fallback of [false, true]) {
        const format = { ...encoding, compression };
        const payload = await collect(encodeNbtPayload(fixture(), format));
        const bytes = await collect(
          encodeNbtFile(memoryNbtSource(payload), format, { fallback }),
        );
        const expanded = await collect(
          transformNbtCompression(
            copyNbtBytes(fragmented(bytes, 1)),
            compression,
            true,
            { fallback },
          ),
        );
        const { result, named, source } = await inspect(expanded, format);
        expect(result.nodes).toBe(18);
        expect((await readNbtScalar(source, named.long!, format)).value).toBe(
          (1n << 63n) - 1n,
        );
      }
  },
);
it.each([JAVA_NBT, BEDROCK_NBT, NETWORK_NBT])(
  "streams typed arrays without per-element object expansion: %j",
  async (encoding) => {
    for (const tag of [
      {
        type: NbtTag.ByteArray,
        value: new Uint8Array([128, 255, 0, 127]),
        length: 4,
      },
      {
        type: NbtTag.IntArray,
        value: new Int32Array([-2147483648, 2147483647]),
        length: 2,
      },
      {
        type: NbtTag.LongArray,
        value: new BigInt64Array([-(1n << 63n), (1n << 63n) - 1n]),
        length: 2,
      },
    ] as NbtValue[]) {
      const bytes = await collect(encodeNbtPayload(entry("", tag), encoding)),
        store = new MemoryNbtIndex(),
        source = memoryNbtSource(bytes);
      const result = await scanNbt(source, encoding, store);
      const values = await readNbtArrayPage(
        source,
        (await store.get(result.root))!,
        encoding,
        0,
      );
      expect(values).toEqual(
        tag.type === NbtTag.ByteArray
          ? [-128, -1, 0, 127]
          : [...(tag.value as Iterable<number | bigint>)],
      );
    }
  },
);
it("cancels the middle of a large typed-array encoding", async () => {
  const controller = new AbortController();
  const stream = encodeNbtPayload(
    entry("", {
      type: NbtTag.ByteArray,
      value: new Uint8Array(1024 ** 2),
      length: 1024 ** 2,
    }),
    JAVA_NBT,
    controller.signal,
  );
  expect((await stream.next()).value?.length).toBe(65536);
  controller.abort(new Error("cancelled encode"));
  await expect(stream.next()).rejects.toThrow("cancelled encode");
});
it("finds UTF-8 supplementary characters from independent Bedrock bytes", async () => {
  const bytes = Uint8Array.from(Buffer.from("0800000400f09f9880", "hex")),
    source = fragmented(bytes, 1),
    store = new MemoryNbtIndex();
  const result = await scanNbt(source, BEDROCK_NBT, store);
  expect(
    (await readNbtScalar(source, (await store.get(result.root))!, BEDROCK_NBT))
      .value,
  ).toBe("😀");
});
it("retains separately declared types inside a list of lists", async () => {
  const nested: NbtValue = {
    type: NbtTag.List,
    elementType: NbtTag.List,
    length: 2,
    value: [
      {
        type: NbtTag.List,
        elementType: NbtTag.Int,
        length: 1,
        value: [{ type: NbtTag.Int, value: 4 }],
      },
      {
        type: NbtTag.List,
        elementType: NbtTag.String,
        length: 1,
        value: [{ type: NbtTag.String, value: "s" }],
      },
    ],
  };
  const bytes = await collect(encodeNbtPayload(entry("", nested), JAVA_NBT)),
    store = new MemoryNbtIndex();
  const result = await scanNbt(memoryNbtSource(bytes), JAVA_NBT, store);
  expect(
    (await store.children(result.root, 0, 2)).map((n) => n.elementType),
  ).toEqual([NbtTag.Int, NbtTag.String]);
});

it("supports a decompression spool whose final size is initially unknown", async () => {
  const bytes = await collect(encodeNbtPayload(fixture(), JAVA_NBT));
  const source = { ...fragmented(bytes, 2), size: undefined };
  const result = await scanNbt(source, JAVA_NBT, new MemoryNbtIndex());
  expect(result.bytes).toBe(bytes.length);
});
it("rejects a byte source that violates the requested range", async () => {
  const source: NbtByteSource = {
    size: undefined,
    async read() {
      return new Uint8Array(65537);
    },
  };
  await expect(scanNbt(source, JAVA_NBT, new MemoryNbtIndex())).rejects.toThrow(
    "exceeded requested",
  );
  await expect(collect(copyNbtBytes(source))).rejects.toThrow(
    "exceeded requested",
  );
});
it("preserves a leading UTF-8 BOM as string content", () => {
  expect(decodeNbtString(encodeNbtString("\ufeffvalue", "utf8"), "utf8")).toBe(
    "\ufeffvalue",
  );
});
it.each(Array.from({ length: 13 }, (_, type) => type))(
  "preserves empty-list element type %s",
  async (elementType) => {
    const bytes = Uint8Array.from([9, 0, 0, elementType, 0, 0, 0, 0]),
      store = new MemoryNbtIndex();
    const result = await scanNbt(memoryNbtSource(bytes), JAVA_NBT, store);
    expect((await store.get(result.root))?.elementType).toBe(elementType);
  },
);
it("enforces a caller's actual nesting budget", async () => {
  const bytes = await collect(
    encodeNbtPayload(entry("", compound([entry("", compound([]))])), JAVA_NBT),
  );
  await expect(
    scanNbt(memoryNbtSource(bytes), JAVA_NBT, new MemoryNbtIndex(), {
      maxDepth: 1,
    }),
  ).rejects.toThrow("nesting budget");
});

it("publishes an array descriptor before an incomplete spool reaches its payload end", async () => {
  const length = 1024 ** 3,
    header = Uint8Array.from([10, 0, 0, 7, 0, 1, 98, 64, 0, 0, 0]);
  let release!: () => void, observed!: (node: NbtNode) => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const indexed = new Promise<NbtNode>((resolve) => (observed = resolve));
  class ObservedIndex extends MemoryNbtIndex {
    override async put(node: NbtNode) {
      await super.put(node);
      if (node.type === NbtTag.ByteArray && node.end === null) observed(node);
    }
  }
  const source: NbtByteSource = {
    size: undefined,
    async read(offset, count) {
      if (offset === header.length + length - 1 && count === 1) await blocked;
      const size = Math.max(
          0,
          Math.min(count, header.length + length + 1 - offset),
        ),
        bytes = new Uint8Array(size);
      if (offset < header.length)
        bytes.set(header.subarray(offset, offset + size));
      return bytes;
    },
  };
  const pending = scanNbt(source, JAVA_NBT, new ObservedIndex());
  const node = await indexed;
  expect(node).toMatchObject({ length, end: null });
  release();
  expect((await pending).nodes).toBe(2);
});

it.each([
  { type: NbtTag.Float, value: 4e38 },
  { type: NbtTag.ByteArray, value: [255], length: 1 },
] as NbtValue[])("rejects lossy scalar/array numeric edits", async (tag) => {
  await expect(
    collect(encodeNbtPayload(entry("", tag), JAVA_NBT)),
  ).rejects.toThrow(NbtError);
});
it.each([
  ["utf8", [0xff]],
  ["utf8", [0xc0, 0x80]],
  ["utf8", [0xf0, 0x9f]],
  ["mutf8", [0xf0, 0x9f, 0x98, 0x80]],
  ["mutf8", [0xc0]],
  ["mutf8", [0xe1, 0x41, 0x80]],
] as const)(
  "reports malformed %s bytes at a decoding boundary",
  (encoding, bytes) => {
    expect(() => decodeNbtString(Uint8Array.from(bytes), encoding)).toThrow(
      NbtError,
    );
  },
);
