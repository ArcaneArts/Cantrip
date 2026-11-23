// Server wire input stays opaque; the worker owns public text/tool input parsing.
export function mcpChatSendWireFixtures(fixtures) {
  const turn = structuredClone(fixtures.encryptedChatTurnCreateSchema[0]);
  const sent = structuredClone(fixtures.chatMessageOpaqueContentSchema[0]);
  const received = structuredClone(sent);
  const operationId = "55555555-5555-4555-8555-555555555555";
  const chatId = "44444444-4444-4444-8444-444444444444";
  const input = {
    chatId,
    operationId,
    turn,
    sentMessage: sent,
    receivedMessage: received,
  };
  const explicit = structuredClone(input);
  explicit.turn.queuedPrompt.executionMethod = "turn/start";
  explicit.turn.queuedPrompt.nativeAction = "literal";
  return { agentChatSendWireSchema: [input, explicit] };
}
