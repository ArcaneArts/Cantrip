// Whole native history coordinator over real Rust HTTP and retained child state.
import assert from "node:assert/strict";
import path from "node:path";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { ManagedNativeHistory } from "../../cantrip_worker/src/managed-native-history.ts";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.ts";
import { AttachmentStore } from "../../cantrip_worker/src/attachment-store.ts";
import { readNativeHistoryRecovery } from "../../cantrip_worker/src/native-history-recovery.ts";
import { verifyHistoryRuntimeRecovery } from "./history-runtime-smoke.mjs";
export async function verifyHistoryCoordinator({
  spawn,
  root,
  serverUrl,
  runtimeServerUrl,
  token,
  workerId,
  ownerId,
  serverId,
  chatId,
  binding,
  snapshot,
  workerBinary,
  visit,
}) {
  const directory = path.join(root, "coordinator-history");
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
  const rootTurn = "coordinator-root-turn",
    childThread = "coordinator-child-thread",
    childTurn = "coordinator-child-turn";
  function retained(thread, turn, item, text, parent = null) {
    const value = structuredClone(snapshot);
    value.thread.id = thread;
    value.thread.parentThreadId = parent;
    value.thread.turns[0].id = turn;
    value.thread.turns[0].items[0] = { id: item, type: "agentMessage", text };
    const meta = value.history.turns[0];
    meta.turnId = turn;
    meta.items[0].itemId = item;
    meta.cantripModelAttribution.threadId = thread;
    meta.cantripModelAttribution.turnId = turn;
    meta.cantripModelAttribution.isRoot = !parent;
    meta.contexts[0].rootTurnId = parent ? rootTurn : null;
    meta.usage = null;
    return value;
  }
  const parent = retained(
    "thread",
    rootTurn,
    "coordinator-root-item",
    "synthetic coordinator parent",
  );
  const child = retained(
    childThread,
    childTurn,
    "coordinator-child-item",
    "synthetic coordinator child",
    "thread",
  );
  child.thread.turns[0].status = "inProgress";
  child.thread.turns[0].completedAt = null;
  child.history.turns[0].items[0].state = "started";
  child.history.turns[0].items[0].completedAtMs = null;
  const activity = {
    id: "coordinator-child-activity",
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: childThread,
    agentPath: "root/child",
  };
  parent.thread.turns[0].items.push(activity);
  parent.history.turns[0].items.push({
    itemId: activity.id,
    state: "completed",
    startedAtMs: 1000,
    completedAtMs: 2000,
  });
  let native = spawn(),
    reference;
  async function call(input) {
    const result = await native.call(input);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  async function flush() {
    await call({ op: "history.flush.start" });
    await call({ op: "history.await" });
  }
  async function stop() {
    if (native) {
      await call({ op: "history.stop.start" });
      await call({ op: "history.await" });
      await native.stop();
      native = undefined;
    }
  }
  try {
    await call({
      op: "init",
      generation: "coordinator-runtime",
      config: {
        serverUrl,
        token,
        retryDelayMs: 5,
        maxRetryDelayMs: 10,
        snapshotDelayMs: 0,
        histories: { thread: parent, [childThread]: child },
      },
    });
    await call({ op: "history.start", directory, sourceScope, keyByte: 1 });
    await call({
      op: "history.scope.start",
      chatId,
      rootThreadId: "thread",
      threadId: childThread,
    });
    const missing = await native.call({ op: "history.await" });
    assert.equal(missing.ok, false);
    assert.equal(
      missing.error,
      "Child native output has no managed history root.",
    );
    await call({ op: "history.bind", chatId, threadId: "thread" });
    await flush();
    await call({
      op: "history.scope.start",
      chatId,
      rootThreadId: "thread",
      threadId: childThread,
      name: "a",
    });
    await call({
      op: "history.scope.start",
      chatId,
      rootThreadId: "thread",
      threadId: childThread,
      name: "b",
    });
    const scope = await call({ op: "history.await", name: "a" });
    assert.deepEqual(await call({ op: "history.await", name: "b" }), scope);
    const childBinding = await client.open({
      chatId,
      threadId: childThread,
      provenance: scope.provenance,
    });
    assert.deepEqual(childBinding.ancestorThreadIds, ["thread"]);
    assert.equal(scope.provenance.bindingId, childBinding.id);
    await flush();
    const initial = await readNativeHistoryRecovery({
      binding: childBinding,
      client,
      service,
    });
    const initialItem = initial.items.find(
      (v) => v.identity.itemId === "coordinator-child-item",
    );
    assert.equal(initialItem.revision, 1);
    assert.equal(initialItem.source.body.text, "synthetic coordinator child");
    const next = structuredClone(child);
    next.thread.turns[0].items[0].text =
      "synthetic coordinator child completed without child broadcast";
    next.thread.turns[0].status = "completed";
    next.thread.turns[0].completedAt = 2;
    next.history.turns[0].items[0].state = "completed";
    next.history.turns[0].items[0].completedAtMs = 2000;
    await call({
      op: "configure",
      config: { histories: { thread: parent, [childThread]: next } },
    });
    await call({
      op: "notification",
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: rootTurn,
        item: { ...activity, kind: "completed" },
      },
    });
    await flush();
    const updated = await readNativeHistoryRecovery({
      binding: childBinding,
      client,
      service,
    });
    const updatedItem = updated.items.find(
      (v) => v.identity.itemId === "coordinator-child-item",
    );
    assert.ok(updatedItem.revision > initialItem.revision);
    assert.equal(
      updatedItem.source.body.text,
      next.thread.turns[0].items[0].text,
    );
    const records = await call({ op: "history.records" });
    assert.equal(records.length, 2);
    assert.equal(
      records
        .find((v) => v.scope.threadId === childThread)
        .records.every((v) => v.frame.kind === "snapshot"),
      true,
      "parent dirty evidence reconciles child without fabricated child events",
    );
    const trace = await call({ op: "history.state" });
    assert.deepEqual(trace.errors, []);
    await call({ op: "history.stop.start", name: "first" });
    await call({ op: "history.stop.start", name: "second" });
    assert.deepEqual(await call({ op: "history.await", name: "first" }), []);
    assert.deepEqual(await call({ op: "history.await", name: "second" }), []);
    await native.stop();
    native = undefined;

    // Reopen native coordinator state with the actual Node facade, sequentially.
    const before = (
      await readNativeHistoryRecovery({ binding, client, service })
    ).batches.length;
    const beforeChild = updated.batches.length;
    reference = new ManagedNativeHistory({
      directory,
      workerId,
      service,
      client,
      attachments: new AttachmentStore(directory),
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
      snapshotDelayMs: 0,
    });
    await reference.flush();
    await reference.stop();
    reference = undefined;
    assert.equal(
      (await readNativeHistoryRecovery({ binding, client, service })).batches
        .length,
      before,
    );
    assert.equal(
      (
        await readNativeHistoryRecovery({
          binding: childBinding,
          client,
          service,
        })
      ).batches.length,
      beforeChild,
    );

    // A stopped-profile append is durable but unprojected. The production native
    // worker must discover it, obtain real grants and deliver it on startup.
    const journal = await NativeHistorySourceJournal.open({
      directory: path.join(directory, "native-history-sources"),
      workerId,
      chatId,
      bindingId: binding.id,
      threadId: "thread",
      service,
    });
    await journal.append({
      kind: "notification",
      generation: "coordinator-runtime",
      threadId: "thread",
      sequence: 2,
      receivedAtMs: 3,
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: rootTurn,
        item: {
          id: "coordinator-root-item",
          type: "agentMessage",
          text: "synthetic production startup recovery",
        },
      },
    });
    const runtime = await verifyHistoryRuntimeRecovery({
      workerBinary,
      directory,
      serverUrl: runtimeServerUrl,
      token,
      workerId,
      ownerId,
      visit,
      read: () => readNativeHistoryRecovery({ binding, client, service }),
      accept: (value) =>
        value.items.find((v) => v.identity.itemId === "coordinator-root-item")
          ?.source.body.text === "synthetic production startup recovery",
    });
    const final = await readNativeHistoryRecovery({ binding, client, service });
    assert.equal(
      final.items.find((v) => v.identity.itemId === "coordinator-root-item")
        .revision,
      2,
    );
    return {
      nativeHistoryCoordinator: true,
      verifiedChildBinding: true,
      parentEvidenceReconcilesUnbroadcastChild: true,
      childItemRevision: updatedItem.revision,
      repeatedStopJoined: true,
      sequentialNodeFacadeReopen: true,
      actualProductionWorkerStartupRecovery: runtime,
      rootItemRevisionAfterStartupRecovery: 2,
    };
  } finally {
    await reference?.stop();
    await stop();
  }
}
