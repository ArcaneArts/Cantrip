import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encryptPrivateDisplayLabel } from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { managedMcpClient } from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpChats({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  openMessage,
  serverDiagnostics,
}) {
  const sourceTitle = 'Fixture sender "Cantrip" 🌲';
  const targetTitle = "Fixture receiver 🧭";
  const { profile, model } = await createModel("MCP Chat sender");
  const receiver = await createModel("MCP Chat receiver");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl, projectUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: sourceTitle,
  });
  const target = randomUUID();
  const targetUrl = `/api/chats/${target}`;
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: receiver.profile.id,
  });
  await call("POST", projectUrl + "/chats", 201, {
    id: target,
    titleProtection: await encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "chat",
      rowId: target,
      componentKey: labelKey,
      label: targetTitle,
    }),
    autoTitle: false,
  });
  await eventually(
    () => call("GET", targetUrl + "/preparation", 200),
    (state) => assert.equal(state.preparation?.phase, "ready"),
  );
  await call("PATCH", targetUrl + "/model", 200, {
    modelId: receiver.profile.id,
  });
  await call("PATCH", "/api/settings", 200, { defaultModelId: profile.id });
  await call("PATCH", targetUrl + "/pause", 200, { paused: true });

  const invoke = managedMcpClient({
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  });
  const first = (await invoke("chat_list", { limit: 1 })).data;
  assert.equal(first.chats.length, 1);
  assert.equal(first.nextCursor, 1);
  const second = (await invoke("chat_list", { cursor: first.nextCursor })).data;
  assert.equal(second.nextCursor, null);
  const listed = [...first.chats, ...second.chats];
  assert.equal(listed.find(({ id }) => id === chatId).title, sourceTitle);
  assert.deepEqual(
    listed.find(({ id }) => id === target),
    {
      id: target,
      title: targetTitle,
      status: "idle",
      automationPaused: true,
      modelId: receiver.profile.id,
    },
  );

  const empty = (await invoke("chat_read", { chatId: target })).data;
  assert.deepEqual(empty.messages, []);
  const wait = { chatId: target, afterCursor: empty.cursor, timeoutMs: 50 };
  const timed = (await invoke("chat_wait", wait)).data;
  assert.equal(timed.timedOut, true);
  assert.equal(timed.cursor, wait.afterCursor);
  const message = "🧭 Private delegated Chat message";
  const operationId = randomUUID();
  const send = { chatId: target, operationId, message };
  const delivery = await invoke("chat_send", send);
  assert.equal(delivery.mutated, true);
  assert.equal(delivery.data.operationId, operationId);
  assert.equal(delivery.data.message, message);
  assert.equal(delivery.data.delivery, "queued");
  assert.equal(delivery.data.targetTitle, targetTitle);
  assert.equal(
    (await invoke("chat_send", send)).data.messageId,
    delivery.data.messageId,
  );
  const queue = await call("GET", targetUrl + "/queue", 200);
  const prompts = queue.items ?? queue;
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].modelId, receiver.profile.id);
  assert.equal(
    receiver.model.requests.filter(({ method }) => method === "POST").length,
    0,
  );
  assert.ok(!JSON.stringify(queue).includes(message));

  const changed = (await invoke("chat_wait", wait)).data;
  assert.equal(changed.timedOut, false);
  assert.notEqual(changed.cursor, wait.afterCursor);
  assert.equal(changed.messages.length, 1);
  const communication = {
    deliveryId: operationId,
    sourceChatId: chatId,
    sourceTitle,
    targetChatId: target,
    targetTitle,
    direction: "received",
  };
  const received = changed.messages[0];
  assert.equal(received.id, delivery.data.messageId);
  assert.equal(received.role, "agent");
  assert.equal(received.text, message);
  assert.deepEqual(received.chatCommunication, communication);
  const clipped = (await invoke("chat_read", { chatId: target, maxChars: 3 }))
    .data;
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.messages[0].text, "🧭 ");
  await invoke(
    "chat_read",
    { chatId: randomUUID() },
    /Chat not found in the current project/u,
  );
  await invoke("chat_send", { ...send, chatId }, /Send to another chat/u);

  const stored = await call("GET", chatUrl + "/messages", 200);
  assert.ok(!JSON.stringify(stored).includes(message));
  const sent = (await Promise.all(stored.messages.map(openMessage)))
    .flatMap(({ content }) => content)
    .filter(
      ({ chatCommunication }) => chatCommunication?.deliveryId === operationId,
    );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, message);
  assert.deepEqual(sent[0].chatCommunication, {
    ...communication,
    direction: "sent",
  });
  const reply = receiver.model.reply({
    text: "The delegated message arrived.",
  });
  await call("PATCH", targetUrl + "/pause", 200, { paused: false });
  await eventually(
    () => reply.request,
    (request) =>
      assert.equal(
        request?.completed,
        true,
        JSON.stringify({
          senderFailures: model.failures,
          receiverFailures: receiver.model.failures,
          receiverPosts: receiver.model.requests.filter(
            ({ method }) => method === "POST",
          ).length,
        }),
      ),
  );
  await eventually(
    async () => {
      const { messages } = await call("GET", targetUrl + "/messages", 200);
      return Promise.all(messages.map(openMessage));
    },
    (opened) => {
      assert.ok(
        opened.some(({ content }) =>
          content.some(({ text }) => text === "The delegated message arrived."),
        ),
      );
    },
  );
  assert.ok(JSON.stringify(reply.request.input.input).includes(message));
  assert.ok(
    JSON.stringify(reply.request.input.input).includes(
      "This is another agent, not the human user.",
    ),
  );
  const finished = (await invoke("chat_read", { chatId: target })).data;
  const matching = finished.messages.filter(
    ({ chatCommunication }) => chatCommunication?.deliveryId === operationId,
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0].role, "agent");
  assert.equal(matching[0].text, message);
  assert.ok(!serverDiagnostics().includes(message));
  assert.deepEqual([...model.failures, ...receiver.model.failures], []);
  console.log(
    JSON.stringify({
      suite: "native-managed-mcp-chats",
      passed: true,
      encryptedIdempotentDelivery: true,
      attributedReceiverInference: true,
      scopedPagedReadsAndWait: true,
    }),
  );
}
