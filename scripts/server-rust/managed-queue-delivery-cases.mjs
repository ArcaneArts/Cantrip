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
}
