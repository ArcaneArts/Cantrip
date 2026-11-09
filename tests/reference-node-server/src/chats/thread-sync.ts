import type {
  AgentActivity,
  AgentThreadSync,
  ChatAttachmentSummary,
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
    externalAttachments?: ReadonlyMap<string, ChatAttachmentSummary>;
  },
): CanonicalThreadSyncMessage[] {
  const messages: CanonicalThreadSyncMessage[] = [];
  for (const turn of sync.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const content: ChatMessageCreate["content"] = [
          ...(item.text.trim()
            ? ([{ type: "text", text: item.text }] as const)
            : []),
          ...item.externalAttachmentIds.flatMap((attachmentId) => {
            const attachment = options.externalAttachments?.get(attachmentId);
            return attachment
              ? ([{ type: "attachment", attachment }] as const)
              : [];
          }),
        ];
        if (!content.length) {
          content.push({
            type: "text",
            text: "[Imported message content was unavailable.]",
          });
        }
        messages.push({
          turnId: turn.id,
          activity: null,
          message: {
            role: "user",
            content,
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
