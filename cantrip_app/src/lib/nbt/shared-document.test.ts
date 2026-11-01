import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import {
  JAVA_NBT,
  NbtTag,
  encodeNbtPayload,
  type NbtEntry,
} from "@cantrip/nbt";
import {
  NbtDocumentClient,
  installNbtDocumentWorker,
  type NbtMessageEndpoint,
  type NbtDocumentRequest,
  type NbtDocumentResponse,
} from "@cantrip/nbt/document";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "@cantrip/nbt/recovery";
import {
  clearNbtSharedDocuments,
  NbtSharedDocument,
  nbtSharedDocument,
} from "./shared-document";
import { nbtSharedWire } from "./shared-wire";
import type { NbtSharedFactory } from "./shared-owner";
import { acquireNbtSession, NbtViewSession } from "./session-registry";
import { readNbtEditTarget } from "./edit-target";
import { resolveNbtView } from "./restore-view";
import type { NbtViewState } from "./view-state";

class Locks {
  private queues = new Map<
    string,
    Array<{
      signal?: AbortSignal;
      run(): Promise<void>;
      reject(error: unknown): void;
    }>
  >();
  private held = new Set<string>();
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const queue = this.queues.get(name),
          index = queue?.indexOf(item) ?? -1;
        if (index >= 0) {
          queue!.splice(index, 1);
          reject(options.signal!.reason);
        }
      };
      const item = {
        signal: options.signal,
        reject,
        run: async () => {
          options.signal?.removeEventListener("abort", abort);
          try {
            resolve(await callback({ name }));
          } catch (error) {
            reject(error);
          }
        },
      };
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(item);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.drain(name);
    });
  }
  private drain(name: string) {
    if (this.held.has(name)) return;
    const item = this.queues.get(name)?.shift();
    if (!item) return;
    this.held.add(name);
    queueMicrotask(() => {
      void item.run().finally(() => {
        this.held.delete(name);
        this.drain(name);
      });
    });
  }
}
function channels() {
  const ports = new Map<string, Set<Channel>>(),
    frames: unknown[] = [];
  class Channel {
    listeners = new Set<(event: MessageEvent) => void>();
    constructor(readonly name: string) {
      const group = ports.get(name) ?? new Set();
      group.add(this);
      ports.set(name, group);
    }
    postMessage(value: unknown) {
      frames.push(structuredClone(value));
      for (const port of ports.get(this.name) ?? [])
        if (port !== this) {
          const data = structuredClone(value);
          queueMicrotask(() => {
            for (const listener of port.listeners)
              listener({ data } as MessageEvent);
          });
        }
    }
    addEventListener(
      _type: "message",
      listener: (event: MessageEvent) => void,
    ) {
      this.listeners.add(listener);
    }
    removeEventListener(
      _type: "message",
      listener: (event: MessageEvent) => void,
    ) {
      this.listeners.delete(listener);
    }
    close() {
      ports.get(this.name)?.delete(this);
      this.listeners.clear();
    }
  }
  return { channel: (name: string) => new Channel(name), frames };
}
function pair() {
  const main = new Set<(event: MessageEvent<NbtDocumentResponse>) => void>(),
    worker = new Set<(event: MessageEvent<NbtDocumentRequest>) => void>();
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
  return { main: endpoint(main, worker), worker: endpoint(worker, main) };
}
async function until(test: () => boolean) {
  const end = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > end)
      throw new Error("Shared document condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
async function fixture({ holdTail = false } = {}) {
  let releaseTail = () => {};
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const extra: NbtEntry[] = holdTail
    ? [
        {
          name: "bytes",
          tag: {
            type: NbtTag.ByteArray,
            length: 200000,
            value: new Uint8Array(200000),
          },
        },
        { name: "after-array", tag: { type: NbtTag.Int, value: 42 } },
      ]
    : [];
  const id = crypto.randomUUID(),
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    parts = [];
  for await (const part of encodeNbtPayload(
    {
      name: "root",
      tag: {
        type: NbtTag.Compound,
        value: [
          {
            name: "privateName",
            tag: { type: NbtTag.Long, value: 9007199254740993n },
          },
          { name: "text", tag: { type: NbtTag.String, value: "Hidden data" } },
          ...extra,
        ],
      },
    },
    JAVA_NBT,
  ))
    parts.push(part.slice());
  const bytes = new Uint8Array(Buffer.concat(parts)),
    locks = new Locks(),
    ports = channels(),
    disposes: Array<() => Promise<void>> = [];
  const created: NbtDocumentClient[] = [],
    create = vi.fn(async (choice, signal, onCreated) => {
      const endpoints = pair(),
        dispose = installNbtDocumentWorker(endpoints.worker);
      disposes.push(dispose);
      const log = await NbtRecoveryJournal.open(
          await openIndexedNbtRecovery(id),
          id,
          key,
        ),
        descriptor = log.descriptor();
      await log.close();
      const client = await NbtDocumentClient.open(
        endpoints.main,
        !choice && descriptor
          ? null
          : holdTail
            ? {
                size: bytes.length,
                async read(
                  offset: number,
                  length: number,
                  signal?: AbortSignal,
                ) {
                  signal?.throwIfAborted();
                  if (offset >= 65536)
                    await new Promise<void>((resolve, reject) => {
                      const abort = () => {
                        cleanup();
                        reject(signal?.reason);
                      };
                      const cleanup = () =>
                        signal?.removeEventListener("abort", abort);
                      signal?.addEventListener("abort", abort, { once: true });
                      void tail.then(() => {
                        cleanup();
                        resolve();
                      });
                    });
                  signal?.throwIfAborted();
                  return bytes.slice(offset, offset + length);
                },
              }
            : new Blob([bytes]),
        {
          binding: id,
          version: "v1",
          format: choice?.format ?? JAVA_NBT,
          ...(!choice ? { recovery: { id, key } } : {}),
        },
        () => {
          void dispose();
        },
        signal,
        onCreated,
      );
      created.push(client);
      return client;
    }) as NbtSharedFactory["create"] & ReturnType<typeof vi.fn>;
  const factory: NbtSharedFactory = {
    create,
    async claim() {
      const log = await NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(id),
        id,
        key,
      );
      try {
        return await log.claim();
      } finally {
        await log.close();
      }
    },
    async attachRecovery(client) {
      await client.attachRecovery({ id, key });
    },
    async reconcile(client) {
      const pending = client.getEditSnapshot()?.pendingSaveId;
      if (pending) await client.failSave(pending, false);
    },
  };
  function renderer() {
    let valid = true;
    const invalidators = new Set<() => void>();
    return {
      open() {
        return NbtSharedDocument.open(
          {
            id,
            key,
            factory,
            locks: locks as unknown as LockManager,
            channel: ports.channel,
            assertCurrent() {
              if (!valid) throw new Error("Account locked");
            },
            onInvalidate(listener) {
              invalidators.add(listener);
              return () => {
                invalidators.delete(listener);
              };
            },
          },
          undefined,
          (client) => {
            void client.setPaused(false).catch(() => {});
          },
        );
      },
      invalidate() {
        valid = false;
        for (const listener of invalidators) listener();
      },
    };
  }
  return {
    id,
    key,
    created,
    create,
    factory,
    releaseTail,
    renderer,
    frames: ports.frames,
    async close() {
      releaseTail();
      await clearNbtSharedDocuments();
      await Promise.allSettled(disposes.map((dispose) => dispose()));
    },
  };
}
afterEach(async () => {
  await clearNbtSharedDocuments();
  vi.restoreAllMocks();
});
it("preserves BigInts, special floats and bounded binary frames without exposing plaintext", async () => {
  const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    wire = await nbtSharedWire("doc", key);
  const source = {
    label: "Private NBT value",
    long: 9223372036854775807n,
    floats: [-0, NaN, Infinity, -Infinity],
    bytes: new Uint8Array([1, 2, 3]),
  };
  try {
    const sealed = await wire.seal(source);
    expect(new TextDecoder().decode(sealed.bytes)).not.toContain(source.label);
    const result = (await wire.open(sealed)) as typeof source;
    expect(result).toEqual(source);
    expect(Object.is(result.floats[0], -0)).toBe(true);
    const other = await nbtSharedWire("other", key);
    await expect(other.open(sealed)).rejects.toThrow("authentication");
    other.close();
  } finally {
    wire.close();
  }
});
it("shares one real document worker, edits, undo and independent searches between renderer views", async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.renderer().open(),
      f.renderer().open(),
    ]);
    await until(
      () =>
        a.getSnapshot()?.state === "complete" &&
        b.getSnapshot()?.shared?.views === 2,
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    await a.edit([
      { type: "value", id: "node:1", value: "9223372036854775807" },
    ]);
    await until(() => b.getEditSnapshot()?.revision === 1);
    expect((await b.describe("node:1")).value).toBe(9223372036854775807n);
    await b.undo();
    await until(() => a.getEditSnapshot()?.revision === 2);
    expect((await a.describe("node:1")).value).toBe(9007199254740993n);
    const query = (text: string) => ({
      text,
      caseSensitive: false,
      exactNumber: false,
      fields: ["name" as const, "value" as const],
    });
    await Promise.all([
      a.startSearch("a-search", query("privateName")),
      b.startSearch("b-search", query("Hidden data")),
    ]);
    await until(
      () =>
        a.getSearchSnapshot()?.state === "complete" &&
        b.getSearchSnapshot()?.state === "complete",
    );
    expect((await a.searchResults("a-search", 0))[0]?.nodeId).toBe("node:1");
    expect((await b.searchResults("b-search", 0))[0]?.nodeId).toBe("node:2");
    await a.close();
    expect((await b.describe("node:1")).value).toBe(9007199254740993n);
    expect(
      f.frames.every((frame) => !JSON.stringify(frame).includes("privateName")),
    ).toBe(true);
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it.each(["claim", "attachRecovery"] as const)(
  "recovers the committed baseline after replacement %s fails",
  async (method) => {
    const f = await fixture();
    try {
      const a = await f.renderer().open(),
        b = await f.renderer().open();
      await until(() => a.getSnapshot()?.state === "complete");
      await a.edit([{ type: "value", id: "node:1", value: "42" }]);
      const generation = a.getSnapshot()!.shared!.generation;
      vi.spyOn(f.factory, method).mockRejectedValueOnce(
        new Error("Injected replacement failure"),
      );
      await expect(nbtSharedDocument(a)!.replace()).rejects.toThrow(
        "Injected replacement failure",
      );
      await until(
        () =>
          (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
          a.getSnapshot()?.state === "complete" &&
          !a.getSnapshot()?.shared?.changing,
      );
      await until(
        () =>
          b.getSnapshot()?.state === "complete" &&
          !b.getSnapshot()?.shared?.changing,
      );
      expect((await a.describe("node:1")).value).toBe(9007199254740993n);
      await b.edit([{ type: "value", id: "node:1", value: "7" }]);
      await until(() => a.getEditSnapshot()?.dirty === true);
      expect((await a.describe("node:1")).value).toBe(7n);
      await a.close();
      await b.close();
    } finally {
      await f.close();
    }
  },
  15000,
);
it.each([false, true])(
  "reopens actual recovery state after an uncertain clear (committed: %s)",
  async (committed) => {
    const f = await fixture();
    try {
      const a = await f.renderer().open();
      await until(() => a.getSnapshot()?.state === "complete");
      await a.edit([{ type: "value", id: "node:1", value: "42" }]);
      const generation = a.getSnapshot()!.shared!.generation,
        current = f.created[0]!,
        clear = current.clearRecovery.bind(current);
      vi.spyOn(current, "clearRecovery").mockImplementationOnce(async () => {
        if (committed) await clear();
        throw new Error("Clear reply unavailable");
      });
      await expect(nbtSharedDocument(a)!.replace()).rejects.toThrow(
        "Clear reply unavailable",
      );
      await until(
        () =>
          (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
          a.getSnapshot()?.state === "complete" &&
          !a.getSnapshot()?.shared?.changing,
      );
      expect((await a.describe("node:1")).value).toBe(
        committed ? 9007199254740993n : 42n,
      );
      expect(a.getEditSnapshot()?.dirty).toBe(!committed);
      await a.close();
    } finally {
      await f.close();
    }
  },
  15000,
);
it("recovers a crashed worker without losing the views' durable edits or undo history", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    const generation = a.getSnapshot()!.shared!.generation;
    f.created[0]!.fail(new Error("Injected worker crash"));
    await until(
      () =>
        (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
        a.getSnapshot()?.state === "complete" &&
        !a.getSnapshot()?.shared?.changing,
    );
    await until(
      () =>
        b.getSnapshot()?.state === "complete" &&
        !b.getSnapshot()?.shared?.changing,
    );
    expect(f.create).toHaveBeenCalledTimes(2);
    expect((await b.describe("node:1")).value).toBe(42n);
    await b.undo();
    expect((await a.describe("node:1")).value).toBe(9007199254740993n);
    await a.close();
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("offers an explicit retry after actual recovery storage failure", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    vi.spyOn(f.factory, "claim").mockRejectedValueOnce(
      new Error("Actual storage write failed"),
    );
    f.created[0]!.fail(new Error("Injected worker crash"));
    await until(
      () =>
        a.getSnapshot()?.shared?.unavailable === true &&
        !a.getSnapshot()?.shared?.changing,
    );
    expect(a.getSnapshot()?.error?.message).toBe("Actual storage write failed");
    expect(a.getEditSnapshot()?.dirty).toBe(true);
    await nbtSharedDocument(b)!.recover();
    await until(
      () =>
        a.getSnapshot()?.state === "complete" &&
        !a.getSnapshot()?.shared?.changing,
    );
    expect((await a.describe("node:1")).value).toBe(42n);
    await a.close();
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("reports a new owner's failed claim at the last known generation so surviving views can retry", async () => {
  const f = await fixture(),
    first = f.renderer();
  try {
    const a = await first.open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    const generation = b.getSnapshot()!.shared!.generation;
    vi.spyOn(f.factory, "claim").mockRejectedValueOnce(
      new Error("New owner claim failed"),
    );
    first.invalidate();
    await until(
      () =>
        b.getSnapshot()?.shared?.unavailable === true &&
        !b.getSnapshot()?.shared?.changing,
    );
    expect(b.getSnapshot()?.shared?.generation).toBe(generation);
    await nbtSharedDocument(b)!.recover();
    await until(
      () =>
        b.getSnapshot()?.state === "complete" &&
        !b.getSnapshot()?.shared?.changing,
    );
    expect(b.getSnapshot()!.shared!.generation).toBeGreaterThan(generation);
    expect((await b.describe("node:1")).value).toBe(42n);
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("does not loop after repeated crashes before indexing completes and can recover explicitly", async () => {
  const f = await fixture({ holdTail: true });
  try {
    const a = await f.renderer().open();
    await until(
      () => f.created.length === 1 && a.getSnapshot()?.state === "indexing",
    );
    f.created[0]!.fail(new Error("First worker crash"));
    await until(
      () =>
        f.created.length === 2 &&
        a.getSnapshot()?.state === "indexing" &&
        !a.getSnapshot()?.shared?.changing,
    );
    f.created[1]!.fail(new Error("Second worker crash"));
    await until(() => a.getSnapshot()?.shared?.unavailable === true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.create).toHaveBeenCalledTimes(2);
    f.releaseTail();
    await nbtSharedDocument(a)!.recover();
    await until(
      () =>
        a.getSnapshot()?.state === "complete" &&
        !a.getSnapshot()?.shared?.changing,
    );
    expect(f.create).toHaveBeenCalledTimes(3);
    expect((await a.describe("node:1")).value).toBe(9007199254740993n);
    await a.close();
  } finally {
    await f.close();
  }
}, 15000);
it.each([false, true])(
  "does not replay an ambiguous in-flight edit after a worker crash (journal committed: %s)",
  async (committed) => {
    const f = await fixture();
    let release = () => {},
      reached = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
    const append = NbtRecoveryJournal.prototype.append;
    const spy = vi
      .spyOn(NbtRecoveryJournal.prototype, "append")
      .mockImplementationOnce(async function (
        this: NbtRecoveryJournal,
        ...args
      ) {
        if (committed) await append.apply(this, args);
        reached();
        await held;
        if (!committed) return append.apply(this, args);
      });
    try {
      const a = await f.renderer().open();
      await until(() => a.getSnapshot()?.state === "complete");
      const generation = a.getSnapshot()!.shared!.generation;
      const outcome = a
        .edit([{ type: "value", id: "node:1", value: "42" }])
        .then(
          () => "accepted",
          (error) => error.message,
        );
      await entered;
      f.created[0]!.fail(new Error("Worker exited before acknowledgement"));
      await until(
        () =>
          (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
          a.getSnapshot()?.state === "complete" &&
          !a.getSnapshot()?.shared?.changing,
      );
      release();
      expect(await outcome).not.toBe("accepted");
      expect((await a.describe("node:1")).value).toBe(
        committed ? 42n : 9007199254740993n,
      );
      expect(a.getEditSnapshot()?.canUndo).toBe(committed);
      if (committed) {
        await a.undo();
        expect(a.getEditSnapshot()?.canUndo).toBe(false);
        expect((await a.describe("node:1")).value).toBe(9007199254740993n);
      }
      await a.close();
    } finally {
      release();
      spy.mockRestore();
      await f.close();
    }
  },
  15000,
);
it("retains a frozen save for receipt reconciliation after a worker crash", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    await a.beginSave("crashed-save", undefined, {
      path: "file.nbt",
      copy: false,
    });
    const generation = a.getSnapshot()!.shared!.generation;
    f.created[0]!.fail(new Error("Worker crashed during save"));
    await until(
      () =>
        (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
        a.getSnapshot()?.state === "complete" &&
        !a.getSnapshot()?.shared?.changing,
    );
    await until(
      () =>
        b.getEditSnapshot()?.pendingSaveId === "crashed-save" &&
        !b.getEditSnapshot()?.saving,
    );
    expect(b.getEditSnapshot()?.uncertain).toBe(true);
    await b.beginSave("crashed-save");
    await b.failSave("crashed-save", false);
    expect((await a.describe("node:1")).value).toBe(42n);
    await a.close();
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("opens a typed editor from the current tag rather than the selection's old page", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    const selected = await a.describe("node:1");
    await b.edit([
      {
        type: "replace",
        id: "node:1",
        value: { type: NbtTag.String, value: "current string" },
      },
    ]);
    await until(() => a.getEditSnapshot()?.revision === 1);
    const target = await readNbtEditTarget(
      a,
      selected.node.id,
      new AbortController().signal,
    );
    expect(selected.node.type).toBe(NbtTag.Long);
    expect(target.row.node.type).toBe(NbtTag.String);
    expect(target.row.value).toBe("current string");
    expect(target.revision).toBe(1);
    await a.close();
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it.each(["edit", "replace"] as const)(
  "fences an editor descriptor when a concurrent %s crosses the read",
  async (change) => {
    const f = await fixture();
    try {
      const a = await f.renderer().open(),
        b = await f.renderer().open();
      await until(() => a.getSnapshot()?.state === "complete");
      const describe = a.describe.bind(a),
        generation = a.getSnapshot()!.shared!.generation;
      vi.spyOn(a, "describe").mockImplementationOnce(async (...args) => {
        const row = await describe(...args);
        if (change === "edit") {
          await b.edit([{ type: "value", id: "node:1", value: "42" }]);
          await until(() => a.getEditSnapshot()?.revision === 1);
        } else {
          await nbtSharedDocument(b)!.replace();
          await until(
            () =>
              (a.getSnapshot()?.shared?.generation ?? 0) > generation &&
              !a.getSnapshot()?.shared?.changing,
          );
        }
        return row;
      });
      await expect(
        readNbtEditTarget(a, "node:1", new AbortController().signal),
      ).rejects.toThrow("changed while opening");
      await a.close();
      await b.close();
    } finally {
      await f.close();
    }
  },
  15000,
);
it("recovers the same dirty session automatically after its owning renderer locks or dies", async () => {
  const f = await fixture(),
    first = f.renderer();
  try {
    const a = await first.open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "rename", id: "node:2", name: "retained" }]);
    await until(() => b.getEditSnapshot()?.dirty === true);
    const generation = b.getSnapshot()!.shared!.generation;
    first.invalidate();
    await until(
      () =>
        (b.getSnapshot()?.shared?.generation ?? 0) > generation &&
        b.getSnapshot()?.state === "complete",
    );
    expect((await b.describe("node:2")).name).toBe("retained");
    expect(b.getEditSnapshot()?.canUndo).toBe(true);
    await b.undo();
    expect((await b.describe("node:2")).name).toBe("text");
    expect(f.create).toHaveBeenCalledTimes(2);
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("closes a shared view without discarding another view's draft, then discards on confirmed last close", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    await nbtSharedDocument(a)!.closeView();
    await a.close();
    expect((await b.describe("node:1")).value).toBe(42n);
    await nbtSharedDocument(b)!.closeView();
    await b.close();
    const c = await f.renderer().open();
    await until(() => c.getSnapshot()?.state === "complete");
    expect((await c.describe("node:1")).value).toBe(9007199254740993n);
    expect(c.getEditSnapshot()?.dirty).toBe(false);
    await c.close();
  } finally {
    await f.close();
  }
}, 15000);
it("replaces every view including inactive views and fences its previous generation", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "rename", id: "node:2", name: "unsaved" }]);
    await b.setPaused(true);
    const generation = b.getSnapshot()!.shared!.generation;
    const lifecycle = new NbtViewSession(b),
      revision = lifecycle.revision;
    await nbtSharedDocument(a)!.replace();
    await until(
      () =>
        (b.getSnapshot()?.shared?.generation ?? 0) > generation &&
        b.getSnapshot()?.shared?.changing === false,
    );
    expect(b.getEditSnapshot()?.dirty).toBe(false);
    expect(lifecycle.revision).toBeGreaterThan(revision);
    expect((await b.describe("node:2")).name).toBe("text");
    await b.setPaused(false);
    await b.edit([{ type: "rename", id: "node:2", name: "afterReload" }]);
    await until(() => a.getEditSnapshot()?.dirty === true);
    await a.close();
    await b.close();
    const c = await f.renderer().open();
    await until(() => c.getSnapshot()?.state === "complete");
    expect((await c.describe("node:2")).name).toBe("afterReload");
    await c.close();
  } finally {
    await f.close();
  }
}, 15000);
it("releases a detached durable facade while retaining the worker and draft used by another view", async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const lease = acquireNbtSession(f.id, () => f.renderer().open(), true);
    release = lease.release;
    const a = (await lease.promise).client,
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    const close = vi.spyOn(a, "close");
    release();
    await until(
      () =>
        close.mock.calls.length === 1 && b.getSnapshot()?.shared?.views === 1,
    );
    await close.mock.results[0]!.value;
    await expect(a.describe("node:1")).rejects.toThrow("closed");
    expect((await b.describe("node:1")).value).toBe(42n);
    expect(f.create).toHaveBeenCalledTimes(1);
    await b.close();
  } finally {
    release();
    await f.close();
  }
}, 15000);
it("waits for actual journal acknowledgement during a paused view's handoff checkpoint", async () => {
  const f = await fixture();
  let release = () => {},
    reached = () => {};
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
  const append = NbtRecoveryJournal.prototype.append;
  const spy = vi
    .spyOn(NbtRecoveryJournal.prototype, "append")
    .mockImplementation(async function (this: NbtRecoveryJournal, ...args) {
      reached();
      await held;
      return append.apply(this, args);
    });
  try {
    const a = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    const edit = a.edit([{ type: "value", id: "node:1", value: "42" }]);
    await entered;
    await a.setPaused(true);
    let acknowledged = false;
    const checkpoint = nbtSharedDocument(a)!
      .checkpoint()
      .then(() => {
        acknowledged = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acknowledged).toBe(false);
    release();
    await edit;
    await checkpoint;
    expect((await a.describe("node:1")).value).toBe(42n);
    await a.close();
  } finally {
    release();
    spy.mockRestore();
    await f.close();
  }
}, 15000);
it("suspends an orphaned frozen save and lets a surviving view reconcile the same ID", async () => {
  const f = await fixture();
  try {
    const a = await f.renderer().open(),
      b = await f.renderer().open();
    await until(() => a.getSnapshot()?.state === "complete");
    await a.edit([{ type: "value", id: "node:1", value: "42" }]);
    await a.beginSave("frozen-save", undefined, {
      path: "file.nbt",
      copy: false,
    });
    await a.close();
    await until(
      () =>
        b.getEditSnapshot()?.saving === false &&
        b.getEditSnapshot()?.uncertain === true,
    );
    expect(b.getEditSnapshot()?.pendingSaveId).toBe("frozen-save");
    await b.beginSave("frozen-save");
    await b.failSave("frozen-save", false);
    expect((await b.describe("node:1")).value).toBe(42n);
    expect(b.getEditSnapshot()?.dirty).toBe(true);
    await b.close();
  } finally {
    await f.close();
  }
}, 15000);
it("resolves transferred IDs against the original parser baseline after a structural save and owner recovery", async () => {
  const f = await fixture();
  try {
    const client = await f.renderer().open();
    await until(() => client.getSnapshot()?.state === "complete");
    await client.edit([
      {
        type: "insert",
        parent: "node:0",
        index: 0,
        name: "new-first",
        value: { type: NbtTag.Int, value: "7" },
      },
    ]);
    await client.beginSave("structural-save");
    await client.acknowledgeSave("structural-save", "v2");
    expect(client.getEditSnapshot()?.version).toBe("v2");
    expect(client.getSnapshot()?.baselineVersion).toBe("v1");
    const state: NbtViewState = {
      viewer: "nbt",
      version: 1,
      baselineVersion: "v1",
      format: { ...JAVA_NBT },
      profile: "java",
      compression: "none",
      expanded: ["node:0"],
      selected: "node:1",
      target: null,
      mode: "tree",
      editing: true,
      findOpen: false,
      tree: { position: 2, rank: 2 },
    };
    const generation = client.getSnapshot()?.shared?.generation;
    f.created[0]!.fail(new Error("Worker terminated"));
    await until(
      () =>
        client.getSnapshot()?.state === "complete" &&
        client.getSnapshot()?.shared?.generation !== generation,
    );
    const restored = await resolveNbtView(
      client,
      state,
      new AbortController().signal,
    );
    expect(restored?.selected?.name).toBe("privateName");
    expect(restored?.selected?.value).toBe(9007199254740993n);
    expect(client.getSnapshot()?.baselineVersion).toBe("v1");
    await client.edit([{ type: "delete", id: "node:1" }]);
    expect(
      (await resolveNbtView(client, state, new AbortController().signal))
        ?.selected,
    ).toBeNull();
    await client.close();
  } finally {
    await f.close();
  }
}, 15000);
it("waits for an unloaded transferred selection to be indexed and cancels that wait when the view closes", async () => {
  const f = await fixture({ holdTail: true });
  try {
    const client = await f.renderer().open();
    await until(() => Boolean(client.getSnapshot()?.root));
    const state: NbtViewState = {
      viewer: "nbt",
      version: 1,
      baselineVersion: "v1",
      format: { ...JAVA_NBT },
      profile: "java",
      compression: "none",
      expanded: ["node:0"],
      selected: "node:4",
      target: null,
      mode: "tree",
      editing: false,
      findOpen: false,
      tree: { position: 4, rank: 4 },
    };
    const controller = new AbortController();
    const cancelled = resolveNbtView(client, state, controller.signal);
    controller.abort(new Error("Transferred view cancelled"));
    await expect(cancelled).rejects.toThrow(/cancelled/);
    let resolved = false;
    const pending = resolveNbtView(
      client,
      state,
      new AbortController().signal,
    ).then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    f.releaseTail();
    const result = await pending;
    expect(result?.selected?.name).toBe("after-array");
    expect(result?.selected?.value).toBe(42);
    await client.close();
  } finally {
    await f.close();
  }
}, 15000);
