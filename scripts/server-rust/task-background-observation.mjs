// Independent chats may win PostgreSQL's global sequence allocator in either
// order. Preserve the exact allocated set, all fields, per-chat ordering, and
// every database/event identity agreement while comparing those schedules.
import assert from "node:assert/strict";
export function backgroundObservation(value) {
  if (!value || typeof value !== "object") return value;
  const records = new Map(),
    sequences = new Map();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const chat = node.chat_id ?? node.chatId;
    if (
      typeof node.id === "string" &&
      typeof chat === "string" &&
      typeof node.sequence === "number" &&
      typeof node.role === "string"
    ) {
      const sequence = node.sequence;
      assert.ok(
        Number.isSafeInteger(sequence) && sequence > 0,
        "positive safe message sequence",
      );
      const previous = records.get(node.id);
      if (previous)
        assert.deepEqual(
          { chat, sequence, role: node.role },
          {
            chat: previous.chat,
            sequence: previous.sequence,
            role: previous.role,
          },
          "database and wire retain the same message identity, role and sequence",
        );
      else {
        assert.ok(
          !sequences.has(sequence) || sequences.get(sequence) === node.id,
          "global message sequences belong to exactly one message",
        );
        sequences.set(sequence, node.id);
        records.set(node.id, { id: node.id, chat, sequence, role: node.role });
      }
    }
    for (const child of Object.values(node))
      if (child && typeof child === "object") visit(child);
  }
  visit(value);
  const byChat = new Map();
  for (const record of records.values()) {
    const group = byChat.get(record.chat) ?? [];
    group.push(record);
    byChat.set(record.chat, group);
  }
  for (const [chat, group] of byChat) {
    group.sort((a, b) => a.sequence - b.sequence);
    for (const [index, record] of group.entries())
      record.canonical = `<message-sequence:${chat}:${index + 1}>`;
  }
  const introductions = new Map(),
    introduced = new Set();
  for (const event of value.events ?? []) {
    if (event.resource !== "chat-message" || !event.payload) continue;
    const record = records.get(event.payload.id);
    assert.ok(record, "message event identifies an observed message");
    assert.equal(
      event.entityId,
      record.id,
      "message event entity agrees with payload",
    );
    assert.equal(
      event.scope?.chatId,
      record.chat,
      "message event scope agrees with payload",
    );
    assert.equal(
      event.revision,
      record.sequence,
      "message event revision agrees with stored sequence",
    );
    if (!introduced.has(record.id)) {
      assert.ok(
        record.sequence > (introductions.get(record.chat) ?? 0),
        "first message publications remain ordered within each chat",
      );
      introductions.set(record.chat, record.sequence);
      introduced.add(record.id);
    }
  }
  function copy(node) {
    if (Array.isArray(node)) return node.map(copy);
    if (!node || typeof node !== "object") return node;
    const result = Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, copy(v)]),
    );
    const message = records.get(node.id);
    if (message && Object.hasOwn(node, "sequence"))
      result.sequence = message.canonical;
    if (node.resource === "chat-message" && node.payload)
      result.revision = records.get(node.payload.id).canonical;
    if (typeof node.resource === "string") {
      const record = records.get(node.payload?.id ?? node.entityId);
      if (record) result.__comparisonChat = record.chat;
    }
    return result;
  }
  return {
    ...copy(value),
    globalMessageSequences: [...sequences.keys()].sort((a, b) => a - b),
    messageSequenceWitness: [...byChat.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, group]) =>
        group.map(({ id, chat, role, canonical }) => ({
          id,
          chat,
          role,
          sequence: canonical,
        })),
      ),
  };
}
