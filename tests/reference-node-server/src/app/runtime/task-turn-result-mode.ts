export function taskMessageTurnResultMode(
  response: { id: string; idempotencyKey: string },
  reusePublishedResponse: boolean,
) {
  return {
    kind: "task-message-encrypted" as const,
    messageId: response.id,
    idempotencyKey: response.idempotencyKey,
    ...(reusePublishedResponse ? { reusePublishedResponse: true } : {}),
  };
}
