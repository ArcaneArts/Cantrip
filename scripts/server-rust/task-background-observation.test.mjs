import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundObservation,
  backgroundSnapshotObservation,
} from "./task-background-observation.mjs";

const message = (chat_id, role, sequence) => ({
  id: `${chat_id}-${role}`,
  chat_id,
  role,
  sequence,
  protected_content: { envelope: `${chat_id}-${role}-opaque` },
});
const snapshot = () => ({
  messages: [
    message("a", "user", 1),
    message("b", "user", 2),
    message("a", "assistant", 3),
    message("b", "assistant", 4),
  ],
  queues: [{ chat_id: "a", revision: 3 }],
});

test("independent tenant message allocations compare without changing the raw snapshot", () => {
  const first = snapshot(),
    second = snapshot();
  const before = structuredClone(first);
  for (const row of second.messages)
    row.sequence += row.chat_id === "a" ? 1 : -1;
  second.messages.sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(
    backgroundSnapshotObservation(first),
    backgroundSnapshotObservation(second),
  );
  assert.deepEqual(first, before);
  assert.deepEqual(
    backgroundSnapshotObservation(first).globalMessageSequences,
    [1, 2, 3, 4],
  );
});

test("same-chat message order remains observable", () => {
  const first = snapshot(),
    reordered = snapshot();
  reordered.messages[0].sequence = 3;
  reordered.messages[2].sequence = 1;
  assert.notDeepEqual(
    backgroundSnapshotObservation(first),
    backgroundSnapshotObservation(reordered),
  );
});

test("missing allocator values remain observable", () => {
  const first = snapshot(),
    gap = snapshot();
  gap.messages[3].sequence = 5;
  assert.notDeepEqual(
    backgroundSnapshotObservation(first),
    backgroundSnapshotObservation(gap),
  );
});

test("the shared sequence cannot identify two different messages", () => {
  const value = snapshot();
  value.messages[1].sequence = value.messages[0].sequence;
  assert.throws(
    () => backgroundSnapshotObservation(value),
    /exactly one message/,
  );
});

test("stored message fields and queue metadata remain observable", () => {
  const first = snapshot(),
    changed = snapshot();
  changed.messages[0].protected_content.envelope = "different-opaque";
  assert.notDeepEqual(
    backgroundSnapshotObservation(first),
    backgroundSnapshotObservation(changed),
  );
  const changedQueue = snapshot();
  changedQueue.queues[0].revision++;
  assert.notDeepEqual(
    backgroundSnapshotObservation(first),
    backgroundSnapshotObservation(changedQueue),
  );
});

test("event revision and stored message sequence must agree", () => {
  const value = snapshot();
  value.events = [
    {
      resource: "chat-message",
      entityId: "a-user",
      scope: { chatId: "a" },
      revision: 2,
      payload: { id: "a-user" },
    },
  ];
  assert.throws(
    () => backgroundObservation(value),
    /agrees with stored sequence/,
  );
});
