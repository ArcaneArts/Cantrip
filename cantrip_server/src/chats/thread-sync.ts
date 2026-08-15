import type {
  AgentActivity,
  AgentThreadSync,
  ChatMessageCreate,
} from "@cantrip/protocol";

export interface CanonicalThreadSyncMessage {
  activity: AgentActivity | null;
  message: ChatMessageCreate & { idempotencyKey: string };
  turnId: string;
}

export function canonicalMessagesFromThreadSync(
  sync: AgentThreadSync,
  options: {
    failedMessage: string;
    idempotencyPrefix: string;
    interruptedMessage: string;
  },
): CanonicalThreadSyncMessage[] {
  const messages: CanonicalThreadSyncMessage[] = [];
  for (const turn of sync.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        messages.push({
          turnId: turn.id,
          activity: null,
          message: {
            role: "user",
            content: [{ type: "text", text: item.text }],
            idempotencyKey: `${options.idempotencyPrefix}:${turn.id}:${item.id}`,
          },
        });
      } else if (item.type === "agentMessage") {
        messages.push({
          turnId: turn.id,
          activity: null,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: item.text,
                phase: item.phase,
                correlation: item.correlation,
              },
            ],
            idempotencyKey: `${options.idempotencyPrefix}:${turn.id}:${item.id}`,
          },
        });
      } else {
        messages.push({
          turnId: turn.id,
          activity: item.activity,
          message: {
            role: "assistant",
            content: [{ type: "activity", activity: item.activity }],
            idempotencyKey: `${options.idempotencyPrefix}:${turn.id}:${item.activity.id}`,
          },
        });
      }
    }
    if (turn.status === "failed" || turn.status === "interrupted") {
      messages.push({
        turnId: turn.id,
        activity: null,
        message: {
          role: "system",
          content: [
            {
              type: "text",
              text:
                turn.status === "interrupted"
                  ? options.interruptedMessage
                  : options.failedMessage,
            },
          ],
          idempotencyKey: `${options.idempotencyPrefix}:${turn.id}:status`,
        },
      });
    }
  }
  return messages;
}
