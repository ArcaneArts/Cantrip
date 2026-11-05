import { modelConfigurationSchema } from "../../packages/protocol/dist/index.js";

export function mcpChatReadWireFixtures(fixtures) {
  const message = structuredClone(fixtures.chatMessageOpaqueSummarySchema[0]);
  const descriptor = {
    id: message.chatId,
    titleProtection: structuredClone(
      fixtures.encryptedChatCreateSchema[0].titleProtection,
    ),
    status: "idle",
    automationPaused: false,
    configuration: modelConfigurationSchema.parse({ modelId: null }),
  };
  const empty = {
    cursor: "a".repeat(64),
    chat: descriptor,
    sender: structuredClone(descriptor),
    messages: [],
    page: {
      hasMore: false,
      nextBeforeSequence: null,
      oldestSequence: null,
      newestSequence: null,
      startsAtUserTurn: true,
    },
  };
  const populated = structuredClone(empty);
  populated.messages.push(message);
  Object.assign(populated.page, {
    oldestSequence: message.sequence,
    newestSequence: message.sequence,
    startsAtUserTurn: message.role === "user",
  });
  return {
    cantripMcpChatListInputSchema: [
      {},
      { cursor: 0, limit: 1 },
      { cursor: 100_000, limit: 100 },
    ],
    cantripMcpChatReadInputSchema: [
      { chatId: message.chatId },
      { chatId: message.chatId, beforeSequence: 1, limit: 1, maxChars: 1 },
      { chatId: message.chatId, limit: 50, maxChars: 100_000 },
    ],
    agentChatReadWireSchema: [empty, populated],
  };
}
