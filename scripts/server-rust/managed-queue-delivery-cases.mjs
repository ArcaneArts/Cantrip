import assert from "node:assert/strict";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
export async function runManagedQueueDeliveryCases(h) {
  const { call, request, mutate, setup } = h;
  const prompt = (changes = {}) => retainedPrompt(changes);
  const add = (changes = {}) => ({
    kind: "add",
    prompt: prompt(changes),
    attachments: [],
  });
  const { snapshot } = h;
  await setup();
  await mutate("queue notification revision", request(add()));
  await call("pending-notifications", "deliver pending queue revision");
  await call("ack-notification", "future revision does not acknowledge", {
    revision: 99,
  });
  await call(
    "pending-notifications",
    "future acknowledgment preserved notification",
  );
  await call("ack-notification", "acknowledge current revision", {
    revision: 1,
  });
  const notified = await call(
    "pending-notifications",
    "notification acknowledged",
  );
  for (const r of notified)
    assert.equal(
      r.some((n) => n.chatId === "chat"),
      false,
    );
  await mutate(
    "queue revision after acknowledgment",
    request({ kind: "reorder", ids: [promptId] }, { revision: 1 }),
  );
  const beforeDefer = Date.now();
  await call("defer-notification", "defer queue notification");
  const afterDefer = Date.now(),
    deferred = await snapshot("actual deferred notification clocks");
  for (const s of deferred) {
    const due = Date.parse(
      s.queues.find((q) => q.chat_id === "chat").notification_due_at,
    );
    assert.ok(
      due >= beforeDefer + 4000 && due <= afterDefer + 6000,
      "notification deferred five seconds",
    );
  }
  for (const limit of [0, -1, 1, 1.5])
    await call(
      "pending-notifications",
      "notification limit " + limit,
      { limit },
      limit === 1.5 ? { error: true, sqlstate: "22P02" } : {},
    );
  await setup();
  await mutate("runtime delivery pending revision", request(add()));
  const delivered = await call(
    "deliver",
    "runtime delivery uses real admitted worker wire command",
  );
  for (const trace of delivered) {
    const published = trace.findIndex(
      (v) => v.kind === "publish" && v.chatId === "chat",
    );
    const requested = trace.findIndex(
      (v) => v.kind === "request" && v.command.chatId === "chat",
    );
    assert.ok(
      published >= 0 && requested > published,
      "publish precedes worker request",
    );
    assert.deepEqual(trace[requested].command, {
      type: "chat.queue.changed",
      chatId: "chat",
      revision: 1,
    });
    assert.equal(
      trace.some((v) => v.kind === "error"),
      false,
    );
  }
  const noPending = await call(
    "pending-notifications",
    "runtime delivery acknowledges persisted revision",
  );
  for (const notices of noPending)
    assert.equal(
      notices.some((n) => n.chatId === "chat"),
      false,
    );
  const repeated = await call(
    "deliver",
    "runtime delivery does not repeat acknowledged revision",
  );
  for (const trace of repeated) assert.deepEqual(trace, []);
  await mutate(
    "runtime delivery newer revision",
    request({ kind: "reorder", ids: [promptId] }, { revision: 1 }),
  );
  const beforeFailure = Date.now();
  const failures = await call(
    "deliver",
    "runtime delivery defers real worker rejection",
    { responseError: true },
  );
  const afterFailure = Date.now();
  for (const trace of failures)
    assert.ok(
      trace.some(
        (v) => v.kind === "error" && v.message === "Queue worker failed",
      ),
    );
  const failedState = await snapshot(
    "runtime delivery rejection clock and revision",
  );
  for (const s of failedState) {
    const queue = s.queues.find((q) => q.chat_id === "chat");
    assert.equal(queue.notified_revision, 1);
    assert.equal(queue.revision, 2);
    const due = Date.parse(queue.notification_due_at);
    assert.ok(
      due >= beforeFailure + 4000 && due <= afterFailure + 6000,
      "actual rejection deferred five seconds",
    );
  }
  const deferredRun = await call(
    "deliver",
    "runtime delivery respects durable defer deadline",
  );
  for (const trace of deferredRun) assert.deepEqual(trace, []);
}
