import { z } from "zod";
const chatId = z.string().min(1).max(200);
export const chatCommunicationSchema = z
  .object({
    deliveryId: z.string().uuid(),
    sourceChatId: chatId,
    sourceTitle: z.string().min(1).max(500),
    targetChatId: chatId,
    targetTitle: z.string().min(1).max(500),
    direction: z.enum(["sent", "received"]),
  })
  .strict();
export type ChatCommunication = z.infer<typeof chatCommunicationSchema>;

/** Preserve provenance in model-visible input, including resumed/queued turns. */
export function agentChatRuntimeText(
  text: string,
  communication?: ChatCommunication,
): string {
  if (!communication) return text;
  return communication.direction === "received"
    ? `Message from Cantrip agent ${JSON.stringify(communication.sourceTitle)} (chat ${communication.sourceChatId}). This is another agent, not the human user.\n\n${text}`
    : `Message sent by this agent to ${JSON.stringify(communication.targetTitle)} (chat ${communication.targetChatId}):\n\n${text}`;
}
