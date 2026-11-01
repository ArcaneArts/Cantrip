import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { standaloneChatWireFixtures } from "./standalone-chat-wire-fixtures.mjs";

export function publicChatWireFixtures(timestamp) {
  const prompt = retainedPrompt();
  const messages = standaloneChatWireFixtures(timestamp);
  const queued = {
    ...prompt,
    revision: 0,
    state: "pending",
    chatId: "chat",
    attachments: [],
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const message = messages.chatMessageOpaqueSummarySchema[0];
  const task = messages.taskMessageOpaqueSummarySchema[0];
  return {
    encryptedChatTurnCreateSchema: [
      {
        message: prompt.pendingMessage,
        queuedPrompt: prompt,
        modelId: prompt.modelId,
      },
    ],
    encryptedQueuedPromptListSchema: [[], [queued]],
    encryptedQueuedPromptUpdateSchema: [
      { prompt },
      { prompt, expectedItemRevision: 0, operationId: "update" },
    ],
    queuedPromptOrderSchema: [
      { ids: [] },
      { ids: [prompt.id], expectedRevision: 0, operationId: "order" },
    ],
    encryptedChatPromptSubmitResultSchema: [
      { status: "started", message },
      { status: "queued", prompt: queued },
    ],
    encryptedConversationPromptSubmitResultSchema: [
      { status: "started", message },
      { status: "queued", prompt: queued },
      { status: "started", kind: "task-encrypted", message: task },
    ],
    encryptedChatPromptSteerResultSchema: [{ steered: true, message }],
  };
}
export function publicChatWireCases(name, samples) {
  if (name !== "encryptedChatTurnCreateSchema") return [];
  const result = [];
  const add = (change) => {
    const value = structuredClone(samples[0]);
    change(value);
    result.push(value);
  };
  add((v) => {
    v.queuedPrompt.pendingMessage.id = "e1e1e1e1-1111-4111-8111-000000000999";
  });
  add((v) => {
    v.queuedPrompt.pendingMessage.idempotencyKey = "different";
  });
  add((v) => {
    v.modelId = "different";
  });
  add((v) => {
    v.queuedPrompt.pendingMessage.idempotencyKey = "different";
    v.modelId = "different";
  });
  add((v) => {
    delete v.modelId;
  });
  add((v) => {
    v.message = Object.fromEntries(Object.entries(v.message).reverse());
  });
  add((v) => {
    v.message.idempotencyKey = "\ud800\udfff😀e\u0301";
    v.queuedPrompt.pendingMessage.idempotencyKey = v.message.idempotencyKey;
  });
  add((v) => {
    v.message.classification.attachmentIds = ["\ud800"];
    v.queuedPrompt.pendingMessage.classification.attachmentIds = ["\udfff"];
  });
  return result;
}
