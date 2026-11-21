// Real native managed capture/pump with the actual Rust HTTP server. Caller
// owns and finally removes the disposable server/profile and proxy faults.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NativeHistoryClient } from "../../tests/reference-node-worker/src/native-history-client.ts";
import { ManagedNativeHistoryProjection } from "../../tests/reference-node-worker/src/managed-native-history-projection.ts";
import { createNativeHistoryProjectorAdapters } from "../../tests/reference-node-worker/src/native-history-projector-adapters.ts";
import { AttachmentStore } from "../../tests/reference-node-worker/src/attachment-store.ts";
import { readNativeHistoryRecovery } from "../../tests/reference-node-worker/src/native-history-recovery.ts";
async function until(test, label) {
  for (let i = 0; i < 400; i++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out: " + label);
}
export async function verifyManagedHistory({
  spawn,
  root,
  serverUrl,
  token,
  workerId,
  ownerId,
  serverId,
  chatId,
  binding,
  snapshot,
  deliveries,
  fault,
}) {
  const directory = path.join(root, "managed-history");
  const sourceScope = { ownerId, serverId, workerId };
  const service = {
    ownerId: () => ownerId,
    serverIdentity: () => serverId,
    componentKey: (_scope, keyRevision = 1) => ({
      key: new Uint8Array(32).fill(keyRevision),
      keyRevision,
    }),
  };
  const client = new NativeHistoryClient({
    serverUrl,
    workerId,
    token: () => token,
  });
  const managed = structuredClone(snapshot);
  const turnId = "managed-http-turn",
    itemId = "managed-http-item";
  managed.thread.turns[0].id = turnId;
  managed.thread.turns[0].items[0].id = itemId;
  managed.thread.turns[0].items[0].text = "synthetic-managed-private-body";
  managed.history.turns[0].turnId = turnId;
  managed.history.turns[0].items[0].itemId = itemId;
  managed.history.turns[0].cantripModelAttribution.turnId = turnId;
  managed.history.turns[0].usage = null;
  let native, reference;
  async function call(input) {
    const result = await native.call(input);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  async function start(retry = 10) {
    native = spawn();
    await call({
      op: "init",
      generation: "managed-runtime",
      config: {
        serverUrl,
        token,
        snapshot: managed,
        snapshotDelayMs: 0,
        retryDelayMs: 5,
        maxRetryDelayMs: 10,
        projectionRetryMs: retry,
        projectionMaxRetryMs: retry,
      },
    });
    await call({
      op: "manager.start",
      directory,
      sourceScope,
      keyByte: 1,
      project: true,
      recover: true,
    });
  }
  async function stop() {
    if (native) {
      await call({ op: "manager.stop" });
      await native.stop();
      native = undefined;
    }
  }
  try {
    const first = deliveries.length;
    const initialArchives = fault.archives();
    fault.dropNext();
    await start(5000);
    await call({ op: "manager.bind", chatId, threadId: "thread" });
    await until(
      async () =>
        deliveries.length > first &&
        (await call({ op: "manager.state" })).errors.some(
          (v) => v.phase === "project",
        ),
      "managed ingest acknowledgment loss",
    );
    assert.equal(deliveries[first].status, 200);
    assert.equal(
      fault.archives() - initialArchives,
      3,
      "outbox recovery and initial projection share one items/turns/batches snapshot",
    );
    assert.deepEqual(
      await call({ op: "manager.stop" }),
      [],
      "source frames persisted despite unconfirmed canonical acknowledgment",
    );
    await native.stop();
    native = undefined;

    // Restart without any native bind/read. A damaged sibling must not block
    // healthy frozen-stage recovery or cause repeated healthy projection.
    const damaged = path.join(directory, "sources", "e".repeat(64));
    await mkdir(damaged);
    await writeFile(path.join(damaged, "source.json"), "{broken");
    await start();
    await until(
      async () =>
        deliveries.length >= first + 2 &&
        (await call({ op: "manager.state" })).errors.some(
          (v) => v.phase === "recover",
        ),
      "startup source scan and retained-stage replay",
    );
    await rm(damaged, { recursive: true });
    await call({ op: "manager.flush.start" });
    await call({ op: "manager.await" });
    assert.equal(
      deliveries.length,
      first + 2,
      "startup retries skip already-known healthy source",
    );
    assert.equal(
      deliveries[first + 1].body,
      deliveries[first].body,
      "restart retries exact frozen ingest bytes",
    );
    assert.equal(
      (await call({ op: "manager.state" })).trace.filter(
        (v) => v.kind === "read",
      ).length,
      0,
      "recovery owns no native observation",
    );
    const [checkpoint] = await call({ op: "manager.checkpoints" });
    assert.equal(checkpoint.cursor.sequence, 1);
    const recovered = await readNativeHistoryRecovery({
      binding,
      client,
      service,
    });
    const item = recovered.items.find((v) => v.identity.itemId === itemId);
    assert.equal(item.revision, 1);
    assert.equal(item.source.body.text, managed.thread.turns[0].items[0].text);
    const batchCount = recovered.batches.length;
    await stop();

    // Real HTTP typed 404s park in this process; encrypted files stay intact.
    for (const code of ["chat-not-found", "binding-not-found"]) {
      fault.missing(code);
      const before = fault.opens();
      await start();
      await call({ op: "manager.flush.start" });
      const result = await native.call({ op: "manager.await" });
      assert.equal(result.ok, false);
      assert.match(result.error, /HTTP 404/);
      await call({ op: "tick", ms: 50 });
      assert.equal(
        fault.opens(),
        before + 1,
        "confirmed missing binding is parked without retry",
      );
      assert.equal(
        (await call({ op: "manager.records" })).length,
        1,
        "parked encrypted source retained",
      );
      await stop();
    }
    fault.missing(undefined);

    // Node reopens the stopped native profile sequentially. This exercises the
    // actual reference pump, not a mock projector or concurrent profile owner.
    reference = new ManagedNativeHistoryProjection({
      directory: path.join(directory, "canonical"),
      sourceDirectory: path.join(directory, "sources"),
      workerId,
      service,
      client,
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
      projector: async (binding, signal, source) =>
        createNativeHistoryProjectorAdapters({
          directory: path.join(directory, "canonical", "materialized"),
          binding,
          signal,
          source,
          service,
          attachments: new AttachmentStore(path.join(directory, "files")),
        }),
    });
    await reference.close();
    reference = undefined;
    assert.equal(
      (await readNativeHistoryRecovery({ binding, client, service })).batches
        .length,
      batchCount,
      "Node reopen produces no duplicate canonical batches",
    );
    assert.equal(deliveries.length, first + 2);
    return {
      nativeManagedCaptureAndProjection: true,
      sharedInitializationArchiveRead: true,
      managedLostAckRestartFrozenRetry: true,
      damagedSiblingRecoveryAndKnownSourceSkip: true,
      missingDestinationsParked: true,
      sequentialNodeProfileReopen: true,
      managedItemRevision: 1,
      canonicalBatchCount: batchCount,
    };
  } finally {
    fault.missing(undefined);
    await reference?.stop();
    await stop();
  }
}
