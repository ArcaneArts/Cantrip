import { deleteChat, interruptChat } from "@/lib/api";
import { CantripApiError } from "@/lib/api-client";

export type AgentChatRemoval = string | { chatId: string; stopRunning: true };

/** Interruption is acknowledged before the terminal turn event reaches the
 * server. Retry the actual removal while that event is still in flight. */
export async function removeAgentChat(chatId: string, running: boolean) {
  if (running) await interruptChat(chatId);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await deleteChat(chatId);
    } catch (error) {
      if (
        !running ||
        !(error instanceof CantripApiError) ||
        error.status !== 409 ||
        error.message !== "Stop the running chat first." ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
