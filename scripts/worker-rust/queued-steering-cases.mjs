import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyQueuedSteering({
  call,
  eventually,
  createModel,
  encryptedTurn,
  openMessage,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  chatKey,
}) {
  const { profile, model } = await createModel("Native steering fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Queued steering fixture",
  });
  const { server } = await call("GET", "/api/bootstrap", 200);
  const first = model.reply({ hold: true });
  const second = model.reply({ hold: true });
  const answer = "The same turn processed the steered inputs.";
  const final = model.reply({ text: answer });
  const displayed = [
    "Steer through the ordinary queue 🌲",
    "Steer a retained native input 🍄",
  ];
  const retained = "Retained native input reached the provider";
  const root = await encryptedTurn(
    "Hold the active turn for steering.",
    profile.id,
  );
  const messages = [];
  try {
    await call("POST", chatUrl + "/turns", 202, root);
    await eventually(
      () => first.request,
      (request) => assert.ok(request),
    );
    for (const [index, text] of displayed.entries()) {
      const input = await encryptedTurn(text, profile.id);
      if (index === 1) {
        const associatedData = {
          ownerId,
          keyRevision,
          component: "chat-content",
          table: "managed-queue",
          rowId: createHash("sha256")
            .update(JSON.stringify([server.id, chatId, input.queuedPrompt.id]))
            .digest("hex"),
          field: "native-input",
          formatVersion: 1,
        };
        input.queuedPrompt.protectedNativeInput = await crypto.encryptPayload({
          key: crypto.deriveFieldKey({
            componentKey: chatKey,
            ...associatedData,
          }),
          associatedData,
          plaintext: Buffer.from(
            JSON.stringify({
              version: 1,
              displayText: text,
              action: "literal",
              executionMethod: "turn/start",
              input: [{ type: "text", text: retained, text_elements: [] }],
            }),
          ),
        });
        input.queuedPrompt.executionMethod = "turn/start";
      }
      const queued = await call("POST", chatUrl + "/turns", 202, input);
      assert.equal(queued.status, "queued");
      const steerUrl = `/api/queued-prompts/${queued.prompt.id}/steer`;
      await call("POST", steerUrl, 409, {});
      const request = {
        expectedItemRevision: queued.prompt.revision,
        operationId: randomUUID(),
      };
      const accepted = await call("POST", steerUrl, 200, request);
      assert.equal(accepted.steered, true);
      assert.equal(accepted.message.id, input.message.id);
      assert.equal((await openMessage(accepted.message)).content[0].text, text);
      messages.push(input.message.id);
      const next = index === 0 ? second : final;
      const expected = index === 0 ? text : retained;
      await eventually(
        () => next.request,
        (record) =>
          assert.ok(JSON.stringify(record?.input.input).includes(expected)),
      );
    }
  } finally {
    first.release();
    second.release();
  }
  await eventually(
    () => final.request,
    (request) => assert.equal(request?.completed, true),
  );
  await eventually(
    async () => {
      const response = await call("GET", chatUrl + "/messages", 200);
      return Promise.all(
        response.messages.map(async (message) => ({
          id: message.id,
          content: (await openMessage(message)).content,
        })),
      );
    },
    (items) => {
      for (const [index, id] of messages.entries()) {
        assert.equal(items.filter((item) => item.id === id).length, 1);
        assert.equal(
          items.filter((item) =>
            item.content.some(({ text }) => text === displayed[index]),
          ).length,
          1,
        );
      }
      assert.ok(
        items.some((item) => item.content.some(({ text }) => text === answer)),
      );
    },
  );
  await eventually(
    () => call("GET", chatUrl + "/queue", 200),
    (queue) => assert.equal((queue.items ?? queue).length, 0),
  );
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({ suite: "native-queued-steering", passed: true }),
  );
}
