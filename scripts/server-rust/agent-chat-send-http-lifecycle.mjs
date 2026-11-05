import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeCantripMcpChatOperation } from "../../cantrip_worker/src/mcp/chat-operations.ts";
import { LiveProbe } from "./live-sockets.mjs";
export function deliveryLifecycle({
  h,
  binding,
  result,
  state,
  call,
  target,
  chat,
  marker,
  wire,
  id,
}) {
  async function read(name, receiver = target) {
    const value = await executeCantripMcpChatOperation({
      binding,
      service: h.encryption,
      requestId: name,
      request: {
        operation: "chat.read",
        arguments: { chatId: receiver, limit: 20, maxChars: 100000 },
      },
      execute: async (_binding, request) => {
        const observed = await call(name, request.operation, request.arguments);
        assert.equal(observed.status, 200);
        const data = observed.body.data,
          current = await state(),
          rows = current.messages.filter((m) => m.chat_id === receiver);
        assert.equal(
          data.messages.length,
          rows.length,
          "Complete retained fixture transcript is exposed",
        );
        assert.deepEqual(
          data.messages.map((message) => message.sequence),
          rows.map((row) => row.sequence).sort((a, b) => a - b),
          "The wire transcript preserves the actual database sequence order",
        );
        for (const message of data.messages) {
          const row = rows.find((r) => r.id === message.id);
          assert.ok(row);
          assert.deepEqual(message.protectedContent, row.protected_content);
          assert.equal(message.sequence, row.sequence);
        }
        const cursor = createHash("sha256")
          .update(
            JSON.stringify({
              chatId: receiver,
              status: data.chat.status,
              paused: data.chat.automationPaused,
              messages: data.messages.map((m) => [
                m.id,
                m.sequence,
                m.protectedContent,
              ]),
            }),
          )
          .digest("hex");
        assert.equal(
          data.cursor,
          cursor,
          "Cursor names actual persisted ciphertext",
        );
        return observed.body;
      },
    });
    const messages = value.data.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      chatCommunication: m.chatCommunication,
    }));
    assert.ok(messages.some((m) => m.text.includes(marker(1))));
    for (const message of messages) {
      const known = [...wire].find(([, args]) =>
        [args.sentMessage.id, args.receivedMessage.id].includes(message.id),
      );
      assert.ok(
        known,
        "Decrypted history identifies an actual prepared delivery",
      );
      const [n, args] = known;
      const received = message.id === args.receivedMessage.id;
      assert.equal(message.text, marker(n));
      assert.equal(message.chatCommunication.deliveryId, id(n));
      assert.equal(
        message.chatCommunication.direction,
        received ? "received" : "sent",
      );
      assert.equal(message.role, received ? "agent" : "assistant");
    }
    assert.equal(messages.length, 7);
    assert.deepEqual(
      messages.slice(0, 5).map((m) => m.chatCommunication.deliveryId),
      [1, 2, 3, 5, 8].map(id),
    );
    assert.deepEqual(
      messages
        .slice(5)
        .map((m) => m.chatCommunication.deliveryId)
        .sort(),
      [id(6), id(7)],
    );
    // The two independent reverse-direction transactions can acquire the
    // project lock in either order. Each actual sequence/ciphertext/cursor was
    // checked above; only that concurrent suffix is canonicalized across peers.
    const comparisonMessages = [
      ...messages.slice(0, 5),
      ...messages
        .slice(5)
        .sort((a, b) =>
          a.chatCommunication.deliveryId.localeCompare(
            b.chatCommunication.deliveryId,
          ),
        ),
    ];
    result.decryptedReads ??= [];
    result.decryptedReads.push({
      name,
      receiver,
      messages,
      comparisonMessages,
    });
    return value;
  }
  async function restart() {
    await h.live.ping("pre-restart delivery events");
    result.eventsBeforeRestart = h.live.frames.filter(
      (f) => f.type === "event" && f.resource === "chat-message",
    );
    h.worker.close();
    await h.live.close();
    const port = Number(new URL(h.fixture.server.origin).port);
    await h.fixture.close();
    await h.fixture.start({ port });
    await h.reconnectWorker();
    h.live = await new LiveProbe(h.fixture).open();
    await h.live.initialized();
    await h.live.subscribed("delivery-after-restart", [
      { kind: "chat", chatId: chat },
      { kind: "chat", chatId: target },
    ]);
    result.actualServerRestartVerified = true;
  }
  return { read, restart };
}
