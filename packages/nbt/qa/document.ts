import { openNbtDocument } from "../../../cantrip_app/src/lib/nbt/document";
import { JAVA_NBT, NbtTag } from "../src/index";
import type { NbtDocumentClient, NbtDisplayRow } from "../src/document/index";
const results: unknown[] = [];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 240000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Document QA timed out");
    await sleep(10);
  }
}
async function compressed(input: AsyncIterable<Uint8Array>) {
  const iterator = input[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(result.value as Uint8Array<ArrayBuffer>);
    },
  });
  return new Response(stream.pipeThrough(new CompressionStream("gzip"))).blob();
}
async function close(client: NbtDocumentClient) {
  await client.close();
}
async function children(client: NbtDocumentClient, parent: string) {
  let rows: NbtDisplayRow[] = [];
  await waitFor(() => Boolean(client.getSnapshot()?.root));
  for (let i = 0; i < 1000; i++) {
    rows = await client.rows(parent);
    if (rows.length) return rows;
    await sleep(5);
  }
  throw new Error("Children never became available");
}
async function run() {
  const framePhases: Record<string, { frames: number; maximumGap: number }> =
    {};
  let phase: string | undefined,
    last = performance.now(),
    animating = true;
  const startPhase = (name: string) => {
    phase = name;
    last = performance.now();
    framePhases[name] = { frames: 0, maximumGap: 0 };
  };
  function frame(now: number) {
    if (phase) {
      const metric = framePhases[phase]!;
      metric.maximumGap = Math.max(metric.maximumGap, now - last);
      metric.frames++;
    }
    last = now;
    if (animating) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  try {
    const size = 100 * 1024 ** 2;
    const blob = await compressed(
      (async function* () {
        const header = new Uint8Array([
          10, 0, 0, 7, 0, 5, 97, 114, 114, 97, 121, 6, 64, 0, 0,
        ]);
        yield header;
        for (let i = 0; i < size; i += 65536)
          yield new Uint8Array(Math.min(65536, size - i)).fill(42);
        yield Uint8Array.of(0);
      })(),
    );
    let reads = 0,
      maxRead = 0;
    const source = {
      size: blob.size,
      async read(offset: number, length: number, signal?: AbortSignal) {
        signal?.throwIfAborted();
        reads++;
        maxRead = Math.max(maxRead, length);
        return new Uint8Array(
          await blob.slice(offset, offset + length).arrayBuffer(),
        );
      },
    };
    startPhase("100MiB-array");
    const client = await openNbtDocument(source, {
      binding: "QA/account/array/revision",
      format: { ...JAVA_NBT, compression: "gzip" },
      cacheBytes: 128 * 1024,
      indexPages: 16,
    });
    try {
      await waitFor(() => Boolean(client.getSnapshot()?.root));
      const root = client.getSnapshot()!.root!,
        rows = await children(client, root),
        array = rows[0]!;
      const early = client.getSnapshot()!.availableBytes;
      check(early < size, "First rows waited for full decompression");
      check(array.node.type === NbtTag.ByteArray, "Array type changed");
      await client.setPaused(true);
      await sleep(40);
      const pausedReads = reads,
        pausedBytes = client.getSnapshot()!.availableBytes;
      await sleep(120);
      check(
        reads === pausedReads &&
          client.getSnapshot()!.availableBytes === pausedBytes,
        "Hidden document kept reading/indexing",
      );
      const controller = new AbortController(),
        pending = client.array(array.node.id, size - 4, 4, controller.signal);
      controller.abort(new Error("stale view"));
      try {
        await pending;
        throw new Error("Stale query was accepted");
      } catch (error) {
        check(String(error).includes("stale view"), "Wrong query cancellation");
      }
      await client.setPaused(false);
      await waitFor(
        () =>
          client.getSnapshot()?.state === "complete" ||
          client.getSnapshot()?.state === "error",
      );
      check(
        client.getSnapshot()?.state === "complete",
        JSON.stringify(client.getSnapshot()),
      );
      const completeReads = reads,
        started = performance.now();
      check(
        (await client.array(array.node.id, size - 4, 4)).every((n) => n === 42),
        "Wrong array tail",
      );
      const latency = performance.now() - started;
      await client.rows(root, 0, 128);
      await sleep(50);
      check(reads === completeReads, "Browsing restarted source parsing");
      let output = 0,
        largestOutput = 0;
      for await (const chunk of client.serialize()) {
        output += chunk.length;
        largestOutput = Math.max(largestOutput, chunk.length);
      }
      check(
        output === blob.size && largestOutput <= 65536,
        "Original export was not streamed",
      );
      const status = client.getSnapshot()!;
      check(
        status.peakIndexPages <= 16 && status.cacheBytes <= 128 * 1024,
        "Working caches exceeded budgets",
      );
      check(maxRead <= 65536, "Source read was not bounded");
      results.push({
        kind: "100MiB-expanded-array",
        compressedBytes: blob.size,
        expandedBytes: status.availableBytes,
        nodes: status.nodes,
        earlyBytes: early,
        cacheBytes: status.cacheBytes,
        peakIndexPages: status.peakIndexPages,
        maxRead,
        tailPageMilliseconds: latency,
        originalExportBytes: output,
      });
    } finally {
      await close(client);
      phase = undefined;
    }
    const tags = 1050000;
    const properties = await compressed(
      (async function* () {
        yield Uint8Array.of(10, 0, 0);
        let chunk = new Uint8Array(65536),
          used = 0;
        for (let i = 0; i < tags; i++) {
          if (used + 8 > chunk.length) {
            yield chunk.subarray(0, used);
            chunk = new Uint8Array(65536);
            used = 0;
          }
          chunk.set([3, 0, 1, 120], used);
          new DataView(chunk.buffer).setInt32(used + 4, i, false);
          used += 8;
        }
        if (used) yield chunk.subarray(0, used);
        yield Uint8Array.from([
          4, 0, 4, 116, 97, 105, 108, 127, 255, 255, 255, 255, 255, 255, 255, 0,
        ]);
      })(),
    );
    startPhase("million-properties");
    const many = await openNbtDocument(properties, {
      binding: "QA/account/million/revision",
      format: { ...JAVA_NBT, compression: "gzip" },
      cacheBytes: 128 * 1024,
      indexPages: 16,
    });
    const indexingStarted = performance.now();
    try {
      await waitFor(() => Boolean(many.getSnapshot()?.root));
      const root = many.getSnapshot()!.root!;
      let first: NbtDisplayRow[] = [];
      for (let i = 0; i < 1000; i++) {
        first = await many.rows(root, 0, 2);
        if (first.length === 2) break;
        await sleep(5);
      }
      check(
        first[0]?.value === 0 && first[1]?.value === 1,
        "Early property page failed",
      );
      await waitFor(
        () =>
          many.getSnapshot()?.state === "complete" ||
          many.getSnapshot()?.state === "error",
      );
      const status = many.getSnapshot()!;
      check(status.state === "complete", JSON.stringify(status));
      const started = performance.now(),
        tail = await many.rows(root, tags - 3, 128),
        pageMilliseconds = performance.now() - started;
      check(
        tail.length === 4 && tail[3]?.value === 9223372036854775807n,
        "Lost precise Long at end of million-node document",
      );
      check(tail[0]?.node.ordinal === tags - 3, "Wrong paged child ordinal");
      check(status.nodes === tags + 2, "Wrong node count");
      check(
        status.peakIndexPages <= 16 && status.cacheBytes <= 128 * 1024,
        "Index grew in memory with node count",
      );
      const middleStarted = performance.now(),
        middle = await many.rows(root, Math.floor(tags / 2), 128),
        middlePageMilliseconds = performance.now() - middleStarted;
      check(
        middle.length === 128 && middle[0]?.value === Math.floor(tags / 2),
        "Full middle page failed",
      );
      await sleep(100);
      check(
        many.getSnapshot() === status,
        "Idle document emitted background updates",
      );
      results.push({
        kind: "million-properties",
        compressedBytes: properties.size,
        expandedBytes: status.availableBytes,
        nodes: status.nodes,
        indexingMilliseconds: performance.now() - indexingStarted,
        lastPageMilliseconds: pageMilliseconds,
        middlePageMilliseconds,
        cacheBytes: status.cacheBytes,
        peakIndexPages: status.peakIndexPages,
      });
    } finally {
      await close(many);
      phase = undefined;
    }
    const smallBytes = Uint8Array.from([
      10, 0, 0, 4, 0, 1, 108, 127, 255, 255, 255, 255, 255, 255, 255, 9, 0, 1,
      120, 10, 0, 0, 0, 1, 3, 0, 1, 110, 0, 0, 0, 42, 0, 0,
    ]);
    const small = await compressed(
      (async function* () {
        yield smallBytes;
      })(),
    );
    const baseline = await openNbtDocument(small, {
      binding: "QA/serialize/baseline",
      format: { ...JAVA_NBT, compression: "gzip" },
      indexPages: 16,
      cacheBytes: 128 * 1024,
    });
    const serialized: Uint8Array<ArrayBuffer>[] = [];
    try {
      for await (const chunk of baseline.serialize(false)) {
        check(chunk.length <= 65536, "Recompression exceeded stream page size");
        serialized.push(chunk as Uint8Array<ArrayBuffer>);
      }
    } finally {
      await baseline.close();
    }
    const reopened = await openNbtDocument(new Blob(serialized), {
      binding: "QA/serialize/reopened",
      format: { ...JAVA_NBT, compression: "gzip" },
      indexPages: 16,
      cacheBytes: 128 * 1024,
    });
    try {
      await waitFor(
        () =>
          reopened.getSnapshot()?.state === "complete" ||
          reopened.getSnapshot()?.state === "error",
      );
      check(
        reopened.getSnapshot()?.state === "complete",
        JSON.stringify(reopened.getSnapshot()),
      );
      const [root] = await reopened.rows(null),
        rows = await reopened.rows(root!.node.id);
      check(
        rows[0]?.value === 9223372036854775807n,
        "Recompression lost Long precision",
      );
      const [item] = await reopened.rows(rows[1]!.node.id);
      const [value] = await reopened.rows(item!.node.id);
      check(
        value?.value === 42 && value.node.id !== item!.node.id,
        "Nested compound identities collided after reopen",
      );
      results.push({
        kind: "worker-recompress-reopen",
        nodes: reopened.getSnapshot()!.nodes,
        preciseLong: true,
        nestedList: true,
      });
    } finally {
      await reopened.close();
    }
    return { ok: true, results, framePhases };
  } finally {
    animating = false;
  }
}
run().then(
  (result) => {
    (window as any).__nbtDocumentResult = result;
    document.querySelector("#result")!.textContent = JSON.stringify(
      result,
      null,
      2,
    );
  },
  (error) => {
    (window as any).__nbtDocumentResult = {
      ok: false,
      results,
      error: String(error),
      stack: error?.stack,
    };
  },
);
