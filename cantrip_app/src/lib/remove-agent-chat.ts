import { deleteChat, interruptChat } from "@/lib/api";
import { retryAfterChatInterruption } from "./retry-after-chat-interruption";

export type AgentChatRemoval = string | { chatId: string; stopRunning: true };

/** Legacy removal keeps its empty-resource deletion behavior. Sidebar archival
 * uses the explicit Agent archive endpoint through the same settling helper. */
export async function removeAgentChat(chatId: string, running: boolean) {
  return retryAfterChatInterruption(
    () => deleteChat(chatId),
    running ? () => interruptChat(chatId) : undefined,
  );
}
