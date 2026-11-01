import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  JAVA_NBT,
  NbtTag,
  encodeNbtPayload,
  memoryNbtSource,
  type NbtEntry,
} from "../src/index.js";
import { NbtDocumentEngine } from "../src/document/engine.js";
import { nbtTreePage, nbtAncestors } from "../src/view/tree.js";
import { nbtTablePage } from "../src/view/table.js";
import { NbtDocumentSearch } from "../src/search/search.js";
import { NbtSearchResults } from "../src/search/results.js";
import { exactNumeric, streamMatches } from "../src/search/text.js";
import type { NbtSearchQuery, NbtSearchStatus } from "../src/search/types.js";
const signal = new AbortController().signal;
async function fixture(entries: Iterable<NbtEntry>) {
  const chunks = [];
  for await (const bytes of encodeNbtPayload(
    { name: "", tag: { type: NbtTag.Compound, value: entries } },
    JAVA_NBT,
  ))
    chunks.push(bytes);
  const bytes = Buffer.concat(chunks),
    engine = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
      binding: crypto.randomUUID(),
      format: JAVA_NBT,
      indexPages: 16,
      cacheBytes: 128 * 1024,
    });
  await engine.completed;
  return { bytes, engine };
}
const str = (name: string, value: string): NbtEntry => ({
  name,
  tag: { type: NbtTag.String, value },
});
const int = (name: string, value: number): NbtEntry => ({
  name,
  tag: { type: NbtTag.Int, value },
});
const compound = (name: string, value: NbtEntry[]): NbtEntry => ({
  name,
  tag: { type: NbtTag.Compound, value },
});
async function search(
  engine: NbtDocumentEngine,
  query: Partial<NbtSearchQuery> & { text: string },
) {
  let status: NbtSearchStatus | undefined;
  const service = new NbtDocumentSearch(
      engine,
      crypto.randomUUID(),
      (next) => (status = next),
    ),
    id = crypto.randomUUID();
  service.start(id, {
    fields: ["name", "value"],
    caseSensitive: false,
    exactNumber: false,
    ...query,
  });
  const deadline = Date.now() + 10000;
  while (!status || status.state === "searching") {
    if (Date.now() > deadline) throw new Error("Search timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return { service, id, status, results: await service.results(id, 0, 128) };
}
it("rank-selects nested expanded containers and reveals an unloaded child's ancestors", async () => {
  const { engine } = await fixture([
    compound("one", [int("a", 1), compound("two", [int("b", 2)])]),
    int("last", 3),
  ]);
  try {
    const root = (await engine.rows(null, 0, 1))[0]!,
      [one, last] = await engine.rows(root.node.id, 0, 128),
      [a, two] = await engine.rows(one!.node.id, 0, 128),
      [b] = await engine.rows(two!.node.id, 0, 128);
    const tree = await nbtTreePage(
      engine,
      [root.node.id, one!.node.id, two!.node.id],
      0,
      128,
      b!.node.id,
      signal,
    );
    expect(tree.rows.map((row) => row.row.node.id)).toEqual([
      root.node.id,
      one!.node.id,
      a!.node.id,
      two!.node.id,
      b!.node.id,
      last!.node.id,
    ]);
    expect(tree.rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 3, 1]);
    expect(tree.anchorIndex).toBe(4);
    expect(
      (await nbtTreePage(engine, [root.node.id], 1, 1, undefined, signal))
        .rows[0]?.row.name,
    ).toBe("one");
    expect(
      (await nbtAncestors(engine, b!.node.id, signal)).map((node) => node.id),
    ).toEqual([root.node.id, one!.node.id, two!.node.id, b!.node.id]);
    await engine.setPaused(true);
    expect(
      (
        await nbtTreePage(
          engine,
          [root.node.id, one!.node.id],
          3,
          2,
          undefined,
          signal,
        )
      ).rows,
    ).toHaveLength(2);
  } finally {
    await engine.close();
  }
});
it("pages a large flat tree without materializing its children", async () => {
  const { engine } = await fixture(
    (function* () {
      for (let i = 0; i < 10000; i++) yield int("n", i);
    })(),
  );
  try {
    const root = engine.snapshot().root!,
      page = await nbtTreePage(engine, [root], 9995, 6, undefined, signal);
    expect(page.total).toBe(10001);
    expect(page.rows.map((row) => row.row.value)).toEqual([
      9994, 9995, 9996, 9997, 9998, 9999,
    ]);
  } finally {
    await engine.close();
  }
});
it("aligns typed table cells by full name and duplicate occurrence without changing source order", async () => {
  const { engine, bytes } = await fixture([
    {
      name: "items",
      tag: {
        type: NbtTag.List,
        elementType: NbtTag.Compound,
        length: 2,
        value: [
          {
            type: NbtTag.Compound,
            value: [
              int("a", 1),
              str("duplicate", "first"),
              int("duplicate", 2),
              int("missing", 7),
            ],
          },
          {
            type: NbtTag.Compound,
            value: [
              int("duplicate", 10),
              str("a", "changed type"),
              int("duplicate", 20),
            ],
          },
        ],
      },
    },
  ]);
  try {
    const list = (await engine.rows(engine.snapshot().root!, 0, 1))[0]!;
    await engine.setPaused(true);
    const table = await nbtTablePage(
      engine,
      list.node.id,
      0,
      2,
      0,
      4,
      0,
      false,
      signal,
    );
    expect(table.columns.map((column) => column.name)).toEqual([
      "a",
      "duplicate",
      "duplicate",
      "missing",
    ]);
    expect(table.rows[1]?.cells.map((cell) => cell?.value ?? null)).toEqual([
      "changed type",
      10,
      20,
      null,
    ]);
    expect(table.rows[1]?.cells[0]?.node.type).toBe(NbtTag.String);
    const next = await nbtTablePage(
      engine,
      list.node.id,
      0,
      2,
      2,
      2,
      0,
      true,
      signal,
    );
    expect(next.rows[0]?.ordinal).toBe(1);
    expect(next.rows[0]?.cells.map((cell) => cell?.value ?? null)).toEqual([
      20,
      null,
    ]);
    const serialized = [];
    for await (const chunk of engine.serialize(true)) serialized.push(chunk);
    expect(Buffer.concat(serialized)).toEqual(bytes);
  } finally {
    await engine.close();
  }
});
it("finds full string values and paths in unopened subtrees with case-sensitive matching", async () => {
  const { engine } = await fixture([
    compound("hidden", [
      str("full", "x".repeat(49000) + "NEEDLE"),
      compound("escaped/name", [str("~key", "value")]),
    ]),
  ]);
  const services: NbtDocumentSearch[] = [];
  try {
    const result = await search(engine, { text: "needle", fields: ["value"] });
    services.push(result.service);
    expect(result.status.state).toBe("complete");
    expect(result.status.count).toBe(1);
    expect((await engine.getNode(result.results[0]!.nodeId))?.type).toBe(
      NbtTag.String,
    );
    const sensitive = await search(engine, {
      text: "needle",
      fields: ["value"],
      caseSensitive: true,
    });
    services.push(sensitive.service);
    expect(sensitive.status.count).toBe(0);
    const path = await search(engine, {
      text: "/hidden/escaped~1name/~0key",
      fields: ["path"],
    });
    services.push(path.service);
    expect(path.status.count).toBe(1);
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await engine.close();
  }
});
it("matches exact Longs without floating-point aliases, including array elements", async () => {
  const { engine } = await fixture([
    { name: "a", tag: { type: NbtTag.Long, value: 9007199254740992n } },
    { name: "b", tag: { type: NbtTag.Long, value: 9007199254740993n } },
    {
      name: "array",
      tag: {
        type: NbtTag.LongArray,
        length: 3,
        value: [9007199254740992n, 9007199254740993n, -1n],
      },
    },
  ]);
  const result = await search(engine, {
    text: "9007199254740993",
    fields: ["value"],
    exactNumber: true,
  });
  try {
    expect(result.status.count).toBe(2);
    expect(result.results[1]?.elementIndex).toBe(1);
    expect(exactNumeric(9007199254740992, "9007199254740993")).toBe(false);
    expect(exactNumeric(Infinity, "9".repeat(400))).toBe(false);
    expect(exactNumeric(-0, "-0")).toBe(true);
    expect(exactNumeric(0, "-0")).toBe(false);
    expect(exactNumeric(Infinity, "infinity")).toBe(true);
    expect(exactNumeric(NaN, "infinity")).toBe(false);
  } finally {
    await result.service.close();
    await engine.close();
  }
});
it("restricts searches to a selected subtree", async () => {
  const { engine } = await fixture([
    compound("selected", [str("one", "hit")]),
    str("outside", "hit"),
  ]);
  const selected = (await engine.rows(engine.snapshot().root!, 0, 1))[0]!,
    result = await search(engine, {
      text: "hit",
      scope: selected.node.id,
      fields: ["value"],
    });
  try {
    expect(result.status.count).toBe(1);
    expect(
      (await nbtAncestors(engine, result.results[0]!.nodeId, signal)).some(
        (node) => node.id === selected.node.id,
      ),
    ).toBe(true);
  } finally {
    await result.service.close();
    await engine.close();
  }
});
it("matches across text page boundaries and a split supplementary case mapping", async () => {
  const query = {
    text: "𐐨needle",
    caseSensitive: false,
    exactNumber: false,
    fields: ["value"] as const,
  };
  const stream = (async function* () {
    yield "prefix\ud801";
    yield "\udc00nee";
    yield "dle suffix";
  })();
  expect(
    await streamMatches(stream, { ...query, fields: ["value"] }, signal),
  ).toBe(true);
});
it("pages encrypted scattered results and compresses dense array matches into bounded runs", async () => {
  const results = await NbtSearchResults.open("query/results");
  try {
    for (let i = 0; i < 300; i++)
      await results.append("node:" + i, undefined, ["value"]);
    await results.appendRange("node:301", 0, 100000000, ["value", "type"]);
    expect(results.count).toBe(100000300);
    expect(
      (await results.read(250, 60)).map((row) => row.nodeId).slice(0, 50),
    ).toEqual(Array.from({ length: 50 }, (_, i) => "node:" + (250 + i)));
    const tail = await results.read(results.count - 2, 128);
    expect(tail.map((row) => row.elementIndex)).toEqual([99999998, 99999999]);
  } finally {
    await results.close();
  }
});
it("does not advertise complete search counts for a corrupt gzip stream", async () => {
  const chunks = [];
  for await (const bytes of encodeNbtPayload(
    { name: "", tag: { type: NbtTag.Compound, value: [str("name", "hit")] } },
    JAVA_NBT,
  ))
    chunks.push(bytes);
  const raw = gzipSync(Buffer.concat(chunks));
  raw[raw.length - 8]! ^= 1;
  const engine = await NbtDocumentEngine.open(memoryNbtSource(raw), {
      binding: crypto.randomUUID(),
      format: { ...JAVA_NBT, compression: "gzip" },
    }),
    result = await search(engine, { text: "hit", fields: ["value"] });
  try {
    expect(result.status.state).toBe("error");
  } finally {
    await result.service.close();
    await engine.close();
  }
});
it("streams results before indexing finishes and cancels stale searches without leaking later siblings into a scope", async () => {
  const chunks = [];
  for await (const bytes of encodeNbtPayload(
    {
      name: "",
      tag: {
        type: NbtTag.Compound,
        value: [
          compound("selected", [
            str("early", "hit"),
            {
              name: "payload",
              tag: {
                type: NbtTag.ByteArray,
                length: 200000,
                value: new Uint8Array(200000),
              },
            },
          ]),
          str("outside", "hit"),
        ],
      },
    },
    JAVA_NBT,
  ))
    chunks.push(bytes);
  const bytes = Buffer.concat(chunks),
    raw = memoryNbtSource(bytes);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const engine = await NbtDocumentEngine.open(
    {
      size: bytes.length,
      async read(offset, length, abort) {
        if (offset >= 65536) {
          await Promise.race([
            waiting,
            new Promise((_, reject) =>
              abort?.addEventListener("abort", () => reject(abort.reason), {
                once: true,
              }),
            ),
          ]);
        }
        return raw.read(offset, length, abort);
      },
    },
    { binding: crypto.randomUUID(), format: JAVA_NBT },
  );
  let status: NbtSearchStatus | undefined;
  const service = new NbtDocumentSearch(
    engine,
    crypto.randomUUID(),
    (next) => (status = next),
  );
  const wait = async (test: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error("Progress timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await wait(() => engine.snapshot().nodes >= 4);
    const selected = (await engine.rows(engine.snapshot().root!, 0, 1))[0]!;
    service.start("early", {
      text: "hit",
      fields: ["value"],
      caseSensitive: false,
      exactNumber: false,
      scope: selected.node.id,
    });
    await wait(() => Boolean(status?.count));
    expect(status?.state).toBe("searching");
    expect(status?.count).toBe(1);
    await service.cancel("early");
    await expect(service.results("early", 0, 1)).rejects.toThrow("replaced");
    service.start("next", {
      text: "hit",
      fields: ["value"],
      caseSensitive: false,
      exactNumber: false,
      scope: selected.node.id,
    });
    release();
    await wait(() => status?.id === "next" && status.state !== "searching");
    expect(status?.state).toBe("complete");
    expect(status?.count).toBe(1);
  } finally {
    release();
    await service.close();
    await engine.close();
  }
});
it("skips impossible numeric array searches and treats decimal exact Int queries like scalar Ints", async () => {
  const { engine } = await fixture([
    {
      name: "bytes",
      tag: { type: NbtTag.ByteArray, length: 4, value: [-128, 0, 42, 127] },
    },
    {
      name: "ints",
      tag: { type: NbtTag.IntArray, length: 2, value: [42, -2147483648] },
    },
    {
      name: "longs",
      tag: { type: NbtTag.LongArray, length: 1, value: [9007199254740993n] },
    },
  ]);
  const original = engine.array.bind(engine),
    reads: number[] = [];
  engine.array = async (...args) => {
    reads.push((await engine.getNode(args[0]))!.type);
    return original(...args);
  };
  const services: NbtDocumentSearch[] = [];
  try {
    const long = await search(engine, {
      text: "9007199254740993",
      fields: ["name", "value"],
      exactNumber: true,
    });
    services.push(long.service);
    expect(long.status.count).toBe(1);
    expect(reads).toEqual([NbtTag.LongArray]);
    reads.length = 0;
    const decimal = await search(engine, {
      text: "42.0",
      fields: ["value"],
      exactNumber: true,
    });
    services.push(decimal.service);
    expect(decimal.status.count).toBe(2);
    expect(reads).toEqual([NbtTag.ByteArray, NbtTag.IntArray]);
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await engine.close();
  }
});

it("rank-selects a deeply expanded tree without recursing on the JavaScript stack", async () => {
  const depth = 4000,
    bytes = new Uint8Array(depth * 4 + 7);
  for (let i = 0; i < depth; i++) bytes.set([10, 0, 0], i * 3);
  bytes.set([3, 0, 0, 0, 0, 0, 42], depth * 3);
  const engine = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
    binding: crypto.randomUUID(),
    format: JAVA_NBT,
    indexPages: 16,
    cacheBytes: 128 * 1024,
  });
  try {
    await engine.completed;
    const page = await nbtTreePage(
      engine,
      Array.from({ length: depth }, (_, i) => "node:" + i),
      depth,
      1,
      undefined,
      signal,
    );
    expect(page.total).toBe(depth + 1);
    expect(page.rows[0]?.depth).toBe(depth);
    expect(page.rows[0]?.row.value).toBe(42);
  } finally {
    await engine.close();
  }
});
