import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { JAVA_NBT, NbtTag, encodeNbtPayload } from "@cantrip/nbt";
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
async function fixture() {
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
        !choice && descriptor ? null : new Blob([bytes]),
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
    renderer,
    frames: ports.frames,
    async close() {
      await clearNbtSharedDocuments();
      await Promise.allSettled(disposes.map((dispose) => dispose()));
    },
  };
}
afterEach(async () => {
  await clearNbtSharedDocuments();
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
