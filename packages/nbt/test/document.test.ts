import { expect, it } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  JAVA_NBT,
  NbtTag,
  memoryNbtSource,
  encodeNbtPayload,
  type NbtByteSource,
} from "../src/index.js";
import { NbtDocumentEngine } from "../src/document/engine.js";
import { NbtDocumentClient } from "../src/document/client.js";
import { installNbtDocumentWorker } from "../src/document/host.js";
import type {
  NbtMessageEndpoint,
  NbtDocumentRequest,
  NbtDocumentResponse,
} from "../src/document/types.js";
const options = {
  binding: "account/document/revision",
  format: JAVA_NBT,
  indexPages: 16,
  cacheBytes: 128 * 1024,
};
async function collect(input: AsyncIterable<Uint8Array>) {
  const chunks = [];
  for await (const bytes of input) chunks.push(bytes);
  return Buffer.concat(chunks);
}
async function fixture() {
  return collect(
    encodeNbtPayload(
      {
        name: "root",
        tag: {
          type: NbtTag.Compound,
          value: [
            {
              name: "long",
              tag: { type: NbtTag.Long, value: 9223372036854775807n },
            },
            {
              name: "text",
              tag: { type: NbtTag.String, value: "word ".repeat(1000) },
            },
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
                      { name: "n", tag: { type: NbtTag.Int, value: 42 } },
                    ],
                  },
                  { type: NbtTag.Compound, value: [] },
                ],
              },
            },
          ],
        },
      },
      JAVA_NBT,
    ),
  );
}
function pair() {
  const main = new Set<(event: MessageEvent<NbtDocumentResponse>) => void>(),
    worker = new Set<(event: MessageEvent<NbtDocumentRequest>) => void>();
  const endpoint = <In, Out>(
    own: Set<(event: MessageEvent<In>) => void>,
    other: Set<(event: MessageEvent<Out>) => void>,
  ): NbtMessageEndpoint<In, Out> => ({
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
  });
  return { main: endpoint(main, worker), worker: endpoint(worker, main) };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Document condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
it("indexes once, sends bounded rows, and serializes original/recompressed bytes losslessly", async () => {
  const bytes = await fixture(),
    baseline = bytes.slice(),
    compressed = gzipSync(bytes);
  let reads = 0;
  const raw = memoryNbtSource(compressed),
    source: NbtByteSource = {
      size: raw.size,
      async read(...args) {
        reads++;
        return raw.read(...args);
      },
    };
  const engine = await NbtDocumentEngine.open(source, {
    ...options,
    format: { ...JAVA_NBT, compression: "gzip" },
  });
  try {
    const result = await engine.completed,
      atComplete = reads;
    expect(result.nodes).toBe(7);
    const [root] = await engine.rows(null, 0, 1),
      rows = await engine.rows(root!.node.id, 0, 128);
    expect(rows.map((row) => row.name)).toEqual(["long", "text", "items"]);
    expect(rows[0]?.value).toBe(9223372036854775807n);
    expect(rows[1]?.valueTruncated).toBe(true);
    expect(String(rows[1]?.value).length).toBeLessThanOrEqual(512);
    const items = await engine.rows(rows[2]!.node.id, 0, 128);
    expect(items).toHaveLength(2);
    expect(await engine.rows(items[0]!.node.id, 0, 128)).toMatchObject([
      { name: "n", value: 42 },
    ]);
    expect(reads).toBe(atComplete);
    expect(await collect(engine.serialize(true))).toEqual(compressed);
    expect(gunzipSync(await collect(engine.serialize(false)))).toEqual(
      baseline,
    );
    expect(engine.snapshot().peakIndexPages).toBeLessThanOrEqual(16);
    expect(engine.snapshot().cacheBytes).toBeLessThanOrEqual(
      options.cacheBytes,
    );
  } finally {
    await engine.close();
  }
});
it("does not mutate a borrowed raw source buffer", async () => {
  const bytes = await fixture(),
    baseline = bytes.slice(),
    engine = await NbtDocumentEngine.open(memoryNbtSource(bytes), options);
  try {
    await engine.completed;
    expect(bytes).toEqual(baseline);
    expect(await collect(engine.serialize(true))).toEqual(baseline);
  } finally {
    await engine.close();
  }
});
it.each([false, true])(
  "never completes corrupt compressed streams (fallback=%s)",
  async (fallbackCompression) => {
    const compressed = gzipSync(await fixture());
    compressed[compressed.length - 8]! ^= 1;
    const engine = await NbtDocumentEngine.open(memoryNbtSource(compressed), {
      ...options,
      format: { ...JAVA_NBT, compression: "gzip" },
      fallbackCompression,
    });
    try {
      await expect(engine.completed).rejects.toThrow();
      expect(engine.snapshot().state).toBe("error");
      await expect(collect(engine.serialize(true))).rejects.toThrow();
    } finally {
      await engine.close();
    }
  },
);
it("handles Blob input through the worker protocol and becomes idle after completion", async () => {
  const channel = pair(),
    dispose = installNbtDocumentWorker(channel.worker),
    bytes = await fixture();
  const client = await NbtDocumentClient.open(
    channel.main,
    new Blob([bytes]),
    options,
  );
  try {
    await waitFor(() => client.getSnapshot()?.state === "complete");
    const status = client.getSnapshot();
    const [root] = await client.rows(null),
      rows = await client.rows(root!.node.id);
    expect(rows[0]?.value).toBe(9223372036854775807n);
    expect(await collect(client.serialize())).toEqual(bytes);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.getSnapshot()).toBe(status);
  } finally {
    await client.close();
    await dispose();
  }
});
it("pauses background work, cancels unavailable array reads, and closes a pending remote read", async () => {
  const channel = pair(),
    dispose = installNbtDocumentWorker(channel.worker),
    size = 1024 * 1024,
    head = new Uint8Array(64 * 1024);
  head.set([7, 0, 0, 0, 16, 0, 0]);
  let reads = 0,
    aborted = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const source = {
    size: size + 7,
    async read(offset: number, length: number, signal?: AbortSignal) {
      reads++;
      if (offset === 0) return head.slice();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          aborted++;
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        void held.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
      signal?.throwIfAborted();
      return new Uint8Array(Math.min(length, size + 7 - offset));
    },
  };
  const client = await NbtDocumentClient.open(channel.main, source, options);
  try {
    await waitFor(() => Boolean(client.getSnapshot()?.root));
    const root = client.getSnapshot()!.root!;
    expect(await client.array(root, 0, 4)).toEqual([0, 0, 0, 0]);
    await client.setPaused(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const atPause = reads;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(atPause);
    expect(client.getSnapshot()?.state).toBe("paused");
    const controller = new AbortController(),
      pending = client.array(root, size - 4, 4, controller.signal);
    controller.abort(new Error("stale query"));
    await expect(pending).rejects.toThrow("stale query");
    const exportAbort = new AbortController(),
      exported = collect(client.serialize(true, exportAbort.signal));
    exportAbort.abort(new Error("export cancelled"));
    await expect(exported).rejects.toThrow("export cancelled");
    await client.setPaused(false);
    await waitFor(() => client.getSnapshot()?.state === "complete");
  } finally {
    await client.close();
    await dispose();
  }
  expect(aborted).toBe(0);
});
it("aborts an in-flight source request when closing a worker document", async () => {
  const channel = pair(),
    dispose = installNbtDocumentWorker(channel.worker);
  let aborts = 0;
  const client = await NbtDocumentClient.open(
    channel.main,
    {
      size: 100,
      read(_offset, _length, signal) {
        return new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              aborts++;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    },
    options,
  );
  await waitFor(() => true);
  await client.close();
  await dispose();
  expect(aborts).toBe(1);
});

it("cancels an export waiting for paused indexing without blocking the next export", async () => {
  const channel = pair(),
    dispose = installNbtDocumentWorker(channel.worker);
  const count = 100000,
    head = new Uint8Array(65536);
  head.set([7, 0, 0, 0, 1, 134, 160]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const client = await NbtDocumentClient.open(
    channel.main,
    {
      size: count + 7,
      async read(offset, length, signal) {
        if (offset === 0) return head.slice();
        await held;
        signal?.throwIfAborted();
        return new Uint8Array(
          Math.max(0, Math.min(length, count + 7 - offset)),
        );
      },
    },
    options,
  );
  try {
    await waitFor(() => Boolean(client.getSnapshot()?.root));
    await client.setPaused(true);
    await client.request({
      type: "serialize.begin",
      exportId: "first",
      original: true,
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const observer = (event: MessageEvent<NbtDocumentRequest>) => {
      if (
        event.data.type === "request" &&
        event.data.command.type === "serialize.next"
      )
        entered();
    };
    channel.worker.addEventListener("message", observer);
    const controller = new AbortController(),
      pending = client.request(
        { type: "serialize.next", exportId: "first" },
        controller.signal,
      );
    await started;
    controller.abort(new Error("cancel waiting export"));
    await expect(pending).rejects.toThrow("cancel waiting export");
    await client.request({ type: "serialize.cancel", exportId: "first" });
    channel.worker.removeEventListener("message", observer);
    release();
    await client.setPaused(false);
    await waitFor(() => client.getSnapshot()?.state === "complete");
    expect((await collect(client.serialize())).length).toBe(count + 7);
  } finally {
    release();
    await client.close();
    await dispose();
  }
});
it("publishes a fatal worker failure before releasing its listeners", async () => {
  const channel = pair(),
    dispose = installNbtDocumentWorker(channel.worker),
    client = await NbtDocumentClient.open(
      channel.main,
      new Blob([await fixture()]),
      options,
    );
  await waitFor(() => client.getSnapshot()?.state === "complete");
  let observed = "";
  client.subscribe(() => {
    observed = client.getSnapshot()?.error?.message ?? "";
  });
  client.fail(new Error("worker crashed"));
  expect(observed).toBe("worker crashed");
  expect(client.getSnapshot()?.state).toBe("error");
  await dispose();
});
it("reads indexed scalar values without awaiting unavailable structural lookahead", async () => {
  const { readNbtScalar } = await import("../src/values.js");
  const source: NbtByteSource = {
    size: undefined,
    async read(offset, length) {
      if (offset + length > 8)
        throw new Error("Lookahead reached unavailable bytes");
      return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 42]).slice(
        offset,
        offset + length,
      );
    },
  };
  const node = {
    id: "node:0",
    parent: null,
    ordinal: 0,
    type: NbtTag.Int,
    name: null,
    start: 0,
    payload: 4,
    end: 8,
    childCount: 0,
  };
  expect(await readNbtScalar(source, node, JAVA_NBT)).toEqual({
    value: 42,
    truncated: false,
  });
});
it("serves bounded tree, table, full-value search and ancestor pages through worker RPC", async () => {
  const bytes = await fixture(),
    endpoints = pair(),
    dispose = installNbtDocumentWorker(endpoints.worker),
    client = await NbtDocumentClient.open(
      endpoints.main,
      memoryNbtSource(bytes),
      options,
    );
  try {
    await waitFor(() => client.getSnapshot()?.state === "complete");
    const root = client.getSnapshot()!.root!,
      children = await client.rows(root),
      items = children.find((row) => row.name === "items")!;
    const tree = await client.tree([root, items.node.id], 0, 128);
    expect(tree.total).toBe(6);
    const table = await client.table({
      id: items.node.id,
      offset: 0,
      limit: 2,
      columnOffset: 0,
      columnLimit: 8,
      referenceOrdinal: 0,
      reverse: false,
    });
    expect(table.rows[0]?.cells[0]?.value).toBe(42);
    await client.startSearch("find", {
      text: "word word",
      fields: ["value"],
      caseSensitive: false,
      exactNumber: false,
    });
    await waitFor(() => client.getSearchSnapshot()?.state === "complete");
    const results = await client.searchResults("find", 0, 128);
    expect(results).toHaveLength(1);
    expect((await client.describe(results[0]!.nodeId)).valueTruncated).toBe(
      true,
    );
    expect((await client.ancestors(results[0]!.nodeId))[0]?.id).toBe(root);
    await expect(client.searchResults("find", 0, 129)).rejects.toThrow();
    await client.cancelSearch("find");
  } finally {
    await client.close();
    await dispose();
  }
});
