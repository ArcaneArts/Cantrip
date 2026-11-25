import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { uniqueChatCommunicationMessages } from "../../packages/protocol/dist/index.js";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

export async function actualCouncilProjectMessages({
  page,
  model,
  tools,
  submit,
  readChat,
  result,
  projectId,
  councilId,
  targetChatId,
  targetWorkerId,
}) {
  const target = await taskModelProvider();
  const prepareText = "Open the existing project chat on its worker.";
  const delegatedText = "Verify the Council handoff is delivered once 🍄.";
  const answer = "The project worker received the Council handoff.";
  const sender = "Disposable Operations Agent";
  const expectedPermission = ":read-only";
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
  const read = () =>
    page.evaluate(
      async (chat) => (await import("/src/lib/api/chats.ts")).getMessages(chat),
      targetChatId,
    );
  try {
    const initial = target.reply({
      text: "The existing project chat is ready.",
    });
    const ready = await page.evaluate(
      async ({
        baseUrl,
        nativeModel,
        targetChatId,
        targetWorkerId,
        prepareText,
        expectedPermission,
      }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable project provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable project model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({ defaultModelId: profile.id });
        const workers = await (
          await import("/src/lib/api/worker-wire.ts")
        ).getWorkers();
        const worker = workers.find(
          ({ workerId }) => workerId === targetWorkerId,
        );
        await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({ worker });
        const api = await import("/src/lib/api/chats.ts");
        await api.updateChatPermissionProfile(targetChatId, expectedPermission);
        return api.startTurn(targetChatId, prepareText, {
          modelId: profile.id,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        });
      },
      {
        baseUrl: target.baseUrl,
        nativeModel: target.model,
        targetChatId,
        targetWorkerId,
        prepareText,
        expectedPermission,
      },
    );
    assert.equal(ready.status, "queued");
    await eventually(
      () => initial.request?.completed,
      (complete) => assert.equal(complete, true),
      60_000,
    );
    await eventually(
      read,
      (messages) =>
        assert.ok(
          messages.some(({ content }) =>
            content.some(
              ({ text }) => text === "The existing project chat is ready.",
            ),
          ),
        ),
      60_000,
    );

    const send = tools.find(
      ({ name }) =>
        name === "council_project_send" ||
        name.endsWith("__council_project_send"),
    );
    assert.ok(send);
    const operationId = randomUUID();
    const args = {
      operationId,
      projectId,
      chatId: targetChatId,
      message: delegatedText,
    };
    const signal = (key) =>
      model.reply({
        responseId: `council-project-${key}`,
        calls: [{ ...send, arguments: args }],
      });
    signal("first");
    const duplicate = signal("retry");
    const done = model.reply({ text: "I sent the work to the project chat." });
    const remote = target.reply({ text: answer });
    assert.equal(
      (
        await submit(
          "Send this brief to the existing project chat, then retry the same delivery.",
        )
      ).status,
      "queued",
    );
    await eventually(
      () => done.entered,
      (entered) => assert.ok(entered, JSON.stringify(model.failures)),
      60_000,
    );
    const delivery = (plan, key) => {
      const item = plan.request.input.input.find(
        ({ type, call_id }) =>
          type === "function_call_output" &&
          call_id === `council-project-${key}-call-0`,
      );
      assert.ok(item, `Missing Council delivery ${key}`);
      const text =
        typeof item.output === "string"
          ? item.output
          : item.output.map(({ text }) => text).join("\n");
      const parts = text.split("\nOutput:\n");
      assert.equal(parts.length, 2, text);
      const { data } = JSON.parse(parts[1]);
      assert.ok(data, text);
      return data;
    };
    const receipt = delivery(duplicate, "first");
    assert.deepEqual(delivery(done, "retry"), receipt);
    assert.equal(receipt.sourceChatId, councilId);
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.chatId, targetChatId);
    const messages = await eventually(
      read,
      (messages) =>
        assert.ok(
          messages.some(({ content }) =>
            content.some(({ text }) => text === answer),
          ),
        ),
      60_000,
    );
    const incoming = messages.filter(
      ({ id, role, content }) =>
        id === receipt.inputMessageId &&
        role === "user" &&
        content.some(({ text }) => text === delegatedText),
    );
    assert.equal(incoming.length, 1);
    assert.ok(incoming[0].executionLaneId);
    assert.ok(
      incoming[0].content.some(
        ({ chatCommunication }) =>
          chatCommunication?.senderKind === "council" &&
          chatCommunication.sourceTitle === sender,
      ),
    );
    assert.deepEqual(
      uniqueChatCommunicationMessages(messages)
        .filter(({ content }) =>
          content.some(
            ({ chatCommunication }) =>
              chatCommunication?.deliveryId === operationId,
          ),
        )
        .map(({ id }) => id),
      [receipt.inputMessageId],
    );
    const received = messages.filter(({ id }) => id === receipt.messageId);
    assert.equal(received.length, 1);
    assert.ok(
      received[0].content.some(
        ({ chatCommunication }) =>
          chatCommunication?.senderKind === "council" &&
          chatCommunication.sourceTitle === sender,
      ),
    );
    const prompt = JSON.stringify(remote.request?.input.input);
    assert.ok(prompt.includes(delegatedText) && prompt.includes(sender));
    assert.equal(
      target.requests.filter(({ method }) => method === "POST").length,
      2,
    );
    assert.deepEqual(target.failures, []);
    await idle();
    const permissions = await page.evaluate(
      async (chat) =>
        (await import("/src/lib/api/chats.ts")).getChatPermissionProfiles(chat),
      targetChatId,
    );
    assert.equal(permissions.effectiveId, expectedPermission);
    result.councilProjectMessages = { targetWorkerId, projectId, ...receipt };
    result.steps.push(
      "Council retried one stable project delivery and the remote Worker ran one input with Council attribution and the chat's read-only permission",
    );
  } finally {
    await target.close();
  }
}
