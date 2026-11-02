import { expect, it, vi } from "vitest";
import * as reference from "nbtify";
import { gzipSync } from "node:zlib";
import {
  JAVA_NBT,
  BEDROCK_NBT,
  NETWORK_NBT,
  NbtTag,
  encodeNbtPayload,
  encodeNbtFile,
  memoryNbtSource,
  type NbtEntry,
  type NbtFormat,
} from "../src/index.js";
import { NbtDocumentEngine } from "../src/document/engine.js";
import {
  NbtDocumentSession,
  serializeNbtEdits,
  type NbtEditOperation,
} from "../src/edit/index.js";
import { NbtPersistentMap, NbtSequence } from "../src/edit/persistent.js";
import { nbtTreePage } from "../src/view/tree.js";
import { NbtDocumentSearch } from "../src/search/search.js";
import { EncryptedNbtPageCache } from "../src/storage/index.js";
import type { NbtSearchStatus } from "../src/search/types.js";
const signal = new AbortController().signal;
async function collect(stream: AsyncIterable<Uint8Array>) {
  const parts = [];
  for await (const bytes of stream) parts.push(new Uint8Array(bytes));
  return new Uint8Array(Buffer.concat(parts));
}
const int = (name: string, value: number): NbtEntry => ({
    name,
    tag: { type: NbtTag.Int, value },
  }),
  str = (name: string, value: string): NbtEntry => ({
    name,
    tag: { type: NbtTag.String, value },
  });
async function open(entries: NbtEntry[], format: NbtFormat = JAVA_NBT) {
  const payload = await collect(
      encodeNbtPayload(
        { name: "root", tag: { type: NbtTag.Compound, value: entries } },
        format,
      ),
    ),
    bytes = await collect(
      encodeNbtFile(memoryNbtSource(payload), format, { levelVersion: 7 }),
    ),
    engine = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
      binding: crypto.randomUUID(),
      format,
      indexPages: 16,
      cacheBytes: 128 * 1024,
    });
  await engine.completed;
  const session = await NbtDocumentSession.open(engine, "version-1"),
    root = engine.snapshot().root!;
  return {
    engine,
    session,
    root,
    bytes,
    async close() {
      await session.close();
      await engine.close();
    },
  };
}
async function named(session: NbtDocumentSession, parent: string) {
  const view = session.view(),
    result = [];
  for (const node of await view.getChildren(parent, 0, 512))
    result.push(await view.describe(node));
  return result;
}
async function edit(session: NbtDocumentSession, op: NbtEditOperation) {
  return session.apply([op]);
}
it("uses persistent weighted sequences and maps without changing retained roots", () => {
  let sequence = NbtSequence.from("baseline", 1000000),
    expected = Array.from({ length: 1000 }, (_, i) => i),
    small = NbtSequence.from(expected.slice(), expected.length),
    seed = 17;
  const snapshots = [];
  const random = () =>
    ((seed = Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 1000; i++) {
    if (i % 100 === 0)
      snapshots.push({ tree: small, values: expected.slice() });
    const at = Math.floor(random() * (expected.length + 1)),
      remove = Math.min(Math.floor(random() * 4), expected.length - at),
      values = [-i, -i - 1].slice(0, Math.floor(random() * 3));
    small = small.splice(at, remove, NbtSequence.from(values, values.length));
    expected.splice(at, remove, ...values);
  }
  const read = (tree: NbtSequence<number[]>) =>
    [...tree.slices()].flatMap((piece) =>
      piece.data.slice(piece.offset, piece.offset + piece.count),
    );
  expect(read(small)).toEqual(expected);
  for (const snapshot of snapshots)
    expect(read(snapshot.tree)).toEqual(snapshot.values);
  sequence = sequence.splice(500000, 1, NbtSequence.from("new", 1));
  expect(
    [...sequence.slices(499999, 3)].map((piece) => [
      piece.data,
      piece.offset,
      piece.count,
    ]),
  ).toEqual([
    ["baseline", 499999, 1],
    ["new", 0, 1],
    ["baseline", 500001, 1],
  ]);
  let map = new NbtPersistentMap<number>();
  for (let i = 0; i < 1000; i++) map = map.set("key:" + i, i);
  const before = map;
  for (let i = 0; i < 1000; i += 2) map = map.delete("key:" + i);
  for (let i = 0; i < 1000; i++) {
    expect(before.get("key:" + i)).toBe(i);
    expect(map.get("key:" + i)).toBe(i % 2 ? i : undefined);
  }
});
it.each([JAVA_NBT, BEDROCK_NBT, NETWORK_NBT])(
  "streams edited and duplicated numeric arrays without decoding value pages for %j",
  async (format) => {
    for (const type of [
      NbtTag.ByteArray,
      NbtTag.IntArray,
      NbtTag.LongArray,
    ] as const) {
      const values = Array.from({ length: 16385 }, (_, i) =>
        type === NbtTag.LongArray ? BigInt(i % 128) : i % 128,
      );
      const f = await open(
        [
          {
            name: "array",
            tag: {
              type,
              length: values.length,
              value: values,
            } as NbtEntry["tag"],
          },
        ],
        format,
      );
      try {
        const id = (await named(f.session, f.root))[0]!.node.id;
        await edit(f.session, {
          type: "array.splice",
          id,
          index: values.length - 1,
          remove: 1,
          values: ["-1", "-2"],
        });
        await edit(f.session, {
          type: "duplicate",
          id,
          parent: f.root,
          index: 1,
          name: "snapshot",
        });
        await edit(f.session, {
          type: "array.splice",
          id,
          index: values.length,
          remove: 1,
          values: ["3"],
        });
        const view = f.session.view(),
          decoded = vi.spyOn(view, "array"),
          baselineDecoded = vi.spyOn(f.engine, "array");
        const bytes = await collect(serializeNbtEdits(view, format));
        expect(decoded).not.toHaveBeenCalled();
        expect(baselineDecoded).not.toHaveBeenCalled();
        const reopened = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
          binding: crypto.randomUUID(),
          format,
        });
        try {
          const result = await reopened.completed,
            rows = await reopened.rows(result.root, 0, 2);
          const n = (value: number) =>
            type === NbtTag.LongArray ? BigInt(value) : value;
          expect(
            await reopened.array(rows[0]!.node.id, values.length - 1, 2),
          ).toEqual([n(-1), n(3)]);
          expect(
            await reopened.array(rows[1]!.node.id, values.length - 1, 2),
          ).toEqual([n(-1), n(-2)]);
        } finally {
          await reopened.close();
        }
      } finally {
        await f.close();
      }
    }
  },
);
it("validates typed scalar edits, preserves exact Longs, and commits transactions atomically", async () => {
  const f = await open([
    int("int", 1),
    { name: "long", tag: { type: NbtTag.Long, value: 9007199254740993n } },
    { name: "float", tag: { type: NbtTag.Float, value: -0 } },
  ]);
  try {
    const rows = await named(f.session, f.root),
      integer = rows[0]!.node.id,
      long = rows[1]!.node.id;
    await expect(
      edit(f.session, { type: "value", id: integer, value: "2147483648" }),
    ).rejects.toThrow("range");
    expect(f.session.snapshot().dirty).toBe(false);
    await expect(
      f.session.apply([
        { type: "value", id: integer, value: "42" },
        { type: "value", id: long, value: "9223372036854775808" },
      ]),
    ).rejects.toThrow("range");
    expect((await named(f.session, f.root))[0]?.value).toBe(1);
    await edit(f.session, {
      type: "value",
      id: long,
      value: "9223372036854775807",
    });
    expect((await named(f.session, f.root))[1]?.value).toBe(
      9223372036854775807n,
    );
    expect(f.session.snapshot().dirty).toBe(true);
    await f.session.undo();
    expect((await named(f.session, f.root))[1]?.value).toBe(9007199254740993n);
    expect(f.session.snapshot().dirty).toBe(false);
    await f.session.redo();
    const bytes = await collect(serializeNbtEdits(f.session.view(), JAVA_NBT)),
      independent = await reference.read(bytes);
    expect(independent.data.long).toBe(9223372036854775807n);
    expect(Object.is(Number(independent.data.float), -0)).toBe(true);
  } finally {
    await f.close();
  }
});
it("preserves existing duplicate names and keeps snapshots isolated through duplicate/edit/delete/undo", async () => {
  const f = await open([
    {
      name: "original",
      tag: {
        type: NbtTag.Compound,
        value: [int("same", 1), str("same", "second"), str("value", "before")],
      },
    },
    int("last", 99),
  ]);
  try {
    const original = (await named(f.session, f.root))[0]!.node.id;
    const copy = (
      await edit(f.session, {
        type: "duplicate",
        id: original,
        parent: f.root,
        index: 1,
        name: "copy",
      })
    ).selection;
    let copied = await named(f.session, copy);
    expect(copied.map((row) => row.name)).toEqual(["same", "same", "value"]);
    const sourceValue = (await named(f.session, original))[2]!.node.id;
    await edit(f.session, { type: "value", id: sourceValue, value: "after" });
    expect((await named(f.session, copy))[2]?.value).toBe("before");
    await edit(f.session, {
      type: "insert",
      parent: copy,
      index: 1,
      name: "added",
      value: { type: NbtTag.Long, value: "9007199254740993" },
    });
    const second = (
      await edit(f.session, {
        type: "duplicate",
        id: copy,
        parent: f.root,
        index: 2,
        name: "second copy",
      })
    ).selection;
    expect((await named(f.session, second)).map((row) => row.name)).toEqual([
      "same",
      "added",
      "same",
      "value",
    ]);
    expect((await named(f.session, second))[1]?.value).toBe(9007199254740993n);
    copied = await named(f.session, copy);
    await edit(f.session, { type: "delete", id: copied[0]!.node.id });
    expect((await named(f.session, second)).length).toBe(4);
    await f.session.undo();
    expect((await named(f.session, copy)).length).toBe(4);
    await expect(
      edit(f.session, {
        type: "insert",
        parent: f.root,
        index: 0,
        name: "original",
        value: { type: NbtTag.Byte, value: "1" },
      }),
    ).rejects.toThrow("already exists");
    const bytes = await collect(serializeNbtEdits(f.session.view(), JAVA_NBT)),
      reopened = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
        binding: crypto.randomUUID(),
        format: JAVA_NBT,
      });
    try {
      await reopened.completed;
      const root = reopened.snapshot().root!,
        rows = await reopened.rows(root, 0, 128);
      expect(rows.map((row) => row.name)).toEqual([
        "original",
        "copy",
        "second copy",
        "last",
      ]);
      expect(
        (await reopened.rows(rows[1]!.node.id, 0, 128)).map((row) => row.name),
      ).toEqual(["same", "added", "same", "value"]);
    } finally {
      await reopened.close();
    }
    expect(f.session.view().snapshot().nodes).toBe(16);
  } finally {
    await f.close();
  }
});
it("enforces list declarations, keeps IDs stable after insertions, and supports explicit type replacement", async () => {
  const f = await open([
    {
      name: "items",
      tag: {
        type: NbtTag.List,
        elementType: NbtTag.Int,
        length: 2,
        value: [
          { type: NbtTag.Int, value: 1 },
          { type: NbtTag.Int, value: 2 },
        ],
      },
    },
  ]);
  try {
    const list = (await named(f.session, f.root))[0]!.node.id,
      old = (await named(f.session, list))[1]!.node.id;
    await expect(
      edit(f.session, {
        type: "insert",
        parent: list,
        index: 1,
        value: { type: NbtTag.Long, value: "3" },
      }),
    ).rejects.toThrow("declaration");
    await edit(f.session, {
      type: "insert",
      parent: list,
      index: 0,
      value: { type: NbtTag.Int, value: "0" },
    });
    expect((await f.session.view().getNode(old))?.ordinal).toBe(2);
    await expect(
      edit(f.session, {
        type: "replace",
        id: old,
        value: { type: NbtTag.String, value: "wrong" },
      }),
    ).rejects.toThrow("declaration");
    await edit(f.session, {
      type: "delete",
      id: (await named(f.session, list))[0]!.node.id,
    });
    expect((await f.session.view().getNode(old))?.ordinal).toBe(1);
    await edit(f.session, {
      type: "replace",
      id: list,
      value: {
        type: NbtTag.Compound,
        children: [
          {
            name: "long",
            tag: { type: NbtTag.Long, value: "-9223372036854775808" },
          },
        ],
      },
    });
    expect(await f.session.view().getNode(old)).toBeUndefined();
    expect((await named(f.session, list))[0]?.value).toBe(
      -9223372036854775808n,
    );
  } finally {
    await f.close();
  }
});
it.each([
  JAVA_NBT,
  { ...JAVA_NBT, compression: "gzip" as const },
  BEDROCK_NBT,
  { ...BEDROCK_NBT, bedrockLevel: true },
  NETWORK_NBT,
])(
  "round-trips edited arrays, strings and structural values with profile %j",
  async (format) => {
    const f = await open(
      [
        {
          name: "array",
          tag: {
            type: NbtTag.LongArray,
            length: 3,
            value: [1n, 9007199254740993n, -1n],
          },
        },
        str("text", "A😀B"),
        int("keep", 42),
      ],
      format,
    );
    try {
      const [array, text] = await named(f.session, f.root);
      await edit(f.session, {
        type: "array.splice",
        id: array!.node.id,
        index: 1,
        remove: 1,
        values: ["9223372036854775807", "-9223372036854775808"],
      });
      expect(await f.session.view().array(array!.node.id, 0, 4096)).toEqual([
        1n,
        9223372036854775807n,
        -9223372036854775808n,
        -1n,
      ]);
      await expect(
        edit(f.session, {
          type: "string.splice",
          id: text!.node.id,
          offset: 2,
          remove: 0,
          text: "x",
        }),
      ).rejects.toThrow("boundaries");
      const remove = format.strings === "mutf8" ? 6 : 4;
      await edit(f.session, {
        type: "string.splice",
        id: text!.node.id,
        offset: 1,
        remove,
        text: "updated",
      });
      await edit(f.session, {
        type: "rename",
        id: text!.node.id,
        name: "renamed",
      });
      const bytes = await collect(
          serializeNbtEdits(f.session.view(), format, { levelVersion: 7 }),
        ),
        engine = await NbtDocumentEngine.open(memoryNbtSource(bytes), {
          binding: crypto.randomUUID(),
          format,
        });
      try {
        const result = await engine.completed,
          rows = await engine.rows(result.root, 0, 128);
        expect(rows.map((row) => row.name)).toEqual([
          "array",
          "renamed",
          "keep",
        ]);
        expect(rows[1]?.value).toBe("AupdatedB");
        expect(await engine.array(rows[0]!.node.id, 0, 4096)).toEqual([
          1n,
          9223372036854775807n,
          -9223372036854775808n,
          -1n,
        ]);
        if (format.bedrockLevel) expect(result.levelVersion).toBe(7);
      } finally {
        await engine.close();
      }
    } finally {
      await f.close();
    }
  },
);
it("searches and reveals unsaved inserted, renamed, duplicated and deleted tags", async () => {
  const f = await open([str("old", "baseline")]);
  let status: NbtSearchStatus | undefined;
  const service = new NbtDocumentSearch(
    () => f.session.view(),
    crypto.randomUUID(),
    (next) => (status = next),
  );
  try {
    const old = (await named(f.session, f.root))[0]!.node.id;
    await edit(f.session, { type: "rename", id: old, name: "renamed" });
    await edit(f.session, { type: "value", id: old, value: "draft needle" });
    const added = (
      await edit(f.session, {
        type: "insert",
        parent: f.root,
        index: 0,
        name: "added",
        value: {
          type: NbtTag.Compound,
          children: [
            {
              name: "nested",
              tag: { type: NbtTag.String, value: "draft needle" },
            },
          ],
        },
      })
    ).selection;
    const copy = (
      await edit(f.session, {
        type: "duplicate",
        id: added,
        parent: f.root,
        index: 1,
        name: "copy",
      })
    ).selection;
    await edit(f.session, { type: "delete", id: added });
    service.start("draft", {
      text: "needle",
      fields: ["value"],
      caseSensitive: false,
      exactNumber: false,
    });
    const deadline = Date.now() + 5000;
    while (status?.state !== "complete") {
      if (status?.state === "error") throw new Error(status.error?.message);
      if (Date.now() > deadline) throw new Error("Search timed out");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(status.count).toBe(2);
    const results = await service.results("draft", 0, 128);
    expect(results.some((row) => row.nodeId.startsWith("copy:"))).toBe(true);
    const tree = await nbtTreePage(
      f.session.view(),
      [f.root, copy],
      0,
      128,
      results[0]!.nodeId,
      signal,
    );
    expect(tree.rows.map((row) => row.row.name)).toEqual([
      "root",
      "copy",
      "nested",
      "renamed",
    ]);
    expect(tree.anchorIndex).toBe(2);
  } finally {
    await service.close();
    await f.close();
  }
});
it("keeps new edits dirty when an older save snapshot is acknowledged and records uncertain outcomes", async () => {
  const f = await open([int("n", 1)]);
  try {
    const id = (await named(f.session, f.root))[0]!.node.id;
    await edit(f.session, { type: "value", id, value: "2" });
    await f.session.beginSave("save-1");
    await edit(f.session, { type: "value", id, value: "3" });
    expect(
      (
        await f.session
          .saveView("save-1")
          .scalar((await f.session.saveView("save-1").getNode(id))!)
      ).value,
    ).toBe(2);
    await f.session.acknowledgeSave("save-1", "version-2");
    expect(f.session.snapshot()).toMatchObject({
      dirty: true,
      version: "version-2",
      saving: false,
    });
    await f.session.undo();
    expect(f.session.snapshot().dirty).toBe(false);
    await f.session.beginSave("save-2");
    await f.session.failSave("save-2", true);
    expect(f.session.snapshot().dirty).toBe(true);
  } finally {
    await f.close();
  }
});
it("preserves unrelated NaN payload bits and source bytes during a nearby edit", async () => {
  const payload = await collect(
    encodeNbtPayload(
      {
        name: "",
        tag: {
          type: NbtTag.Compound,
          value: [
            { name: "nan", tag: { type: NbtTag.Float, value: NaN } },
            int("change", 1),
          ],
        },
      },
      JAVA_NBT,
    ),
  );
  const engine = await NbtDocumentEngine.open(memoryNbtSource(payload), {
    binding: crypto.randomUUID(),
    format: JAVA_NBT,
  });
  await engine.completed;
  const root = engine.snapshot().root!,
    rows = await engine.rows(root, 0, 128),
    nan = rows[0]!.node;
  await engine.close();
  new DataView(payload.buffer).setUint32(nan.payload, 0x7fa12345, false);
  const baseline = payload.slice(),
    next = await NbtDocumentEngine.open(memoryNbtSource(payload), {
      binding: crypto.randomUUID(),
      format: JAVA_NBT,
    });
  await next.completed;
  const session = await NbtDocumentSession.open(next, "v1");
  try {
    await edit(session, { type: "value", id: rows[1]!.node.id, value: "2" });
    const saved = await collect(serializeNbtEdits(session.view(), JAVA_NBT));
    expect(new DataView(saved.buffer).getUint32(nan.payload, false)).toBe(
      0x7fa12345,
    );
    expect(payload).toEqual(baseline);
  } finally {
    await session.close();
    await next.close();
  }
});

it("creates every value tag type as one undoable typed transaction", async () => {
  const f = await open([]);
  try {
    const values = [
      { type: NbtTag.Byte, value: "-128" },
      { type: NbtTag.Short, value: "32767" },
      { type: NbtTag.Int, value: "-2147483648" },
      { type: NbtTag.Long, value: "9223372036854775807" },
      { type: NbtTag.Float, value: "-0" },
      { type: NbtTag.Double, value: "-Infinity" },
      { type: NbtTag.ByteArray, values: ["-128", "127"] },
      { type: NbtTag.String, value: "Unicode 😀" },
      {
        type: NbtTag.List,
        elementType: NbtTag.String,
        items: [{ type: NbtTag.String, value: "item" }],
      },
      {
        type: NbtTag.Compound,
        children: [{ name: "key", tag: { type: NbtTag.Int, value: "42" } }],
      },
      { type: NbtTag.IntArray, values: ["-2147483648", "2147483647"] },
      {
        type: NbtTag.LongArray,
        values: ["-9223372036854775808", "9223372036854775807"],
      },
    ];
    await f.session.apply(
      values.map((value, i) => ({
        type: "insert",
        parent: f.root,
        index: i,
        name: "tag" + i,
        value,
      })),
    );
    const encoded = await collect(
        serializeNbtEdits(f.session.view(), JAVA_NBT),
      ),
      engine = await NbtDocumentEngine.open(memoryNbtSource(encoded), {
        binding: crypto.randomUUID(),
        format: JAVA_NBT,
      });
    try {
      await engine.completed;
      const rows = await engine.rows(engine.snapshot().root!, 0, 128);
      expect(rows.map((row) => row.node.type)).toEqual(
        values.map((value) => value.type),
      );
      expect(Object.is(rows[4]?.value, -0)).toBe(true);
      expect(rows[5]?.value).toBe(-Infinity);
      expect(rows[7]?.value).toBe("Unicode 😀");
    } finally {
      await engine.close();
    }
    await f.session.undo();
    expect((await named(f.session, f.root)).length).toBe(0);
    expect(f.session.snapshot().dirty).toBe(false);
    await f.session.redo();
    expect((await named(f.session, f.root)).length).toBe(12);
  } finally {
    await f.close();
  }
});
it("edits and searches a long network string through bounded byte pieces", async () => {
  const f = await open(
    [str("large", "a".repeat(1000000) + "old")],
    NETWORK_NBT,
  );
  let status: NbtSearchStatus | undefined;
  const search = new NbtDocumentSearch(
    () => f.session.view(),
    crypto.randomUUID(),
    (next) => (status = next),
  );
  try {
    const id = (await named(f.session, f.root))[0]!.node.id,
      reads = f.engine.snapshot().sourceBytesRead;
    await edit(f.session, {
      type: "string.splice",
      id,
      offset: 1000000,
      remove: 3,
      text: "NEW_NEEDLE",
    });
    search.start("tail", {
      text: "NEW_NEEDLE",
      fields: ["value"],
      caseSensitive: true,
      exactNumber: false,
    });
    const until = Date.now() + 5000;
    while (status?.state !== "complete") {
      if (status?.state === "error") throw new Error(status.error?.message);
      if (Date.now() > until) throw new Error("Long string search timed out");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(status.count).toBe(1);
    const bytes = await collect(
      serializeNbtEdits(f.session.view(), NETWORK_NBT),
    );
    expect(Buffer.from(bytes).subarray(-10).toString()).toBe("EW_NEEDLE\0");
    expect(f.engine.snapshot().sourceBytesRead).toBe(reads);
    await f.session.undo();
    expect((await f.session.view().getNode(id))?.data?.length).toBe(1000003);
  } finally {
    await search.close();
    await f.close();
  }
});
it("keeps memory and the encrypted journal aligned if cancellation arrives after the commit point", async () => {
  const f = await open([int("value", 1)]),
    controller = new AbortController();
  try {
    const id = (await named(f.session, f.root))[0]!.node.id,
      write = f.session.data.journal.bind(f.session.data),
      spy = vi
        .spyOn(f.session.data, "journal")
        .mockImplementation(async (...args) => {
          await write(...args);
          controller.abort();
        });
    await f.session.apply(
      [{ type: "value", id, value: "2" }],
      0,
      controller.signal,
    );
    spy.mockRestore();
    expect((await named(f.session, f.root))[0]?.value).toBe(2);
    expect(f.session.snapshot().dirty).toBe(true);
    await f.session.undo();
    expect((await named(f.session, f.root))[0]?.value).toBe(1);
  } finally {
    await f.close();
  }
});

it("keeps applying the current scalar value clean without normalizing untouched float payloads", async () => {
  const f = await open([
    { name: "nan", tag: { type: NbtTag.Float, value: NaN } },
    str("text", "same"),
  ]);
  try {
    const rows = await named(f.session, f.root);
    await edit(f.session, {
      type: "value",
      id: rows[0]!.node.id,
      value: "NaN",
    });
    await edit(f.session, {
      type: "value",
      id: rows[1]!.node.id,
      value: "same",
    });
    expect(f.session.snapshot()).toMatchObject({ dirty: false, revision: 0 });
  } finally {
    await f.close();
  }
});

it("pages a full 4096-Long edit journal without exceeding encrypted cache page limits", async () => {
  const f = await open([
    { name: "array", tag: { type: NbtTag.LongArray, length: 0, value: [] } },
  ]);
  try {
    const id = (await named(f.session, f.root))[0]!.node.id,
      values = Array.from({ length: 4096 }, () => "9223372036854775807");
    await edit(f.session, {
      type: "array.splice",
      id,
      index: 0,
      remove: 0,
      values,
    });
    expect(await f.session.view().array(id, 4094, 2)).toEqual([
      9223372036854775807n,
      9223372036854775807n,
    ]);
    expect(await f.session.data.readJournal(1)).toMatchObject({
      version: 1,
      kind: "apply",
      operations: [{ type: "array.splice", values }],
    });
  } finally {
    await f.close();
  }
});
it("retains readable prior draft bytes after an edit page write fails, then accepts a retry", async () => {
  const f = await open([str("text", "baseline")]);
  try {
    const id = (await named(f.session, f.root))[0]!.node.id;
    await f.session.apply([{ type: "value", id, value: "existing draft" }]);
    const write = EncryptedNbtPageCache.prototype.set;
    let fail = true;
    const fault = vi
      .spyOn(EncryptedNbtPageCache.prototype, "set")
      .mockImplementation(async function (key, bytes) {
        if (fail && key.startsWith("bytes-")) {
          fail = false;
          throw new Error("Injected edit storage exhaustion");
        }
        return write.call(this, key, bytes);
      });
    try {
      await expect(
        f.session.apply([{ type: "value", id, value: "x".repeat(65535) }]),
      ).rejects.toThrow("storage exhaustion");
      expect((await named(f.session, f.root))[0]!.value).toBe("existing draft");
      expect(f.session.snapshot().dirty).toBe(true);
      await f.session.apply([{ type: "value", id, value: "retry works" }]);
      expect((await named(f.session, f.root))[0]!.value).toBe("retry works");
      await f.session.undo();
      expect((await named(f.session, f.root))[0]!.value).toBe("existing draft");
    } finally {
      fault.mockRestore();
    }
  } finally {
    await f.close();
  }
});
