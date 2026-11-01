import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import * as reference from "nbtify";
import {
  JAVA_NBT,
  NbtTag,
  encodeNbtPayload,
  memoryNbtSource,
  type NbtByteSource,
} from "../src/index.js";
import { NbtDocumentEngine } from "../src/document/engine.js";
import { NbtDocumentClient } from "../src/document/client.js";
import { installNbtDocumentWorker } from "../src/document/host.js";
import type {
  NbtDocumentRequest,
  NbtDocumentResponse,
  NbtMessageEndpoint,
} from "../src/document/types.js";
import { NbtDocumentSession, serializeNbtEdits } from "../src/edit/index.js";
import {
  NbtRecoveryJournal,
  NbtRecoveryConflict,
  openIndexedNbtRecovery,
  type NbtRecoveryStore,
  type NbtRecoveryEvent,
} from "../src/recovery/index.js";

async function collect(stream: AsyncIterable<Uint8Array>) {
  const parts = [];
  for await (const part of stream) parts.push(part.slice());
  return new Uint8Array(Buffer.concat(parts));
}
async function events(log: NbtRecoveryJournal) {
  const result: NbtRecoveryEvent[] = [];
  for await (const event of log.events()) result.push(event);
  return result;
}
const format = { ...JAVA_NBT, compression: "gzip" as const };
async function fixture() {
  const bytes = new Uint8Array(
      gzipSync(
        await collect(
          encodeNbtPayload(
            {
              name: "world",
              tag: {
                type: NbtTag.Compound,
                value: [
                  {
                    name: "name",
                    tag: { type: NbtTag.String, value: "Private world name" },
                  },
                  {
                    name: "long",
                    tag: { type: NbtTag.Long, value: 9007199254740993n },
                  },
                  {
                    name: "nested",
                    tag: {
                      type: NbtTag.Compound,
                      value: [
                        { name: "value", tag: { type: NbtTag.Int, value: 12 } },
                      ],
                    },
                  },
                  {
                    name: "bulk",
                    tag: {
                      type: NbtTag.ByteArray,
                      length: 1024 * 1024 + 1,
                      value: new Uint8Array(1024 * 1024 + 1).fill(7),
                    },
                  },
                ],
              },
            },
            JAVA_NBT,
          ),
        ),
      ),
    ),
    factory = new IDBFactory(),
    id = crypto.randomUUID(),
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  return { bytes, factory, id, key };
}
async function model(
  source: NbtByteSource,
  log: NbtRecoveryJournal,
  restore = false,
) {
  const engine = await NbtDocumentEngine.open(source, {
    binding: crypto.randomUUID(),
    format,
    cacheBytes: 128 * 1024,
    indexPages: 16,
  });
  await engine.completed;
  const session = await NbtDocumentSession.open(engine, "version-1", () => {}, {
    prepare: (signal) =>
      log.prepare(format, "version-1", engine.serialize(true, signal), signal),
    append: (event) => log.append(event),
  });
  if (restore) await session.restore(log.events());
  const root = engine.snapshot().root!;
  return {
    engine,
    session,
    root,
    async close() {
      await session.close();
      await engine.close();
    },
  };
}
async function rows(f: Awaited<ReturnType<typeof model>>, parent = f.root) {
  const view = f.session.view();
  return Promise.all(
    (await view.getChildren(parent, 0, 128)).map((node) => view.describe(node)),
  );
}

it("recovers edits, stable duplicate IDs, undo/redo and save roots from encrypted original bytes", async () => {
  const f = await fixture(),
    store = await openIndexedNbtRecovery(f.id, f.factory),
    encrypted: Uint8Array[] = [],
    originalPut = store.put;
  store.put = async (key, bytes) => {
    encrypted.push(bytes.slice());
    await originalPut(key, bytes);
  };
  let log = await NbtRecoveryJournal.open(store, "account/document", f.key),
    document = await model(memoryNbtSource(f.bytes), log);
  try {
    const first = await rows(document),
      nested = first[2]!.node.id,
      copy = await document.session.apply([
        {
          type: "duplicate",
          id: nested,
          parent: document.root,
          index: 3,
          name: "copy",
        },
      ]);
    const child = (await rows(document, copy.selection))[0]!.node.id;
    await document.session.apply([{ type: "value", id: child, value: "123" }]);
    await document.session.beginSave("save-one");
    await document.session.apply([
      { type: "value", id: first[1]!.node.id, value: "9223372036854775807" },
    ]);
    await document.session.acknowledgeSave("save-one", "version-2");
    await document.session.undo();
    expect(document.session.snapshot()).toMatchObject({
      dirty: false,
      canRedo: true,
      version: "version-2",
    });
    const expected = await collect(
      serializeNbtEdits(document.session.view(), format),
    );
    expect(encrypted.length).toBeGreaterThan(5);
    expect(encrypted.every((bytes) => bytes.length <= 64 * 1024 + 29)).toBe(
      true,
    );
    expect(
      encrypted.some((bytes) =>
        new TextDecoder().decode(bytes).includes("Private world name"),
      ),
    ).toBe(false);
    await document.close();
    await log.close();
    log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "account/document",
      f.key,
    );
    expect(log.descriptor()).toMatchObject({
      version: "version-1",
      size: f.bytes.length,
      events: 6,
    });
    document = await model(log.source(), log, true);
    expect(document.session.snapshot()).toMatchObject({
      dirty: false,
      canRedo: true,
      version: "version-2",
    });
    expect((await rows(document, copy.selection))[0]!.node.id).toBe(child);
    expect((await rows(document, copy.selection))[0]!.value).toBe(123);
    expect(
      await collect(serializeNbtEdits(document.session.view(), format)),
    ).toEqual(expected);
    await document.session.redo();
    const independent = await reference.read(
      await collect(serializeNbtEdits(document.session.view(), format)),
    );
    expect(independent.data.long).toBe(9223372036854775807n);
    expect(document.session.snapshot().dirty).toBe(true);
  } finally {
    await document.close();
    await log.close();
  }
});

it("replays committed node reservations after rejected structural transactions leave ID gaps", async () => {
  const f = await fixture();
  let log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    ),
    document = await model(memoryNbtSource(f.bytes), log);
  try {
    await expect(
      document.session.apply([
        {
          type: "insert",
          parent: document.root,
          index: 0,
          name: "temporary",
          value: { type: NbtTag.Int, value: "2" },
        },
        { type: "delete", id: "missing" },
      ]),
    ).rejects.toThrow("no longer available");
    const added = await document.session.apply([
      {
        type: "insert",
        parent: document.root,
        index: 0,
        name: "kept",
        value: { type: NbtTag.Int, value: "3" },
      },
    ]);
    expect(added.selection).toBe("edit:2");
    await document.session.apply([
      { type: "rename", id: added.selection, name: "renamed" },
    ]);
    await document.close();
    await log.close();
    log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
    document = await model(log.source(), log, true);
    expect((await rows(document))[0]).toMatchObject({
      name: "renamed",
      value: 3,
      node: { id: "edit:2" },
    });
    const next = await document.session.apply([
      {
        type: "insert",
        parent: document.root,
        index: 1,
        name: "next",
        value: { type: NbtTag.Int, value: "4" },
      },
    ]);
    expect(next.selection).toBe("edit:3");
  } finally {
    await document.close();
    await log.close();
  }
});

it("retains the prior durable draft after a journal page or head write fails, then permits an actual retry", async () => {
  const f = await fixture(),
    inner = await openIndexedNbtRecovery(f.id, f.factory);
  let fail: "page" | "head" | undefined;
  const store: NbtRecoveryStore = {
    ...inner,
    async put(key, bytes) {
      if (fail === "page") throw new DOMException("full", "QuotaExceededError");
      return inner.put(key, bytes);
    },
    async commit(revision, bytes) {
      if (fail === "head") throw new DOMException("full", "QuotaExceededError");
      return inner.commit(revision, bytes);
    },
  };
  const log = await NbtRecoveryJournal.open(store, "binding", f.key),
    document = await model(memoryNbtSource(f.bytes), log);
  try {
    const id = (await rows(document))[1]!.node.id;
    await document.session.apply([{ type: "value", id, value: "1" }]);
    for (const mode of ["page", "head"] as const) {
      fail = mode;
      await expect(
        document.session.apply([{ type: "value", id, value: "2" }]),
      ).rejects.toThrow("full");
      expect((await rows(document))[1]!.value).toBe(1n);
      expect(await events(log)).toHaveLength(1);
    }
    fail = undefined;
    await document.session.apply([{ type: "value", id, value: "3" }]);
    expect(await events(log)).toHaveLength(2);
    const reopened = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
    try {
      const recovered = await model(reopened.source(), reopened, true);
      try {
        expect((await rows(recovered))[1]!.value).toBe(3n);
      } finally {
        await recovered.close();
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await document.close();
    await log.close();
  }
});

it("fences concurrent writers and tombstones without overwriting or resurrecting the winning journal", async () => {
  const f = await fixture(),
    first = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
  await first.prepare(
    format,
    "version-1",
    (async function* () {
      yield f.bytes;
    })(),
  );
  const second = await NbtRecoveryJournal.open(
    await openIndexedNbtRecovery(f.id, f.factory),
    "binding",
    f.key,
  );
  try {
    await first.append({ kind: "save.begin", id: "winner" });
    await expect(
      second.append({ kind: "save.begin", id: "loser" }),
    ).rejects.toBeInstanceOf(NbtRecoveryConflict);
    expect(await events(first)).toEqual([{ kind: "save.begin", id: "winner" }]);
    await first.clear();
    await expect(second.clear()).rejects.toBeInstanceOf(NbtRecoveryConflict);
    const reopened = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
    try {
      expect(reopened.descriptor()).toBe(null);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    await second.close();
  }
});

it("restores a pending frozen save as uncertain while retaining newer dirty edits", async () => {
  const f = await fixture();
  let log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    ),
    document = await model(memoryNbtSource(f.bytes), log);
  try {
    const id = (await rows(document))[1]!.node.id;
    await document.session.apply([{ type: "value", id, value: "22" }]);
    await document.session.beginSave("pending");
    await document.session.apply([{ type: "value", id, value: "33" }]);
    await document.close();
    await log.close();
    log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
    document = await model(log.source(), log, true);
    expect(document.session.snapshot()).toMatchObject({
      saving: false,
      dirty: true,
      uncertain: true,
      pendingSaveId: "pending",
    });
    const saved = await reference.read(
      await collect(
        serializeNbtEdits(document.session.saveView("pending"), format),
      ),
    );
    expect(saved.data.long).toBe(22n);
    expect((await rows(document))[1]!.value).toBe(33n);
    await document.session.acknowledgeSave("pending", "version-2");
    expect(document.session.snapshot()).toMatchObject({
      dirty: true,
      uncertain: false,
      pendingSaveId: undefined,
      version: "version-2",
    });
    await document.session.undo();
    expect(document.session.snapshot().dirty).toBe(false);
  } finally {
    await document.close();
    await log.close();
  }
});

it("authenticates recovery against its account/document key and detects missing or damaged pages", async () => {
  const f = await fixture(),
    store = await openIndexedNbtRecovery(f.id, f.factory),
    keys: string[] = [],
    put = store.put;
  store.put = async (key, bytes) => {
    keys.push(key);
    await put(key, bytes);
  };
  const log = await NbtRecoveryJournal.open(store, "binding", f.key);
  try {
    await log.prepare(
      format,
      "version-1",
      (async function* () {
        yield f.bytes;
      })(),
    );
    const wrong = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await expect(
      NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(f.id, f.factory),
        "binding",
        wrong,
      ),
    ).rejects.toThrow("authentication");
    await expect(
      NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(f.id, f.factory),
        "another-document",
        f.key,
      ),
    ).rejects.toThrow("authentication");
    const bytes = (await store.get(keys[0]!))!;
    bytes[20]! ^= 1;
    await store.put(keys[0]!, bytes);
    await expect(log.source().read(0, 12)).rejects.toThrow("authentication");
  } finally {
    await log.close();
  }
});
it("streams an original larger than the memory cache and pages a large Unicode operation", async () => {
  const f = await fixture(),
    store = await openIndexedNbtRecovery(f.id, f.factory);
  let maxWrite = 0;
  const put = store.put;
  store.put = async (key, bytes) => {
    maxWrite = Math.max(maxWrite, bytes.length);
    await put(key, bytes);
  };
  let log = await NbtRecoveryJournal.open(store, "binding", f.key);
  const size = 2 * 1024 ** 2 + 19,
    value = "🔒".repeat(40000);
  try {
    await log.prepare(
      JAVA_NBT,
      "baseline",
      (async function* () {
        for (let at = 0; at < size; at += 32771)
          yield new Uint8Array(Math.min(32771, size - at)).fill(
            Math.floor(at / 32771) & 255,
          );
      })(),
    );
    const event: NbtRecoveryEvent = {
      kind: "apply",
      allocationStart: 0,
      allocationEnd: 0,
      operations: [{ type: "value", id: "node:1", value }],
      label: "A large string",
    };
    await log.append(event);
    expect(maxWrite).toBeLessThanOrEqual(64 * 1024 + 29);
    const expected = await log.source().read(65533, 256 * 1024);
    await log.close();
    log = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(f.id, f.factory),
      "binding",
      f.key,
    );
    expect(log.descriptor()?.size).toBe(size);
    expect(await log.source().read(65533, 256 * 1024)).toEqual(expected);
    expect(await events(log)).toEqual([event]);
    await expect(log.source().read(0, 256 * 1024 + 1)).rejects.toThrow(
      "bounded pages",
    );
  } finally {
    await log.close();
  }
});
it("does not accept the first edit until original-byte storage really succeeds", async () => {
  const f = await fixture(),
    inner = await openIndexedNbtRecovery(f.id, f.factory);
  let unavailable = true;
  const log = await NbtRecoveryJournal.open(
      {
        ...inner,
        async put(key, bytes) {
          if (unavailable)
            throw new DOMException(
              "Recovery disk is full",
              "QuotaExceededError",
            );
          await inner.put(key, bytes);
        },
      },
      "binding",
      f.key,
    ),
    document = await model(memoryNbtSource(f.bytes), log);
  try {
    const id = (await rows(document))[1]!.node.id;
    await expect(
      document.session.apply([{ type: "value", id, value: "5" }]),
    ).rejects.toThrow("disk is full");
    expect(document.session.snapshot().dirty).toBe(false);
    expect((await rows(document))[1]!.value).toBe(9007199254740993n);
    expect(log.descriptor()).toBe(null);
    unavailable = false;
    await document.session.apply([{ type: "value", id, value: "5" }]);
    expect((await rows(document))[1]!.value).toBe(5n);
    expect((await events(log)).length).toBe(1);
  } finally {
    await document.close();
    await log.close();
  }
});
it("pauses an opening recovered document and resumes replay only when its view becomes active", async () => {
  const f = await fixture();
  function pair() {
    const a = new Set<(event: MessageEvent<NbtDocumentResponse>) => void>(),
      b = new Set<(event: MessageEvent<NbtDocumentRequest>) => void>();
    function endpoint<In, Out>(
      own: Set<(event: MessageEvent<In>) => void>,
      other: Set<(event: MessageEvent<Out>) => void>,
    ): NbtMessageEndpoint<In, Out> {
      return {
        postMessage(message, transfer) {
          const copy = structuredClone(message, { transfer });
          queueMicrotask(() => {
            for (const listener of other)
              listener({ data: copy } as MessageEvent<Out>);
          });
        },
        addEventListener(_type, listener) {
          own.add(listener);
        },
        removeEventListener(_type, listener) {
          own.delete(listener);
        },
      };
    }
    return { main: endpoint(a, b), worker: endpoint(b, a) };
  }
  let endpoints = pair(),
    dispose = installNbtDocumentWorker(endpoints.worker);
  const options = {
    binding: "activity",
    version: "version-1",
    format,
    recovery: { id: f.id, key: f.key },
  };
  let client = await NbtDocumentClient.open(
    endpoints.main,
    new Blob([f.bytes]),
    options,
  );
  const until = async (test: () => boolean) => {
    const end = Date.now() + 5000;
    while (!test()) {
      if (Date.now() > end) throw new Error("Recovery condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  try {
    await until(() => client.getSnapshot()?.state === "complete");
    await client.edit([{ type: "value", id: "node:2", value: "9" }]);
    await client.close();
    await dispose();
    endpoints = pair();
    dispose = installNbtDocumentWorker(endpoints.worker);
    let early!: NbtDocumentClient,
      settled = false;
    const opening = NbtDocumentClient.open(
      endpoints.main,
      null,
      options,
      undefined,
      undefined,
      (created) => {
        early = created;
        void early.setPaused(true);
      },
    ).then((value) => {
      settled = true;
      return value;
    });
    await until(() => early.getSnapshot()?.state === "paused");
    const bytes = early.getSnapshot()!.availableBytes;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(early.getSnapshot()!.availableBytes).toBe(bytes);
    expect(settled).toBe(false);
    await early.setPaused(false);
    client = await opening;
    expect((await client.describe("node:2")).value).toBe(9n);
    expect(client.getEditSnapshot()?.dirty).toBe(true);
  } finally {
    await client.close();
    await dispose();
  }
});
