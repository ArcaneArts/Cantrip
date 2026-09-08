import { randomUUID } from "node:crypto";
import {
  chatMessageOpaqueContentSchema,
  type ChatTurnCreate,
  type ChatAttachmentOpaqueSummary,
  type ReasoningEffort,
} from "@cantrip/protocol";
import type { WorkerCommandBus } from "../../workers/bridge.js";

/** One worker-side protection contract for GUI inputs, including native-owned goals. */
export async function protectChatInput(
  bridge: Pick<WorkerCommandBus, "request">,
  workerId: string,
  input: Pick<ChatTurnCreate, "text" | "mode" | "idempotencyKey">,
  attachments: ChatAttachmentOpaqueSummary[],
  reasoningEffort: ReasoningEffort | null | undefined,
  role: "user" | "system" = "user",
) {
  return chatMessageOpaqueContentSchema.parse(
    await bridge.request(workerId, {
      type: "chat.message.protect",
      message: {
        id: randomUUID(),
        role,
        mode: input.mode ?? "default",
        reasoningEffort,
        content: [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...attachments.map((attachment) => ({
            type: "attachment" as const,
            attachment: {
              id: attachment.id,
              chatId: attachment.chatId,
              fileName: "Protected attachment",
              mimeType: "application/octet-stream",
              sizeBytes: attachment.sizeBytes,
              kind: "file" as const,
              source: "file" as const,
              status: attachment.status,
              previewText: null,
              createdAt: attachment.createdAt,
            },
          })),
        ],
        idempotencyKey: input.idempotencyKey,
      },
      attachments,
    }),
  );
}
