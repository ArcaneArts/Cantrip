import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal } from "./project-target-state.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";
import { receiptReadLock } from "./native-queue-receipt-lock.mjs";

export async function nativeQueueDisconnectedMutation({
  h,
  client,
  result,
  databaseUrl,
}) {
  const content = nativeQueueHttpContent(h, result),
    session = h.prepared[chat].session;
  const query = async (sql) => (await h.fixture.sql([], [sql]))[0];
  const drained = async (revision) => {
    const deadline = Date.now() + 15000;
    let state;
    do {
      state = await query(
        `SELECT jsonb_build_object('revision',revision,'notified',notified_revision)::text result FROM managed_queue_states WHERE chat_id=${literal(chat)}`,
      );
      if (state.notified === revision) break;
      await sleep(20);
    } while (Date.now() < deadline);
    assert.deepEqual(state, { revision, notified: revision });
    await h.live.ping("disconnected-mutation-drained-" + revision);
  };
  const events = () =>
    h.live.history.filter(
      (v) => v.type === "event" && v.resource === "chat-queue",
    );
  await content.sdk("worker reads before disconnected mutation", () =>
    client.read({ session }),
  );
  await drained(0);
  const beforeEvents = events().length;
  const prompt = await content.prompt({
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    messageId: "ffffffff-ffff-4fff-8fff-fffffffffff2",
    key: "disconnected-queue-write",
    text: "Private disconnected queue mutation 🌴",
  });
  const admission = command({
    workerId: worker,
    operationId: "queue-disconnected-mutation",
    session,
    method: "thread/queue/add",
  });
  const input = {
    admission,
    expectedRevision: 0,
    mutation: { kind: "add", prompt, attachments: [] },
  };
  const blocker = await receiptReadLock(databaseUrl, "mutation"),
    controller = new AbortController();
  const pending = client.mutate(input, controller.signal);
  pending.catch(() => {});
  try {
    const waiting = await blocker.waiting();
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error.code === "queue-operation-uncertain",
    );
    const retained = await blocker.waiters();
    assert.ok(
      retained.some((v) => v.pid === waiting[0].pid),
      "actual SQL transaction stays owned after its HTTP writer disconnects",
    );
    await blocker.release();
    const found = await content.sdk(
      "worker reconciles original mutation after lost HTTP response",
      () => client.lookup({ admission }),
    );
    assert.equal(found.found, true);
    assert.equal(found.receipt.status, "applied");
    assert.equal(found.receipt.operationId, admission.operationId);
    assert.equal(found.revision, 1);
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].id, prompt.id);
    await drained(1);
    assert.equal(
      events().length - beforeEvents,
      2,
      "disconnected mutation still publishes its route and durable revision invalidations",
    );
    const { found: _found, ...mutation } = found;
    assert.deepEqual(
      await content.sdk(
        "worker explicitly replays original uncertain operation",
        () => client.mutate(input),
      ),
      mutation,
    );
    assert.deepEqual(
      await query(
        `SELECT jsonb_build_object('commands',(SELECT count(*) FROM native_commands WHERE operation_id=${literal(admission.operationId)}),'prompts',(SELECT count(*) FROM queued_prompts WHERE id=${literal(prompt.id)}),'revision',(SELECT revision FROM managed_queue_states WHERE chat_id=${literal(chat)}))::text result`,
      ),
      { commands: 1, prompts: 1, revision: 1 },
    );
    result.rawReads = { waiting, retained };
    result.proofs.push(
      "real locked queue mutation survives caller disconnect, commits once and publishes both route and durable notifications",
    );
    result.proofs.push(
      "unchanged worker SDK reports uncertainty, reconciles the original immutable receipt and replays without duplicate encrypted input",
    );
  } finally {
    controller.abort();
    await blocker.close();
    await pending.catch(() => {});
  }
  content.finish();
}
